import { randomUUID } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { settle, until } from './double.ts';
import { hostKit, installHeld, lastInput, outcome, type Hosted } from './environment.ts';
import { placeHostKey, temporaryHome } from './kit.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it('opens the provider session in the launch directory with the route settings and full access and reports its id', async () => {
  const hosted = await hostKit([{ model: 'gpt-route', effort: 'high' }]);

  hosted.input({ kind: 'open' });

  const ack = (await hosted.ack(lastInput())) as { provider_session_id: string };
  const log = await hosted.adapterLog();
  const opened = log.find((entry) => entry.method === 'session/new')!;
  expect(ack).toEqual({ provider_session_id: opened.sessionId });
  expect(opened.params).toMatchObject({ cwd: hosted.workingDirectory });
  expect(log.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)).toEqual([
    { sessionId: opened.sessionId, configId: 'mode', value: 'agent-full-access' },
    { sessionId: opened.sessionId, configId: 'model', value: 'gpt-route' },
    { sessionId: opened.sessionId, configId: 'reasoning_effort', value: 'high' },
  ]);
  expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
  expect(hosted.socket.frames).toContainEqual({ type: 'process', conversation_id: 'conversation-1', running: true });
});

it("opens the session in the mode the route names, and Codex runs `house` outside its sandbox by its own rule", async () => {
  const hosted = await hostKit([{ mode: 'read-only', effort: null }]);

  hosted.input({ kind: 'open' });

  await hosted.ack(lastInput());
  const settings = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/set_config_option');
  expect(settings.map((entry) => entry.params)).toEqual([
    expect.objectContaining({ configId: 'mode', value: 'read-only' }),
    expect.objectContaining({ configId: 'model', value: 'route-model' }),
  ]);
  expect(await readFile(join(hosted.home, '.codex', 'rules', 'house.rules'), 'utf8')).toBe(
    'prefix_rule(pattern = ["house"], decision = "allow")\n',
  );
});

it('opens a Claude Code session in bypass permissions with `house` allowed in every mode', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp', model: 'default', effort: null }]);

  hosted.input({ kind: 'open' });

  await hosted.ack(lastInput());
  const log = await hosted.adapterLog();
  expect(log.find((entry) => entry.method === 'initialize')!.env).toMatchObject({ IS_SANDBOX: '1' });
  expect(log.find((entry) => entry.method === 'session/new')!.params).toMatchObject({
    _meta: { claudeCode: { options: { allowedTools: ['Bash(house:*)'] } } },
  });
  expect(log.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)).toEqual([
    expect.objectContaining({ configId: 'mode', value: 'bypassPermissions' }),
    expect.objectContaining({ configId: 'model', value: 'default' }),
  ]);
});

it('starts Grok approving every tool, since it offers no mode', async () => {
  const hosted = await hostKit([{ kind: 'grok-build', model: 'grok-4.6', effort: null }]);

  hosted.input({ kind: 'open' });

  await hosted.ack(lastInput());
  const log = await hosted.adapterLog();
  expect(log.find((entry) => entry.method === 'initialize')!.argv).toEqual(
    expect.arrayContaining(['agent', '--always-approve', '--no-leader', 'stdio']),
  );
  expect(log.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)).toEqual([
    expect.objectContaining({ configId: 'model', value: 'grok-4.6' }),
  ]);
});

it("refuses the open with the CLI's cause when the CLI does not take the route's effort", async () => {
  const hosted = await hostKit([{ model: 'codex-instant', effort: 'high' }]);

  hosted.input({ kind: 'open' });

  expect(await hosted.ack(lastInput())).toEqual({ refused: expect.stringContaining('Unknown config option: thought_level') });
  expect(hosted.socket.frames.filter((frame) => frame.type === 'process')).toEqual([]);
});

it('opens a conversation of an Agent House added after the Kit read its Agents', async () => {
  const hosted = await hostKit();
  await until(() => hosted.house.requests.find((request) => request.path === '/kit/agents/report'));
  const added = {
    agent_id: 'agent-2',
    kind: 'codex-acp',
    base_instructions: 'Be useful.',
    working_directory: hosted.workingDirectory,
    model: 'route-model',
    effort: null,
  };
  hosted.house.route('POST', '/kit/agents/desired', () => ({ body: { agents: ['codex-acp'], routes: [added] } }));

  hosted.input({ kind: 'open', agent_id: 'agent-2' });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
});

it('opens a conversation of an Agent whose CLI House added once the Kit has installed that CLI', async () => {
  const hosted = await hostKit();
  const hold = await installHeld(hosted);

  hosted.input({ kind: 'open', agent_id: 'agent-2' });
  const open = lastInput();
  // Half a second lets the open reach the held install before the spec releases it.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(hold);

  expect(await hosted.ack(open)).toEqual({ provider_session_id: expect.any(String) });
  expect((await hosted.adapterLog()).find((entry) => entry.method === 'session/new')).toBeDefined();
});

it('opens a conversation with the CLI its route named after House moved that Agent to another CLI during installs', async () => {
  const hosted = await hostKit();
  const hold = await installHeld(hosted);
  const agentId = `agent-${randomUUID()}`;
  const directory = `/agents/house/agents/${agentId}`;
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const route = {
    agent_id: agentId,
    kind: 'grok-build',
    base_instructions: 'Be useful.',
    working_directory: directory,
    model: 'route-model',
    effort: null,
  };
  hosted.house.route('POST', '/kit/agents/desired', () => ({
    body: { agents: ['codex-acp', 'grok-build'], routes: [route] },
  }));
  hosted.socket.send({ type: 'work_available', subject: 'agents' });
  hosted.input({ kind: 'open', agent_id: agentId });
  const open = lastInput();
  await until(async () => (await stat(directory).catch(() => null))?.isDirectory());
  let moved = false;
  hosted.house.route('POST', '/kit/agents/desired', () => {
    moved = true;
    return { body: { agents: ['codex-acp'], routes: [{ ...route, kind: 'codex-acp' }] } };
  });
  hosted.socket.send({ type: 'work_available', subject: 'agents' });
  await until(() => moved);
  // A tenth of a second lets the Kit take House's moved route before the spec releases the install the open waits on.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(hold);

  expect(await hosted.ack(open)).toEqual({ provider_session_id: expect.any(String) });
});

it('opens a conversation with the launch settings House changed while the Kit was still reading them', async () => {
  const hosted = await hostKit();
  await until(() => hosted.house.requests.find((request) => request.path === '/kit/agents/report'));
  const changed = {
    agent_id: 'agent-1',
    kind: 'codex-acp',
    base_instructions: 'Be useful.',
    working_directory: hosted.workingDirectory,
    model: 'changed-model',
    effort: null,
  };
  hosted.house.route('POST', '/kit/agents/desired', async () => {
    // House answers the read half a second late, so the open arrives while the Kit is still reading.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { body: { agents: ['codex-acp'], routes: [changed] } };
  });

  hosted.socket.send({ type: 'work_available', subject: 'agents' });
  hosted.input({ kind: 'open' });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  const settings = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/set_config_option');
  expect(settings.map((entry) => entry.params)).toEqual([
    expect.objectContaining({ configId: 'mode', value: 'agent-full-access' }),
    expect.objectContaining({ configId: 'model', value: 'changed-model' }),
  ]);
});

async function reportHeld(hosted: Hosted): Promise<void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  let reporting = false;
  hosted.house.route('POST', '/kit/agents/report', async () => {
    reporting = true;
    await held;
    return { body: {} };
  });
  await placeHostKey(hosted.home);
  hosted.socket.send({ type: 'work_available', subject: 'agents' });
  await until(() => reporting);
}

it('writes a message to a running process while the Kit is still reporting its CLIs', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  await reportHeld(hosted);

  hosted.input({ kind: 'message', text: '@say reached', files: [], first: false });

  expect(await hosted.ack(lastInput())).toEqual({});
  const sent = await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt'));
  expect(sent.text).toBe('@say reached');
});

it('opens a conversation with the launch settings House changed while the Kit was still reporting its CLIs', async () => {
  const hosted = await hostKit();
  await reportHeld(hosted);
  const changed = {
    agent_id: 'agent-1',
    kind: 'codex-acp',
    base_instructions: 'Be useful.',
    working_directory: hosted.workingDirectory,
    model: 'changed-model',
    effort: null,
  };
  hosted.house.route('POST', '/kit/agents/desired', () => ({ body: { agents: ['codex-acp'], routes: [changed] } }));

  hosted.socket.send({ type: 'work_available', subject: 'agents' });
  hosted.input({ kind: 'open' });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  const settings = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/set_config_option');
  expect(settings.map((entry) => entry.params)).toEqual([
    expect.objectContaining({ configId: 'mode', value: 'agent-full-access' }),
    expect.objectContaining({ configId: 'model', value: 'changed-model' }),
  ]);
});

it('creates an absent default launch directory beneath /agents/house/agents before it opens the session there', async () => {
  const agentId = `agent-${randomUUID()}`;
  const directory = `/agents/house/agents/${agentId}`;
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const hosted = await hostKit([{ agent_id: agentId, working_directory: directory }]);

  hosted.input({ kind: 'open', agent_id: agentId });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  expect((await stat(directory)).isDirectory()).toBe(true);
  const opened = (await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!;
  expect(opened.params).toMatchObject({ cwd: directory });
});

it('creates an absent default launch directory beneath the native workspace root\'s agents folder and none directly in the root', async () => {
  const workspace = await temporaryHome();
  const [agentId, rootAgentId] = [`agent-${randomUUID()}`, `agent-${randomUUID()}`];
  const hosted = await hostKit(
    [
      { agent_id: agentId, working_directory: join(workspace, 'agents', agentId) },
      { agent_id: rootAgentId, working_directory: join(workspace, rootAgentId) },
    ],
    { environment: { HOUSE_KIT_WORKSPACE: workspace } },
  );

  hosted.input({ kind: 'open', agent_id: agentId });
  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  hosted.input({ kind: 'open', agent_id: rootAgentId, conversation_id: 'conversation-2' });
  expect(await hosted.ack(lastInput())).toEqual({ refused: expect.any(String) });

  expect((await stat(join(workspace, 'agents', agentId))).isDirectory()).toBe(true);
  await expect(stat(join(workspace, rootAgentId))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new').map((entry) => entry.params)).toEqual([
    expect.objectContaining({ cwd: join(workspace, 'agents', agentId) }),
  ]);
});

it('resumes the stored provider session for a message with no process and prompts it', async () => {
  const hosted = await hostKit();

  hosted.input({ kind: 'message', provider_session_id: 'session-stored', text: 'hello', files: [], first: false });

  expect(await hosted.ack(lastInput())).toEqual({});
  const log = await until(async () => {
    const entries = await hosted.adapterLog();
    return entries.some((entry) => entry.method === 'session/prompt') ? entries : undefined;
  });
  expect(log.find((entry) => entry.method === 'session/resume')!.params).toMatchObject({
    sessionId: 'session-stored',
    cwd: hosted.workingDirectory,
  });
  expect(log.find((entry) => entry.method === 'session/prompt')).toMatchObject({
    text: 'hello',
    params: { sessionId: 'session-stored' },
  });
});

it('reports a refused resume with the CLI cause', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'refuse-resume'), '');

  hosted.input({ kind: 'message', provider_session_id: 'session-stored', text: 'hello', files: [], first: false });

  expect(await hosted.ack(lastInput())).toEqual({ refused: expect.stringContaining('the session cannot be resumed') });
});

const KINDS = ['codex-acp', 'claude-agent-acp', 'grok-build'];

async function opened(kind = 'codex-acp'): Promise<Hosted> {
  const hosted = await hostKit([{ kind }]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  return hosted;
}

async function ends(hosted: Hosted, count: number): Promise<unknown[]> {
  const ended = await until(() => {
    const reported = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
    return reported.length === count ? reported : undefined;
  });
  return ended.map((turn) => outcome(turn.body));
}

async function prompts(hosted: Hosted): Promise<string[]> {
  return (await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt').map((entry) => String(entry.text));
}

function operations(hosted: Hosted, socket = hosted.house.sockets.at(-1)!): Record<string, unknown>[] {
  return socket.frames.filter((frame) => frame.type === 'turn');
}

function gated(hosted: Hosted, gate: string): () => Promise<void> {
  return () => writeFile(join(hosted.home, gate), '');
}

it.each(KINDS)("holds a message that reaches %s mid-turn until that turn ends, then sends it as the next turn's prompt", async (kind) => {
  const hosted = await opened(kind);
  const release = gated(hosted, 'first');

  hosted.input({ kind: 'message', text: '@gate first\n@say first', files: [], first: false });
  const first = lastInput();
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.input({ kind: 'message', text: '@say second', files: [], first: false });
  const second = lastInput();
  await hosted.ack(first);
  await settle();

  expect(await prompts(hosted)).toEqual(['@gate first\n@say first']);
  expect(hosted.acks.map((ack) => ack.params.input)).not.toContain(second);
  await release();
  expect(await ends(hosted, 2)).toEqual([{ text: 'first' }, { text: 'second' }]);
  expect(await prompts(hosted)).toEqual(['@gate first\n@say first', '@say second']);
  expect(await hosted.ack(second)).toEqual({});
  const [startedFirst, endedFirst, startedSecond] = hosted.turns.map((turn) => turn.path.split('/').at(-1));
  expect([startedFirst, endedFirst, startedSecond]).toEqual(['started', 'ended', 'started']);
});

it('sends two messages that arrived mid-turn as two turns in the order they arrived', async () => {
  const hosted = await opened();
  const release = gated(hosted, 'first');
  hosted.input({ kind: 'message', text: '@gate first\n@say first', files: [], first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));

  hosted.input({ kind: 'message', text: '@say second', files: [], first: false });
  hosted.input({ kind: 'message', text: '@say third', files: [], first: false });
  await settle();
  await release();

  expect(await ends(hosted, 3)).toEqual([{ text: 'first' }, { text: 'second' }, { text: 'third' }]);
  expect(await prompts(hosted)).toEqual(['@gate first\n@say first', '@say second', '@say third']);
  expect(new Set(hosted.turns.map((turn) => turn.params.turn)).size).toBe(3);
});

it('resumes the provider session for a message that waited while the process crashed and sends it as the next turn', async () => {
  const hosted = await opened();
  const session = ((await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!.sessionId) as string;
  const release = gated(hosted, 'crash');
  hosted.input({ kind: 'message', text: '@gate crash\n@exit 3', files: [], first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.input({ kind: 'message', text: '@say after', files: [], first: false });
  await settle();

  await release();

  expect(await ends(hosted, 2)).toEqual([{ failed: expect.stringContaining('exited with 3') }, { text: 'after' }]);
  const log = await hosted.adapterLog();
  expect(log.find((entry) => entry.method === 'session/resume')!.params).toMatchObject({ sessionId: session });
  expect(new Set(log.filter((entry) => entry.method === 'session/prompt').map((entry) => entry.pid)).size).toBe(2);
});

it("does not acknowledge a waiting message, so a restarted Kit receives it again at its socket's opening and sends it as the next turn", async () => {
  const hosted = await opened();
  const session = ((await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!.sessionId) as string;
  hosted.input({ kind: 'message', text: '@wait', files: [], first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.input({ kind: 'message', text: '@say again', files: [], first: false });
  const waiting = lastInput();
  await settle();
  expect(hosted.acks.map((ack) => ack.params.input)).not.toContain(waiting);

  await hosted.restart();
  hosted.house.sockets.at(-1)!.send({
    type: 'input',
    input_id: waiting,
    kind: 'message',
    conversation_id: 'conversation-1',
    agent_id: 'agent-1',
    provider_session_id: session,
    text: '@say again',
    files: [],
    first: false,
  });

  expect(await hosted.ack(waiting)).toEqual({});
  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(outcome(ended.body)).toEqual({ text: 'again' });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/resume').map((entry) => entry.params)).toEqual([
    expect.objectContaining({ sessionId: session }),
  ]);
});

it('reports a turn start and end once each under the turn id Kit gave it', async () => {
  const hosted = await opened();

  hosted.input({ kind: 'message', text: '@say Hello', files: [], first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  const started = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
  expect(started).toHaveLength(1);
  expect(started[0]!.params).toEqual({ conversation: 'conversation-1', turn: expect.stringMatching(UUID) });
  expect(ended.params.turn).toBe(started[0]!.params.turn);
  expect(ended.body).toEqual({ parts: [{ type: 'text', text: 'Hello' }], context: null });
});

it('ends a turn failed when its process exits during it, with the parts it had', async () => {
  const hosted = await opened();

  hosted.input({ kind: 'message', text: '@say partial\n@exit 3', files: [], first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(ended.body).toEqual({
    parts: [{ type: 'text', text: 'partial' }],
    context: null,
    failed: expect.stringContaining('exited with 3'),
  });
  await until(() => hosted.socket.frames.find((frame) => frame.type === 'process' && frame.running === false));
});

it.each(['codex-acp', 'claude-agent-acp'])(
  'ends the %s process when a prompt fails with no turn left running, so the next message resumes the session in a fresh one',
  async (kind) => {
    const hosted = await opened(kind);
    const session = ((await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!.sessionId) as string;

    hosted.input({ kind: 'message', text: '@fail The agent process exited unexpectedly', files: [], first: true });

    expect(await ends(hosted, 1)).toEqual([{ failed: expect.stringContaining('exited unexpectedly') }]);
    await until(() => hosted.socket.frames.find((frame) => frame.type === 'process' && frame.running === false));
    hosted.input({ kind: 'message', text: '@say back', files: [], first: false, provider_session_id: session });
    expect(await ends(hosted, 2)).toEqual([{ failed: expect.stringContaining('exited unexpectedly') }, { text: 'back' }]);
    const log = await hosted.adapterLog();
    expect(log.find((entry) => entry.method === 'session/resume')!.params).toMatchObject({ sessionId: session });
    expect(new Set(log.filter((entry) => entry.method === 'session/prompt').map((entry) => entry.pid)).size).toBe(2);
  },
);

it('sends a message that waited on a prompt the CLI failed to a fresh process that resumes the session', async () => {
  const hosted = await opened();
  const release = gated(hosted, 'failing');
  hosted.input({ kind: 'message', text: '@gate failing\n@fail provider request failed', files: [], first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.input({ kind: 'message', text: '@say next', files: [], first: false });
  await settle();

  await release();

  expect(await ends(hosted, 2)).toEqual([{ failed: expect.stringContaining('provider request failed') }, { text: 'next' }]);
  const log = await hosted.adapterLog();
  expect(new Set(log.filter((entry) => entry.method === 'session/prompt').map((entry) => entry.pid)).size).toBe(2);
});

it.each(KINDS)('ends a turn failed with the cause %s gives when it fails the prompt after it ends the turn', async (kind) => {
  const hosted = await opened(kind);

  // The prompt fails a tenth of a second after the CLI ends its turn, so the failure arrives after the end.
  hosted.input({ kind: 'message', text: '@say partial\n@ended\n@hold 100\n@fail provider request failed', files: [], first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(outcome(ended.body)).toEqual({ failed: expect.stringContaining('provider request failed') });
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/started')).map((turn) => turn.params.turn)).toEqual([
    ended.params.turn,
  ]);
});

it('ends a turn when Claude answers its prompt without an end notice, as it does for a local command', async () => {
  const hosted = await opened('claude-agent-acp');

  hosted.input({ kind: 'message', text: '@say local output\n@answer', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'local output' }]);
});

it.each(KINDS)('reports a turn the CLI starts by itself like any other and ends it when %s ends it', async (kind) => {
  const hosted = await opened(kind);

  // The CLI starts its own turn half a second after the prompted one ends, so the two stay apart.
  hosted.input({ kind: 'message', text: '@later 500 by itself', files: [], first: true });

  expect(await ends(hosted, 2)).toEqual([{ text: '' }, { text: 'by itself' }]);
  const starts = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
  const finished = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
  expect(starts.map((turn) => turn.params.turn)).toEqual(finished.map((turn) => turn.params.turn));
});

it.each(KINDS)('reports a turn %s starts by itself when it starts it, before it writes any text', async (kind) => {
  const hosted = await opened(kind);

  // The CLI starts its own turn half a second after the prompted one ends, so the two stay apart.
  hosted.input({ kind: 'message', text: '@later 500', files: [], first: true });

  expect(await ends(hosted, 2)).toEqual([{ text: '' }, { text: '' }]);
});

it('writes no part operation while nobody watches, and still reports the turn start, its question and its finished parts', async () => {
  const hosted = await opened();

  hosted.input({ kind: 'message', text: '@say Hello\n@tool Read the file\n@ask', files: [], first: true });
  const question = await until(() => hosted.interactions[0]);
  hosted.input({
    kind: 'answer',
    interaction_id: (question.body as { interaction_id: string }).interaction_id,
    response: { outcome: { outcome: 'selected', optionId: 'allow' } },
  });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect((ended.body as { parts: unknown[] }).parts).toEqual([
    { type: 'text', text: 'Hello' },
    { type: 'commands', count: 1 },
    { type: 'text', text: expect.stringContaining('selected') },
  ]);
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/started'))).toHaveLength(1);
  expect(operations(hosted)).toEqual([]);
});

it('writes the operations so far once when the owner becomes watched mid-turn, then each new one, and none once watching stops', async () => {
  const hosted = await opened();
  const release = gated(hosted, 'second');
  const stopAgain = gated(hosted, 'third');
  hosted.input({ kind: 'message', text: '@say one\n@tool Read it\n@gate second\n@say two\n@gate third\n@say three', files: [], first: true });
  const turn = (await until(() => hosted.turns.find((report) => report.path.endsWith('/started')))).params.turn;
  await settle();
  expect(operations(hosted)).toEqual([]);

  hosted.watch(true);
  await until(() => operations(hosted).length === 2);
  hosted.watch(true);
  await release();
  await until(() => operations(hosted).length === 3);
  hosted.watch(false);
  await stopAgain();

  expect(await ends(hosted, 1)).toEqual([{ text: 'onetwothree' }]);
  expect(operations(hosted)).toEqual([
    { type: 'turn', conversation_id: 'conversation-1', turn_id: turn, op: 'start', index: 0, part: { type: 'text', text: 'one' } },
    { type: 'turn', conversation_id: 'conversation-1', turn_id: turn, op: 'start', index: 1, part: { type: 'commands', count: 1 } },
    { type: 'turn', conversation_id: 'conversation-1', turn_id: turn, op: 'start', index: 2, part: { type: 'text', text: 'two' } },
  ]);
});

it("writes the running turn's operations so far once on a socket that reopens watched, and none on one that reopens unwatched", async () => {
  const hosted = await opened();
  hosted.watch(true);
  const release = gated(hosted, 'later');
  hosted.input({ kind: 'message', text: '@say one\n@gate later\n@say  two', files: [], first: true });
  const turn = (await until(() => operations(hosted)[0])).turn_id;

  hosted.house.sockets.at(-1)!.close(1001, 'shutting_down');
  const unwatched = await until(() => hosted.house.sockets[1]);
  await settle();
  expect(operations(hosted, unwatched)).toEqual([]);
  unwatched.close(1001, 'shutting_down');
  const watched = await until(() => hosted.house.sockets[2]);
  hosted.watch(true);
  await until(() => operations(hosted, watched)[0]);
  await release();

  expect(await ends(hosted, 1)).toEqual([{ text: 'one two' }]);
  expect(operations(hosted, watched)).toEqual([
    { type: 'turn', conversation_id: 'conversation-1', turn_id: turn, op: 'start', index: 0, part: { type: 'text', text: 'one' } },
    { type: 'turn', conversation_id: 'conversation-1', turn_id: turn, op: 'append', index: 0, text: ' two' },
  ]);
});

it('writes no operation of a turn before House answers its start report, then the operations so far', async () => {
  const hosted = await opened();
  hosted.watch(true);
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  onTestFinished(admit);
  hosted.house.route('POST', '/kit/conversations/:conversation/turns/:turn/started', async (request) => {
    await admitted;
    hosted.turns.push(request);
    return { body: {} };
  });

  const release = gated(hosted, 'rest');
  hosted.input({ kind: 'message', text: '@say one\n@plan read|fix\n@ping\n@gate rest\n@say  two', files: [], first: true });
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.pinged === true));
  await settle();
  expect(operations(hosted)).toEqual([]);
  admit();
  await until(() => operations(hosted).length === 2);
  await release();

  expect(await ends(hosted, 1)).toEqual([{ text: 'one two' }]);
  expect(operations(hosted).map(({ op, index, part, text }) => ({ op, index, part, text }))).toEqual([
    { op: 'start', index: 0, part: { type: 'text', text: 'one' }, text: undefined },
    {
      op: 'start',
      index: 1,
      part: {
        type: 'plan',
        entries: [
          { content: 'read', status: 'pending' },
          { content: 'fix', status: 'pending' },
        ],
      },
      text: undefined,
    },
    { op: 'start', index: 2, part: { type: 'text', text: ' two' }, text: undefined },
  ]);
});

it('calls restarted before it opens its socket', async () => {
  const hosted = await hostKit();

  const order = hosted.house.requests.map((request) => request.path);
  expect(order.indexOf('/kit/restarted')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('/kit/restarted')).toBeLessThan(order.indexOf('/kit/stream'));
});

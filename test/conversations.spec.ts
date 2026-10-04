import { randomUUID } from 'node:crypto';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { until } from './double.ts';
import { hostKit, installHeld, lastInput, type Hosted } from './environment.ts';
import { placeHostKey } from './kit.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function reports(hosted: Hosted, count: number): Promise<[string, string, unknown][]> {
  const received = await until(() => (hosted.turns.length === count ? hosted.turns : undefined));
  return received.map((report) => [report.path.slice(report.path.lastIndexOf('/') + 1), report.params.turn!, report.body]);
}

it('opens the provider session in the launch directory with the route settings and reports its id', async () => {
  const hosted = await hostKit([{ model: 'gpt-route', effort: 'high' }]);

  hosted.input({ kind: 'open' });

  const ack = (await hosted.ack(lastInput())) as { provider_session_id: string };
  const log = await hosted.adapterLog();
  const opened = log.find((entry) => entry.method === 'session/new')!;
  expect(ack).toEqual({ provider_session_id: opened.sessionId });
  expect(opened.params).toMatchObject({ cwd: hosted.workingDirectory });
  expect(log.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)).toEqual([
    { sessionId: opened.sessionId, configId: 'model', value: 'gpt-route' },
    { sessionId: opened.sessionId, configId: 'reasoning_effort', value: 'high' },
  ]);
  expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
  expect(hosted.socket.frames).toContainEqual({ type: 'process', conversation_id: 'conversation-1', running: true });
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
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(hold);

  expect(await hosted.ack(open)).toEqual({ provider_session_id: expect.any(String) });
  expect((await hosted.adapterLog()).find((entry) => entry.method === 'session/new')).toBeDefined();
});

it('opens a conversation with the CLI its route named after House moved that Agent to another CLI during installs', async () => {
  const hosted = await hostKit();
  const hold = await installHeld(hosted);
  const agentId = `agent-${randomUUID()}`;
  const directory = `/agents/house/${agentId}`;
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
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { body: { agents: ['codex-acp'], routes: [changed] } };
  });

  hosted.socket.send({ type: 'work_available', subject: 'agents' });
  hosted.input({ kind: 'open' });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  const settings = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/set_config_option');
  expect(settings.map((entry) => entry.params)).toEqual([expect.objectContaining({ configId: 'model', value: 'changed-model' })]);
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
  expect(settings.map((entry) => entry.params)).toEqual([expect.objectContaining({ configId: 'model', value: 'changed-model' })]);
});

it('creates an absent default launch directory before it opens the session there', async () => {
  const agentId = `agent-${randomUUID()}`;
  const directory = `/agents/house/${agentId}`;
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const hosted = await hostKit([{ agent_id: agentId, working_directory: directory }]);

  hosted.input({ kind: 'open', agent_id: agentId });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  expect((await stat(directory)).isDirectory()).toBe(true);
  const opened = (await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!;
  expect(opened.params).toMatchObject({ cwd: directory });
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

it('writes a message that arrives during a running turn to the CLI at once and ends the turn when the CLI ends it, its first prompt still unanswered', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@wait', files: [], first: true });
  await hosted.ack(lastInput());
  hosted.input({ kind: 'message', text: '@say meanwhile', files: [], first: false });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(ended.body).toEqual({ text: 'meanwhile' });
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/started')).map((turn) => turn.params.turn)).toEqual([
    ended.params.turn,
  ]);
});

it.each(['codex-acp', 'claude-agent-acp', 'grok-build'])(
  'writes each message to %s at once while House has not answered its turn start',
  async (kind) => {
    const hosted = await hostKit([{ kind }]);
    hosted.input({ kind: 'open' });
    await hosted.ack(lastInput());
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    onTestFinished(release);
    hosted.house.route('POST', '/kit/conversations/:conversation/turns/:turn/started', async () => {
      await held;
      return { body: {} };
    });

    hosted.input({ kind: 'message', text: '@hold 500\n@say first', files: [], first: false });
    hosted.input({ kind: 'message', text: '@say second', files: [], first: false });

    const prompts = await until(async () => {
      const sent = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt');
      return sent.length === 2 ? sent : undefined;
    });
    expect(prompts.map((entry) => entry.text)).toEqual(['@hold 500\n@say first', '@say second']);
  },
);

it.each(['codex-acp', 'claude-agent-acp'])(
  'reports a prompt %s fails after its turn ended as a failed turn of its own',
  async (kind) => {
    const hosted = await hostKit([{ kind }]);
    hosted.input({ kind: 'open' });
    await hosted.ack(lastInput());

    hosted.input({ kind: 'message', text: '@hold 1000\n@fail earlier prompt failed', files: [], first: true });
    await hosted.ack(lastInput());
    hosted.input({ kind: 'message', text: '@say meanwhile', files: [], first: false });

    const ends = await until(() => {
      const ended = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
      return ended.length === 2 ? ended : undefined;
    });
    expect(ends.map((turn) => turn.body)).toEqual([
      { text: 'meanwhile' },
      { failed: expect.stringContaining('earlier prompt failed') },
    ]);
    const starts = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
    expect(starts.map((turn) => turn.params.turn)).toEqual(ends.map((turn) => turn.params.turn));
    expect(new Set(starts.map((turn) => turn.params.turn)).size).toBe(2);
  },
);

it.each(['codex-acp', 'claude-agent-acp'])(
  'reports a prompt %s fails while a later turn runs as a failed turn of its own once that turn ends',
  async (kind) => {
    const hosted = await hostKit([{ kind }]);
    hosted.input({ kind: 'open' });
    await hosted.ack(lastInput());
    hosted.input({ kind: 'message', text: '@hold 1000\n@fail earlier prompt failed', files: [], first: true });
    await hosted.ack(lastInput());
    hosted.input({ kind: 'message', text: '@say meanwhile', files: [], first: false });
    await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));

    hosted.input({ kind: 'message', text: '@hold 2000\n@say current', files: [], first: false });

    const sequence = await reports(hosted, 6);
    const [first, second, third] = [0, 2, 4].map((index) => sequence[index]![1]);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(sequence).toEqual([
      ['started', first, {}],
      ['ended', first, { text: 'meanwhile' }],
      ['started', second, {}],
      ['ended', second, { text: 'current' }],
      ['started', third, {}],
      ['ended', third, { failed: expect.stringContaining('earlier prompt failed') }],
    ]);
  },
);

it('reports no turn for a prompt the CLI never answered when its process ends after that turn', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  const { provider_session_id } = (await hosted.ack(lastInput())) as { provider_session_id: string };
  hosted.input({ kind: 'message', text: '@wait', files: [], first: true });
  await hosted.ack(lastInput());
  hosted.input({ kind: 'message', text: '@say meanwhile', files: [], first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));

  hosted.input({ kind: 'kill' });
  await hosted.ack(lastInput());
  hosted.input({ kind: 'message', text: '@say after', files: [], first: false, provider_session_id });

  const ends = await until(() => {
    const ended = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
    return ended.length === 2 ? ended : undefined;
  });
  expect(ends.map((turn) => turn.body)).toEqual([{ text: 'meanwhile' }, { text: 'after' }]);
});

it('ends a turn when Grok ends it and reports the turn Grok then runs for a message it queued during it', async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@hold 1000\n@say first', files: [], first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.input({ kind: 'message', text: '@hold 1500\n@say second', files: [], first: false });

  const ends = await until(() => {
    const ended = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
    return ended.length === 2 ? ended : undefined;
  });
  expect(ends.map((turn) => turn.body)).toEqual([{ text: 'first' }, { text: 'second' }]);
  const starts = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
  expect(starts.map((turn) => turn.params.turn)).toEqual(ends.map((turn) => turn.params.turn));
  expect(new Set(starts.map((turn) => turn.params.turn)).size).toBe(2);
});

it('reports a turn start and end once each under the turn id Kit gave it', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@say Hello', files: [], first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  const started = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
  expect(started).toHaveLength(1);
  expect(started[0]!.params).toEqual({ conversation: 'conversation-1', turn: expect.stringMatching(UUID) });
  expect(ended.params.turn).toBe(started[0]!.params.turn);
  expect(ended.body).toEqual({ text: 'Hello' });
});

it('ends a turn failed when its process exits during it', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@say partial\n@exit 3', files: [], first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(ended.body).toEqual({ failed: expect.stringContaining('exited with 3') });
  await until(() =>
    hosted.socket.frames.find((frame) => frame.type === 'process' && frame.running === false),
  );
});

it.each(['codex-acp', 'claude-agent-acp', 'grok-build'])(
  'ends a turn failed with the cause %s gives when it fails the prompt after it ends the turn',
  async (kind) => {
    const hosted = await hostKit([{ kind }]);
    hosted.input({ kind: 'open' });
    await hosted.ack(lastInput());

    hosted.input({ kind: 'message', text: '@say partial\n@ended\n@hold 100\n@fail provider request failed', files: [], first: true });

    const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
    expect(ended.body).toEqual({ failed: expect.stringContaining('provider request failed') });
    expect(hosted.turns.filter((turn) => turn.path.endsWith('/started')).map((turn) => turn.params.turn)).toEqual([
      ended.params.turn,
    ]);
  },
);

it('ends a turn when Claude answers its prompt without an end notice, as it does for a local command', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@say local output\n@answer', files: [], first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(ended.body).toEqual({ text: 'local output' });
});

it('ends the turn Grok runs for a message it queued failed when Grok fails that message', async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@hold 500\n@say first', files: [], first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.input({ kind: 'message', text: '@hold 1000\n@started\n@fail queued message refused', files: [], first: false });

  const ends = await until(() => {
    const ended = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
    return ended.length === 2 ? ended : undefined;
  });
  expect(ends.map((turn) => turn.body)).toEqual([
    { text: 'first' },
    { failed: expect.stringContaining('queued message refused') },
  ]);
  const starts = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
  expect(starts.map((turn) => turn.params.turn)).toEqual(ends.map((turn) => turn.params.turn));
});

it('reports a message Grok fails before it runs it as a failed turn of its own once the running turn ends', async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@hold 1000\n@say first', files: [], first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.input({ kind: 'message', text: '@fail refused before it ran', files: [], first: false });

  const sequence = await reports(hosted, 4);
  const [first, second] = [0, 2].map((index) => sequence[index]![1]);
  expect(first).not.toBe(second);
  expect(sequence).toEqual([
    ['started', first, {}],
    ['ended', first, { text: 'first' }],
    ['started', second, {}],
    ['ended', second, { failed: expect.stringContaining('refused before it ran') }],
  ]);
});

it.each(['codex-acp', 'claude-agent-acp', 'grok-build'])(
  'reports a turn the CLI starts by itself like any other and ends it when %s ends it',
  async (kind) => {
    const hosted = await hostKit([{ kind }]);
    hosted.input({ kind: 'open' });
    await hosted.ack(lastInput());

    hosted.input({ kind: 'message', text: '@later 500 by itself', files: [], first: true });

    const ends = await until(() => {
      const ended = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
      return ended.length === 2 ? ended : undefined;
    });
    expect(ends.map((turn) => turn.body)).toEqual([{ text: '' }, { text: 'by itself' }]);
    const starts = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
    expect(starts.map((turn) => turn.params.turn)).toEqual(ends.map((turn) => turn.params.turn));
    const draft = await until(() =>
      hosted.socket.frames.find((frame) => frame.type === 'draft' && JSON.stringify(frame.blocks).includes('by itself')),
    );
    expect(draft).toMatchObject({ turn_id: ends[1]!.params.turn, blocks: [{ type: 'paragraph', text: 'by itself' }] });
  },
);

it.each(['codex-acp', 'claude-agent-acp', 'grok-build'])(
  'reports a turn %s starts by itself when it starts it, before it writes any text',
  async (kind) => {
    const hosted = await hostKit([{ kind }]);
    hosted.input({ kind: 'open' });
    await hosted.ack(lastInput());

    hosted.input({ kind: 'message', text: '@later 500', files: [], first: true });

    const ends = await until(() => {
      const ended = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
      return ended.length === 2 ? ended : undefined;
    });
    expect(ends.map((turn) => turn.body)).toEqual([{ text: '' }, { text: '' }]);
    const starts = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
    expect(starts.map((turn) => turn.params.turn)).toEqual(ends.map((turn) => turn.params.turn));
  },
);

function startHeld(hosted: Hosted): () => void {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  hosted.house.route('POST', '/kit/conversations/:conversation/turns/:turn/started', async (request) => {
    await held;
    hosted.turns.push(request);
    return { body: {} };
  });
  return release;
}

it('writes each message chunk as a draft frame with the next sequence and plan updates as plan frames', async () => {
  const hosted = await hostKit();
  const admit = startHeld(hosted);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@say Hello\n@say  world\n@say \\n\\n\n@say Next\n@plan first|second', files: [], first: true });

  const turn = (await until(() => hosted.socket.frames.find((frame) => frame.type === 'plan'))).turn_id;
  const drafts = hosted.socket.frames.filter((frame) => frame.type === 'draft');
  expect(drafts).toEqual([
    { type: 'draft', conversation_id: 'conversation-1', turn_id: turn, sequence: 1, from: 0, blocks: [{ type: 'paragraph', text: 'Hello' }] },
    { type: 'draft', conversation_id: 'conversation-1', turn_id: turn, sequence: 2, from: 0, blocks: [{ type: 'paragraph', text: 'Hello world' }] },
    { type: 'draft', conversation_id: 'conversation-1', turn_id: turn, sequence: 3, from: 1, blocks: [] },
    { type: 'draft', conversation_id: 'conversation-1', turn_id: turn, sequence: 4, from: 1, blocks: [{ type: 'paragraph', text: 'Next' }] },
  ]);
  expect(hosted.socket.frames.filter((frame) => frame.type === 'plan')).toEqual([
    {
      type: 'plan',
      conversation_id: 'conversation-1',
      turn_id: turn,
      sequence: 1,
      from: 0,
      steps: [
        { label: 'first', priority: 'medium', status: 'pending' },
        { label: 'second', priority: 'medium', status: 'pending' },
      ],
    },
  ]);
  admit();
  const ended = await until(() => hosted.turns.find((report) => report.path.endsWith('/ended')));
  expect(ended.params.turn).toBe(turn);
  expect(ended.body).toEqual({ text: 'Hello world\n\nNext' });
});

it("writes the turn's whole view as its next draft on a new socket", async () => {
  const hosted = await hostKit();
  startHeld(hosted);
  hosted.input({ kind: 'message', text: '@say first\\n\\nsecond\n@hold 4000\n@say  suffix', files: [], first: false });
  await until(() => hosted.socket.frames.find((frame) => frame.type === 'draft'));

  hosted.socket.close(1001, 'shutting_down');
  const reopened = await until(() => hosted.house.sockets[1]);

  expect(await until(() => reopened.frames.find((frame) => frame.type === 'draft'))).toMatchObject({
    sequence: 2,
    from: 0,
    blocks: [
      { type: 'paragraph', text: 'first' },
      { type: 'paragraph', text: 'second suffix' },
    ],
  });
});

it("writes each chunk and plan update at once, then the turn's whole view once House answers its start report", async () => {
  const hosted = await hostKit();
  const admit = startHeld(hosted);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@say one\n@say  two\n@plan first', files: [], first: true });

  const plan = await until(() => hosted.socket.frames.find((frame) => frame.type === 'plan'));
  expect(
    hosted.socket.frames.filter((frame) => frame.type === 'draft').map((frame) => [frame.sequence, frame.blocks]),
  ).toEqual([
    [1, [{ type: 'paragraph', text: 'one' }]],
    [2, [{ type: 'paragraph', text: 'one two' }]],
  ]);
  expect(plan).toMatchObject({ sequence: 1, steps: [{ label: 'first', priority: 'medium', status: 'pending' }] });
  admit();
  expect(
    await until(() => hosted.socket.frames.find((frame) => frame.type === 'draft' && frame.sequence === 3)),
  ).toMatchObject({ from: 0, blocks: [{ type: 'paragraph', text: 'one two' }] });
  expect(
    await until(() => hosted.socket.frames.find((frame) => frame.type === 'plan' && frame.sequence === 2)),
  ).toMatchObject({ from: 0, steps: [{ label: 'first', priority: 'medium', status: 'pending' }] });
  expect(await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')))).toMatchObject({
    body: { text: 'one two' },
  });
});

it("writes the turn's whole view and plan on the new socket once House answers its start report, though both came while the socket was closed", async () => {
  const hosted = await hostKit();
  const admit = startHeld(hosted);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  hosted.input({ kind: 'message', text: '@gate closed\n@say one\n@plan first\n@ping', files: [], first: true });
  await hosted.ack(lastInput());
  const reconnect = hosted.house.holdStreams();
  const closed = new Promise((resolve) => hosted.socket.socket.once('close', resolve));

  hosted.socket.close(1001, 'shutting_down');
  await closed;
  await writeFile(join(hosted.home, 'closed'), '');
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.pinged === true));
  reconnect();
  const reopened = await until(() => hosted.house.sockets[1]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  admit();

  expect(await until(() => reopened.frames.find((frame) => frame.type === 'draft'))).toMatchObject({
    sequence: 1,
    from: 0,
    blocks: [{ type: 'paragraph', text: 'one' }],
  });
  expect(await until(() => reopened.frames.find((frame) => frame.type === 'plan'))).toMatchObject({
    sequence: 1,
    from: 0,
    steps: [{ label: 'first', priority: 'medium', status: 'pending' }],
  });
});

it('calls restarted before it opens its socket', async () => {
  const hosted = await hostKit();

  const order = hosted.house.requests.map((request) => request.path);
  expect(order.indexOf('/kit/restarted')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('/kit/restarted')).toBeLessThan(order.indexOf('/kit/stream'));
});

const KINDS = ['codex-acp', 'claude-agent-acp', 'grok-build'];

async function opened(kind: string): Promise<Hosted> {
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
  return ended.map((turn) => turn.body);
}

function notes(hosted: Hosted): Record<string, unknown>[] {
  return hosted.socket.frames.filter((frame) => frame.type === 'working-note');
}

function drafts(hosted: Hosted): Record<string, unknown>[] {
  return hosted.socket.frames.filter((frame) => frame.type === 'draft');
}

function note(text: string): Record<string, unknown> {
  return { type: 'working-note', conversation_id: 'conversation-1', note_id: expect.stringMatching(UUID), text };
}

it.each(KINDS)('sends each working note %s writes between actions as one complete frame and keeps it out of the answer', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({
    kind: 'message',
    text: '@note Let me check the config first\n@tool Read the config\n@note Now the tests\n@tool Run the tests\n@say The config\n@say  is fine.',
    files: [],
    first: true,
  });

  expect(await ends(hosted, 1)).toEqual([{ text: 'The config is fine.' }]);
  expect(notes(hosted)).toEqual([note('Let me check the config first'), note('Now the tests')]);
  expect(new Set(notes(hosted).map((frame) => frame.note_id)).size).toBe(2);
  const answer = await until(() =>
    drafts(hosted).find((frame) => JSON.stringify(frame.blocks).includes('The config is fine.')),
  );
  expect(answer).toMatchObject({ from: 0, blocks: [{ type: 'paragraph', text: 'The config is fine.' }] });
  for (const draft of drafts(hosted)) {
    expect(draft.blocks).toEqual([{ type: 'paragraph', text: expect.stringMatching(/^The config/) }]);
  }
});

it('grows the draft from the answer chunks alone while Codex writes notes between them', async () => {
  const hosted = await opened('codex-acp');

  hosted.input({ kind: 'message', text: '@note Reading it\n@tool Read the file\n@say one\n@say  two', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'one two' }]);
  expect(drafts(hosted).map((frame) => frame.blocks)).toEqual([
    [{ type: 'paragraph', text: 'one' }],
    [{ type: 'paragraph', text: 'one two' }],
  ]);
  expect(notes(hosted)).toEqual([note('Reading it')]);
});

it.each(KINDS)('ends a turn %s writes only notes in with an empty answer', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({ kind: 'message', text: '@note Reading the logs\n@tool Read the logs', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: '' }]);
  expect(notes(hosted)).toEqual([note('Reading the logs')]);
  expect(drafts(hosted)).toEqual([]);
});

it.each(KINDS)('separates the notes and answer of a turn %s starts by itself like those of a prompted turn', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({
    kind: 'message',
    text: '@itself 500 @note Checking the job;@tool Read the job output;@say The job finished',
    files: [],
    first: true,
  });

  expect(await ends(hosted, 2)).toEqual([{ text: '' }, { text: 'The job finished' }]);
  expect(notes(hosted)).toEqual([note('Checking the job')]);
  expect(JSON.stringify(drafts(hosted))).not.toContain('Checking');
});

it.each(KINDS)('never sends the private thought %s writes before an action as a working note', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({ kind: 'message', text: '@think I should read the config\n@tool Read the config\n@say Done', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'Done' }]);
  expect(notes(hosted)).toEqual([]);
  expect(JSON.stringify(drafts(hosted))).not.toContain('I should');
});

it("sends each message Codex marks as commentary as a note of its own, with no action after it", async () => {
  const hosted = await opened('codex-acp');

  hosted.input({ kind: 'message', text: '@note First look\n@note Second look\n@say Done', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'Done' }]);
  expect(notes(hosted)).toEqual([note('First look'), note('Second look')]);
});

it.each(['claude-agent-acp', 'grok-build'])('sends the text %s writes before a plan update as a working note', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({ kind: 'message', text: '@note Let me plan this\n@plan read|fix\n@say Done', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'Done' }]);
  expect(notes(hosted)).toEqual([note('Let me plan this')]);
});

it.each([
  ['@say Done', 'Done'],
  ['@think All set', ''],
])('sends the text Claude writes before a tool its adapter shows no update for as a working note, once %s opens its next message', async (next, answer) => {
  const hosted = await opened('claude-agent-acp');

  hosted.input({ kind: 'message', text: `@note Let me inspect the task\n@hidden\n${next}`, files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: answer }]);
  expect(notes(hosted)).toEqual([note('Let me inspect the task')]);
  expect(JSON.stringify(drafts(hosted))).not.toContain('inspect');
});

it.each(['claude-agent-acp', 'grok-build'])('keeps the text %s writes with no action after it as the answer', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({ kind: 'message', text: '@note Looking around\n@say  and done', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'Looking around and done' }]);
  expect(notes(hosted)).toEqual([]);
});

it('sends a note finished before House answered the turn start once House answers it', async () => {
  const hosted = await opened('codex-acp');
  const admit = startHeld(hosted);

  hosted.input({ kind: 'message', text: '@note Reading it\n@tool Read the file\n@ping\n@say Done', files: [], first: true });
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.pinged === true));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(notes(hosted)).toEqual([]);
  admit();

  expect(await until(() => notes(hosted)[0])).toEqual(note('Reading it'));
  expect(await ends(hosted, 1)).toEqual([{ text: 'Done' }]);
});

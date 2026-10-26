import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentInstructions } from '@agentshouse/skills';
import { expect, it, onTestFinished, vi } from 'vitest';
import { socketDirectory } from '../src/home.ts';
import { attached, bridgeSockets, inspected } from './attachments.ts';
import { settle, until } from './double.ts';
import { conversationCredential, hostKit, installHeld, lastCall, outcome, userBin, type Hosted } from './environment.ts';
import { alive, placeHostKey, temporaryHome } from './kit.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it.each(['codex-acp', 'claude-agent-acp', 'grok-build'])("leaves %s on its own default model and effort when the Profile names neither", async (kind) => {
  const hosted = await hostKit([{ kind, model: null, effort: null }]);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  const log = await hosted.adapterLog();
  expect(log.some((entry) => entry.method === 'session/new')).toBe(true);
  expect(log.filter((entry) => entry.method === 'session/set_config_option').map((entry) => (entry.params as { configId: string }).configId)).toEqual(
    kind === 'grok-build' ? [] : ['mode'],
  );
});

it('opens the provider session in the launch directory with the route settings and full access and reports its id', async () => {
  const hosted = await hostKit([{ model: 'gpt-route', effort: 'high' }]);

  hosted.call({ kind: 'open' });

  const result = (await hosted.result(lastCall())) as { provider_session_id: string };
  const log = await hosted.adapterLog();
  const opened = log.find((entry) => entry.method === 'session/new')!;
  expect(result).toEqual({ provider_session_id: opened.sessionId });
  expect(opened.params).toMatchObject({ cwd: hosted.workingDirectory });
  expect(log.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)).toEqual([
    { sessionId: opened.sessionId, configId: 'mode', value: 'agent-full-access' },
    { sessionId: opened.sessionId, configId: 'model', value: 'gpt-route' },
    { sessionId: opened.sessionId, configId: 'reasoning_effort', value: 'high' },
  ]);
  expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
  expect(hosted.connection.notifications).toContainEqual({ type: 'process', conversation_id: 'conversation-1', running: true });
});

it("opens the session in the mode the route names, and Codex runs each `house` on the conversation's PATH outside its sandbox whenever its shell starts it", async () => {
  const hosted = await hostKit([{ mode: 'read-only', effort: null }], {
    prepare: async (home) => {
      await writeFile(join(userBin(home), 'house'), '#!/bin/sh\n', { mode: 0o755 });
      await writeFile(join(home, '.profile'), `PATH="${userBin(home)}:/usr/bin:/bin"\n`);
    },
  });

  hosted.call({ kind: 'open' });

  await hosted.result(lastCall());
  const log = await hosted.adapterLog();
  expect(log.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)).toEqual([
    expect.objectContaining({ configId: 'mode', value: 'read-only' }),
    expect.objectContaining({ configId: 'model', value: 'route-model' }),
  ]);
  expect(log.find((entry) => entry.method === 'initialize')!.env).toMatchObject({
    CODEX_CONFIG: '{"features":{"shell_zsh_fork":true}}',
  });
  expect(await readFile(join(hosted.home, '.codex', 'rules', 'house.rules'), 'utf8')).toBe(
    `prefix_rule(pattern = ["house"], decision = "allow")\nhost_executable(name = "house", paths = ["${join(userBin(hosted.home), 'house')}"])\n`,
  );
});

it('opens a Claude Code session in bypass permissions with `house` allowed in every mode and its sandbox open to unix sockets', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp', model: 'default', effort: null }]);

  hosted.call({ kind: 'open' });

  await hosted.result(lastCall());
  const log = await hosted.adapterLog();
  expect(log.find((entry) => entry.method === 'initialize')!.env).toMatchObject({ IS_SANDBOX: '1' });
  expect(log.find((entry) => entry.method === 'session/new')!.params).toMatchObject({
    _meta: {
      claudeCode: {
        options: {
          allowedTools: ['Bash(house:*)'],
          settings: { sandbox: { network: { allowAllUnixSockets: true } } },
        },
      },
    },
  });
  expect(log.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)).toEqual([
    expect.objectContaining({ configId: 'mode', value: 'bypassPermissions' }),
    expect.objectContaining({ configId: 'model', value: 'default' }),
  ]);
});

it('starts Grok approving every tool, since it offers no mode', async () => {
  const hosted = await hostKit([{ kind: 'grok-build', model: 'grok-4.6', effort: null }]);

  hosted.call({ kind: 'open' });

  await hosted.result(lastCall());
  const log = await hosted.adapterLog();
  expect(log.find((entry) => entry.method === 'initialize')!.argv).toEqual(
    expect.arrayContaining(['--sandbox', 'off', 'agent', '--always-approve', '--no-leader', 'stdio']),
  );
  expect(log.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)).toEqual([
    expect.objectContaining({ configId: 'model', value: 'grok-4.6' }),
  ]);
});

it("refuses the open in the Kit's words when the CLI does not take the route's effort, and logs the CLI's cause", async () => {
  const hosted = await hostKit([{ model: 'codex-instant', effort: 'high' }]);

  hosted.call({ kind: 'open' });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI refused the Agent's model, mode or effort" });
  expect(hosted.connection.notifications.filter((notification) => notification.type === 'process')).toEqual([]);
  expect(hosted.kit.stderr()).toContain('Unknown config option: thought_level');
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

  hosted.call({ kind: 'open', agent_id: 'agent-2' });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
});

it('opens a conversation of an Agent whose CLI House added once the Kit has installed that CLI', async () => {
  const hosted = await hostKit();
  const hold = await installHeld(hosted);

  hosted.call({ kind: 'open', agent_id: 'agent-2' });
  const open = lastCall();
  // Half a second lets the open reach the held install before the spec releases it.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(hold);

  expect(await hosted.result(open)).toEqual({ provider_session_id: expect.any(String) });
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
  hosted.connection.send({ type: 'work_available', subject: 'agents' });
  hosted.call({ kind: 'open', agent_id: agentId });
  const open = lastCall();
  await until(async () => (await stat(directory).catch(() => null))?.isDirectory());
  let moved = false;
  hosted.house.route('POST', '/kit/agents/desired', () => {
    moved = true;
    return { body: { agents: ['codex-acp'], routes: [{ ...route, kind: 'codex-acp' }] } };
  });
  hosted.connection.send({ type: 'work_available', subject: 'agents' });
  await until(() => moved);
  // A tenth of a second lets the Kit take House's moved route before the spec releases the install the open waits on.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(hold);

  expect(await hosted.result(open)).toEqual({ provider_session_id: expect.any(String) });
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

  hosted.connection.send({ type: 'work_available', subject: 'agents' });
  hosted.call({ kind: 'open' });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
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
  hosted.connection.send({ type: 'work_available', subject: 'agents' });
  await until(() => reporting);
}

it('writes a message to a running process while the Kit is still reporting its CLIs', async () => {
  const hosted = await hostKit();
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  await reportHeld(hosted);

  hosted.call({ kind: 'message', text: '@say reached', first: false });

  expect(await hosted.result(lastCall())).toEqual({});
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

  hosted.connection.send({ type: 'work_available', subject: 'agents' });
  hosted.call({ kind: 'open' });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
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

  hosted.call({ kind: 'open', agent_id: agentId });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
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

  hosted.call({ kind: 'open', agent_id: agentId });
  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
  hosted.call({ kind: 'open', agent_id: rootAgentId, conversation_id: 'conversation-2' });
  expect(await hosted.result(lastCall())).toEqual({ refused: expect.any(String) });

  expect((await stat(join(workspace, 'agents', agentId))).isDirectory()).toBe(true);
  await expect(stat(join(workspace, rootAgentId))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new').map((entry) => entry.params)).toEqual([
    expect.objectContaining({ cwd: join(workspace, 'agents', agentId) }),
  ]);
});

it('resumes the stored provider session for a message with no process and prompts it', async () => {
  const hosted = await hostKit();

  hosted.call({ kind: 'message', provider_session_id: 'session-stored', text: 'hello', first: false });

  expect(await hosted.result(lastCall())).toEqual({});
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

it("reports a refused resume in the Kit's words, never the CLI's, marked as a refused resume, and logs the CLI's cause", async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'refuse-resume'), '');

  hosted.call({ kind: 'message', provider_session_id: 'session-stored', text: 'hello', first: false });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI could not resume this conversation", resume_refused: true });
  expect(hosted.kit.stderr()).toMatch(/^kit: conversation .+ did not start: the Agent's CLI could not resume this conversation: .*the session cannot be resumed/m);
});

it('refuses a message whose CLI does not start before resuming its session with that reason and no mark of a refused resume', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'refuse-initialize'), '');

  hosted.call({ kind: 'message', provider_session_id: 'session-stored', text: 'hello', first: false });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI did not start" });
  expect((await hosted.adapterLog()).some((entry) => entry.method === 'session/resume')).toBe(false);
});

it.each([
  ['opening', null],
  ['resuming', 'session-stored'],
])("refuses a message whose CLI is not signed in when %s its session, saying so in the Kit's words", async (_step, stored) => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'signed-out'), '');

  hosted.call({ kind: 'message', provider_session_id: stored, text: 'hello', first: stored === null });

  expect(await hosted.result(lastCall())).toEqual({
    refused: "the Agent's CLI is not signed in; sign it in on the Agent's machine",
  });
});

it('reports the start-up step of a message whose session takes over a second to open, and its end before the turn starts', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'hold-new'), '');
  const starting = () => hosted.connection.notifications.filter((notification) => notification.type === 'starting');

  hosted.call({ kind: 'message', text: '@say Hello', first: true });

  await until(() => starting().length > 0);
  expect(starting()).toEqual([{ type: 'starting', conversation_id: 'conversation-1', step: 'session' }]);
  await rm(join(hosted.home, 'hold-new'));
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(starting()).toEqual([
    { type: 'starting', conversation_id: 'conversation-1', step: 'session' },
    { type: 'starting', conversation_id: 'conversation-1', step: null },
  ]);
});

it('writes a start-up step that changed while its Kit connection was closed once the connection reopens', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'hold-new'), '');
  const starting = (connection = hosted.house.connections.at(-1)!) =>
    connection.notifications.filter((notification) => notification.type === 'starting').map((notification) => notification.step);
  hosted.call({ kind: 'open' });
  await until(() => starting().length > 0);

  hosted.house.connections.at(-1)!.close(1001, 'shutting_down');
  await settle();
  await rm(join(hosted.home, 'hold-new'));
  await hosted.result(lastCall());
  const reopened = await until(() => hosted.house.connections[1]);

  await until(() => starting(reopened).length > 0);
  expect(starting(hosted.house.connections[0])).toEqual(['session']);
  expect(starting(reopened)).toEqual([null]);
});

it('writes the start-up step it is still in on a Kit connection that reopens', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'hold-new'), '');
  const starting = (connection = hosted.house.connections.at(-1)!) =>
    connection.notifications.filter((notification) => notification.type === 'starting').map((notification) => notification.step);
  hosted.call({ kind: 'open' });
  await until(() => starting().length > 0);

  hosted.house.connections.at(-1)!.close(1001, 'shutting_down');
  const reopened = await until(() => hosted.house.connections[1]);

  await until(() => starting(reopened).length > 0);
  expect(starting(hosted.house.connections[0])).toEqual(['session']);
  expect(starting(reopened)).toEqual(['session']);
  await rm(join(hosted.home, 'hold-new'));
  await hosted.result(lastCall());
  await until(() => starting(reopened).length > 1);
  expect(starting(reopened)).toEqual(['session', null]);
});

it("prepares a new conversation's first message, reading what it links and House's instructions through the one House connection its CLI opens the session with", async () => {
  const hosted = await hostKit();
  const [photo] = attached(hosted, [{ name: 'photo.jpg', media_type: 'image/jpeg', content: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) }]);
  await writeFile(join(hosted.home, 'hold-new'), '');
  const text = `@say hello ${photo!.link}`;

  hosted.call({ kind: 'open' });
  hosted.call({ kind: 'message', text, first: true });

  await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/new'));
  await until(() => inspected(hosted).length > 0);
  await until(() => hosted.mcp.find((received) => (received.body as { params?: { name?: string } }).params?.name === 'shell'));
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt')).toEqual([]);
  await rm(join(hosted.home, 'hold-new'));
  const prompted = await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt'));
  expect((prompted.params as { prompt: { text: string }[] }).prompt.map((block) => block.text)).toEqual([
    [...agentInstructions('refs/house/received', []), '', 'Be useful.'].join('\n'),
    text,
  ]);
  expect(hosted.house.requests.filter((received) => received.path === '/kit/conversations/conversation-1/credential')).toHaveLength(1);
});

it("prompts a first message with House's instructions through the CLI it starts itself when its open's start failed while it read them", async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'refuse-new'), '');
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  let reads = 0;
  hosted.house.route('POST', '/', async (request) => {
    const message = request.body as { id: number };
    if (reads++ === 0) await released;
    return { body: { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '' }] } } };
  });
  let credentials = 0;
  hosted.house.route('POST', '/kit/conversations/:conversation/credential', async (request) => {
    if (credentials++ === 1) await released;
    return { body: { credential: conversationCredential(request.params.conversation!) } };
  });

  hosted.call({ kind: 'open' });
  const open = lastCall();
  hosted.call({ kind: 'message', text: '@say hello', first: true });
  const message = lastCall();

  expect(await hosted.result(open)).toEqual({ refused: "the Agent's CLI did not open a session" });
  await rm(join(hosted.home, 'refuse-new'));
  release();
  expect(await hosted.result(message)).toHaveProperty('provider_session_id');
  const prompted = await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt'));
  expect((prompted.params as { prompt: { text: string }[] }).prompt.map((block) => block.text)).toEqual([
    [...agentInstructions('refs/house/received', []), '', 'Be useful.'].join('\n'),
    '@say hello',
  ]);
});

it("writes a running process's facts, its latest commands and options included, again on a Kit connection that reopens", async () => {
  const hosted = await hostKit();
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.call({ kind: 'message', text: '@commands\n@config', first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  const facts = (connection: (typeof hosted.house.connections)[number]) =>
    connection.notifications.filter((notification) => ['process', 'commands', 'options'].includes(String(notification.type)));
  const before = facts(hosted.house.connections[0]!);

  hosted.house.connections.at(-1)!.close(1001, 'shutting_down');
  const reopened = await until(() => hosted.house.connections[1]);

  await until(() => facts(reopened).length === 3);
  expect(facts(reopened)).toEqual([
    { type: 'process', conversation_id: 'conversation-1', running: true },
    before.findLast((notification) => notification.type === 'commands'),
    before.findLast((notification) => notification.type === 'options'),
  ]);
  expect(
    (facts(reopened)[2]!.options as { id: string; currentValue: string }[]).find((option) => option.id === 'reasoning_effort')!
      .currentValue,
  ).toBe('from-cli');
});

it('writes the exit of a process a closed Kit connection did not take once the connection reopens', async () => {
  const hosted = await hostKit();
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.call({ kind: 'message', text: '@gate exit-now\n@exit 1', first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  const processes = (connection: (typeof hosted.house.connections)[number]) =>
    connection.notifications.filter((notification) => notification.type === 'process');

  hosted.house.connections.at(-1)!.close(1001, 'shutting_down');
  await settle();
  await writeFile(join(hosted.home, 'exit-now'), '');
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  const reopened = await until(() => hosted.house.connections[1]);

  await until(() => processes(reopened).length > 0);
  expect(processes(hosted.house.connections[0]!)).toEqual([{ type: 'process', conversation_id: 'conversation-1', running: true }]);
  expect(processes(reopened)).toEqual([{ type: 'process', conversation_id: 'conversation-1', running: false }]);
});

it('keeps the start-up step of the message being started while a later one arrives', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'hold-new'), '');
  const starting = () => hosted.connection.notifications.filter((notification) => notification.type === 'starting').map((notification) => notification.step);
  hosted.call({ kind: 'message', text: '@say first', first: true });
  await until(() => starting().length > 0);

  hosted.call({ kind: 'message', text: '@say second', first: true });
  await settle();
  expect(starting()).toEqual(['session']);

  await rm(join(hosted.home, 'hold-new'));
  await until(() => hosted.turns.filter((turn) => turn.path.endsWith('/ended')).length === 2);
  expect(starting()).toEqual(['session', null]);
});

it('returns the result of a message it prompted before a restart lost its result once House sends it again, and prompts it no second time', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/kit/inputs/:input/ack', () => ({ drop: true }));
  hosted.call({ kind: 'message', text: '@say once', first: true });
  const sent = lastCall();
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  await hosted.restart();
  hosted.house.route('POST', '/kit/inputs/:input/ack', (request) => {
    hosted.results.push(request);
    return { body: {} };
  });

  hosted.call({ kind: 'message', input_id: sent, text: '@say once', first: true });

  expect(await hosted.result(sent)).toEqual({ provider_session_id: expect.any(String) });
  await settle();
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt')).toHaveLength(1);
});

it('prompts no second time a message whose CLI asked a question about it before a restart lost its result', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/kit/inputs/:input/ack', () => ({ drop: true }));
  hosted.call({ kind: 'message', text: '@ask', first: true });
  const sent = lastCall();
  await until(() => hosted.interactions[0]);
  await hosted.restart();
  hosted.house.route('POST', '/kit/inputs/:input/ack', (request) => {
    hosted.results.push(request);
    return { body: {} };
  });

  hosted.call({ kind: 'message', input_id: sent, text: '@ask', first: true });

  expect(await hosted.result(sent)).toEqual({ provider_session_id: expect.any(String) });
  await settle();
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt')).toHaveLength(1);
});

it('prompts again a message House sends again after a restart when its CLI showed nothing of it before the restart', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/kit/inputs/:input/ack', () => ({ drop: true }));
  hosted.call({ kind: 'message', text: '@gate never-opened', first: true });
  const sent = lastCall();
  await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt'));
  await hosted.restart();
  hosted.house.route('POST', '/kit/inputs/:input/ack', (request) => {
    hosted.results.push(request);
    return { body: {} };
  });

  hosted.call({ kind: 'message', input_id: sent, text: '@say again', first: true });

  expect(await hosted.result(sent)).toEqual({ provider_session_id: expect.any(String) });
  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(outcome(ended.body)).toEqual({ text: 'again' });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt')).toHaveLength(2);
});

it.each(['a Kit restart', 'a kill'])(
  'starts the first message of a Claude Code conversation in a new session it names when the CLI wrote nothing of the opened one before %s',
  async (ending) => {
    const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
    hosted.call({ kind: 'open' });
    const { provider_session_id: stored } = (await hosted.result(lastCall())) as { provider_session_id: string };
    if (ending === 'a kill') {
      hosted.call({ kind: 'kill' });
      await hosted.result(lastCall());
    } else {
      await hosted.restart();
    }

    hosted.call({ kind: 'message', provider_session_id: stored, text: '@say started', first: true });

    const { provider_session_id: opened } = (await hosted.result(lastCall())) as { provider_session_id: string };
    expect(opened).not.toBe(stored);
    const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
    expect(outcome(ended.body)).toEqual({ text: 'started' });
    expect((await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt')!.params).toMatchObject({ sessionId: opened });
    expect(hosted.kit.stderr()).toMatch(/^kit: conversation .+ opens a new session: the Agent's CLI could not resume this conversation: Resource not found/m);
  },
);

it.each(['codex-acp', 'grok-build'])('resumes the session %s wrote when the conversation opened for its first message after a Kit restart', async (kind) => {
  const hosted = await hostKit([{ kind }]);
  hosted.call({ kind: 'open' });
  const { provider_session_id: stored } = (await hosted.result(lastCall())) as { provider_session_id: string };
  await hosted.restart();

  hosted.call({ kind: 'message', provider_session_id: stored, text: '@say resumed', first: true });

  expect(await hosted.result(lastCall())).toEqual({});
  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(outcome(ended.body)).toEqual({ text: 'resumed' });
  const log = await hosted.adapterLog();
  expect(log.filter((entry) => entry.method === 'session/new')).toHaveLength(1);
  expect(log.find((entry) => entry.method === 'session/prompt')!.params).toMatchObject({ sessionId: stored });
});

it('names the new session in the result of every first message House sent before it learned of it', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.call({ kind: 'open' });
  const { provider_session_id: stored } = (await hosted.result(lastCall())) as { provider_session_id: string };
  await hosted.restart();

  hosted.call({ kind: 'message', provider_session_id: stored, text: '@say one', first: true });
  const one = lastCall();
  hosted.call({ kind: 'message', provider_session_id: stored, text: '@say two', first: true });

  const opened = ((await hosted.result(one)) as { provider_session_id: string }).provider_session_id;
  expect(opened).not.toBe(stored);
  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: opened });
});

it('refuses a first message whose session this Kit already prompted when the CLI cannot resume it, and opens no other session', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.call({ kind: 'open' });
  const { provider_session_id: stored } = (await hosted.result(lastCall())) as { provider_session_id: string };
  hosted.call({ kind: 'message', provider_session_id: stored, text: '@say one', first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  hosted.call({ kind: 'kill' });
  await hosted.result(lastCall());
  await writeFile(join(hosted.home, 'refuse-resume'), '');

  hosted.call({ kind: 'message', provider_session_id: stored, text: '@say two', first: true });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI could not resume this conversation", resume_refused: true });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new')).toHaveLength(1);
});

it('refuses a first message whose resume the CLI refuses for another reason than not holding the session, and opens no other session', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp' }]);
  hosted.call({ kind: 'open' });
  const { provider_session_id: stored } = (await hosted.result(lastCall())) as { provider_session_id: string };
  await hosted.restart();
  await writeFile(join(hosted.home, 'refuse-resume'), '');

  hosted.call({ kind: 'message', provider_session_id: stored, text: '@say lost', first: true });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI could not resume this conversation", resume_refused: true });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new')).toHaveLength(1);
});

it('refuses a later message of a Claude Code conversation whose session the CLI cannot resume, and opens no other session', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.call({ kind: 'open' });
  const { provider_session_id: stored } = (await hosted.result(lastCall())) as { provider_session_id: string };
  await hosted.restart();

  hosted.call({ kind: 'message', provider_session_id: stored, text: '@say lost', first: false });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI could not resume this conversation", resume_refused: true });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new')).toHaveLength(1);
});

it("refuses a conversation whose CLI does not install in the Kit's words, never the installer's, and logs the installer's cause", async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], {
    prepare: async (home) => {
      await rm(join(userBin(home), 'claude'));
      await writeFile(join(home, 'install-fail'), 'claude-agent-acp\n');
      await writeFile(join(home, 'install-output'), 'Claude installer private diagnostic\n');
    },
  });

  hosted.call({ kind: 'open' });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI is not ready on this computer" });
  expect(hosted.kit.stderr()).toContain('claude-agent-acp did not install: Claude installer private diagnostic\nChecksum verification failed');
});

it('closes the connection a message opened to read its links when its CLI does not install', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], {
    prepare: async (home) => {
      await rm(join(userBin(home), 'claude'));
      await writeFile(join(home, 'install-fail'), 'claude-agent-acp\n');
    },
  });
  attached(hosted, [], ['/rooms/notes/plan.md']);

  hosted.call({ kind: 'message', text: 'read [plan.md](/rooms/notes/plan.md)', first: false });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI is not ready on this computer" });
  expect(inspected(hosted)).toEqual([{ path: '/rooms/notes/plan.md' }]);
  await until(async () => (await bridgeSockets(hosted)).length === 0);
});

it("refuses a conversation whose connection cannot open in the Kit's words, and logs why", async () => {
  const hosted = await hostKit();
  vi.stubEnv('HOUSE_KIT_HOME', hosted.home);
  const sockets = socketDirectory();
  vi.unstubAllEnvs();
  await rm(sockets, { recursive: true, force: true });
  await writeFile(sockets, '');
  onTestFinished(() => rm(sockets, { force: true }));

  hosted.call({ kind: 'open' });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's computer could not open this conversation; try again" });
  expect(hosted.kit.stderr()).toContain(`${sockets} is not a directory`);
});

it('opens a conversation whose credential House refused as retryable while it restarted, once House answers it', async () => {
  const hosted = await hostKit();
  let refusals = 2;
  hosted.house.route('POST', '/kit/conversations/:conversation/credential', (request) =>
    refusals-- > 0
      ? { status: 503, body: { error: { code: 'house_overloaded', retryable: true } } }
      : { body: { credential: conversationCredential(request.params.conversation!) } },
  );

  hosted.call({ kind: 'open' });

  const result = await hosted.result(lastCall());
  expect(result).toEqual({ provider_session_id: expect.any(String) });
  const opened = (await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!;
  expect(result).toEqual({ provider_session_id: opened.sessionId });
  expect(hosted.house.requests.filter((received) => received.path.endsWith('/credential'))).toHaveLength(3);
});

it.each([
  [404, 'conversation_not_found', 'House no longer holds this conversation; start a new one'],
  [409, 'conversation_historical', "this conversation's Agent is retired, so it cannot start"],
])('refuses a conversation House answers %s %s for in its own words, without asking again', async (status, code, refused) => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/kit/conversations/:conversation/credential', () => ({
    status,
    body: { error: { code, retryable: false } },
  }));

  hosted.call({ kind: 'open' });

  expect(await hosted.result(lastCall())).toEqual({ refused });
  expect(hosted.house.requests.filter((received) => received.path.endsWith('/credential'))).toHaveLength(1);
});

const KINDS = ['codex-acp', 'claude-agent-acp', 'grok-build'];

async function opened(kind = 'codex-acp'): Promise<Hosted> {
  const hosted = await hostKit([{ kind }]);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  return hosted;
}

it('relays Grok plan approval with its recorded request and the owner response', async () => {
  const hosted = await opened('grok-build');

  hosted.call({ kind: 'message', text: '@replay grok-plan', first: false });

  const question = await until(() => hosted.interactions[0]);
  expect(question.body).toMatchObject({
    request: {
      method: '_x.ai/exit_plan_mode',
      params: {
        sessionId: expect.any(String),
        toolCallId: expect.any(String),
        planContent: 'create hello.txt containing hi\n',
      },
    },
    secret: false,
  });
  hosted.call({
    kind: 'answer',
    interaction_id: (question.body as { interaction_id: string }).interaction_id,
    response: 'approved',
  });
});

async function ends(hosted: Hosted, count: number, timeoutMs?: number): Promise<unknown[]> {
  const ended = await until(() => {
    const reported = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
    return reported.length === count ? reported : undefined;
  }, timeoutMs);
  return ended.map((turn) => outcome(turn.body));
}

async function prompts(hosted: Hosted): Promise<string[]> {
  return (await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt').map((entry) => String(entry.text));
}

function operations(hosted: Hosted, connection = hosted.house.connections.at(-1)!): Record<string, unknown>[] {
  return connection.notifications.filter((notification) => notification.type === 'turn');
}

function gated(hosted: Hosted, gate: string): () => Promise<void> {
  return () => writeFile(join(hosted.home, gate), '');
}

it.each(KINDS)("holds a message that reaches %s mid-turn until that turn ends, then sends it as the next turn's prompt", async (kind) => {
  const hosted = await opened(kind);
  const release = gated(hosted, 'first');

  hosted.call({ kind: 'message', text: '@gate first\n@say first', first: false });
  const first = lastCall();
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.call({ kind: 'message', text: '@say second', first: false });
  const second = lastCall();
  await hosted.result(first);
  await settle();

  expect(await prompts(hosted)).toEqual(['@gate first\n@say first']);
  expect(hosted.results.map((result) => result.params.input)).not.toContain(second);
  await release();
  expect(await ends(hosted, 2)).toEqual([{ text: 'first' }, { text: 'second' }]);
  expect(await prompts(hosted)).toEqual(['@gate first\n@say first', '@say second']);
  expect(await hosted.result(second)).toEqual({});
  const [startedFirst, endedFirst, startedSecond] = hosted.turns.map((turn) => turn.path.split('/').at(-1));
  expect([startedFirst, endedFirst, startedSecond]).toEqual(['started', 'ended', 'started']);
});

it('sends two messages that arrived mid-turn as two turns in the order they arrived', async () => {
  const hosted = await opened();
  const release = gated(hosted, 'first');
  hosted.call({ kind: 'message', text: '@gate first\n@say first', first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));

  hosted.call({ kind: 'message', text: '@say second', first: false });
  hosted.call({ kind: 'message', text: '@say third', first: false });
  await settle();
  await release();

  expect(await ends(hosted, 3)).toEqual([{ text: 'first' }, { text: 'second' }, { text: 'third' }]);
  expect(await prompts(hosted)).toEqual(['@gate first\n@say first', '@say second', '@say third']);
  expect(new Set(hosted.turns.map((turn) => turn.params.turn)).size).toBe(3);
});

function processes(hosted: Hosted): unknown[] {
  return hosted.connection.notifications.filter((notification) => notification.type === 'process').map((notification) => notification.running);
}

async function sessionsOpened(hosted: Hosted): Promise<Record<string, unknown>[]> {
  return (await hosted.adapterLog()).filter((entry) => entry.method === 'session/new' && (entry.params as { cwd: string }).cwd === hosted.workingDirectory);
}

it.each(['codex-acp', 'claude-agent-acp'])('steers an at-once message into the turn %s runs, which goes on with it', async (kind) => {
  const hosted = await opened(kind);
  const release = gated(hosted, 'first');
  hosted.call({ kind: 'message', text: '@gate first\n@say first', first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));

  hosted.call({ kind: 'message', text: '@say steered', first: false, at_once: true });

  expect(await hosted.result(lastCall())).toEqual({});
  await release();
  expect(await ends(hosted, 1)).toEqual([{ text: 'steeredfirst' }]);
  const log = await hosted.adapterLog();
  expect(log.filter((entry) => entry.method === '_session/steering').map((entry) => entry.text)).toEqual(['@say steered']);
  expect(log.filter((entry) => entry.method === 'session/cancel')).toEqual([]);
  expect(await prompts(hosted)).toEqual(['@gate first\n@say first']);
  await settle();
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/started'))).toHaveLength(1);
});

it('steers an at-once message into a turn whose question waits, and the question waits on for its answer', async () => {
  const hosted = await opened();
  hosted.call({ kind: 'message', text: '@ask', first: false });
  const question = await until(() => hosted.interactions[0]);

  hosted.call({ kind: 'message', text: '@say steered', first: false, at_once: true });

  expect(await hosted.result(lastCall())).toEqual({});
  const response = { outcome: { outcome: 'selected', optionId: 'allow' } };
  hosted.call({ kind: 'answer', interaction_id: (question.body as { interaction_id: string }).interaction_id, response });
  expect(await ends(hosted, 1)).toEqual([{ text: `steered${JSON.stringify(response)}` }]);
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/cancel')).toEqual([]);
});

it('interrupts the turn of a CLI that takes no message during a turn for an at-once message, which runs as the next turn before the message that waited', async () => {
  const hosted = await opened('grok-build');
  hosted.call({ kind: 'message', text: '@wait', first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.call({ kind: 'message', text: '@say waited', first: false });
  const waited = lastCall();

  hosted.call({ kind: 'message', text: '@say now', first: false, at_once: true });

  expect(await ends(hosted, 3)).toEqual([{ text: '' }, { text: 'now' }, { text: 'waited' }]);
  expect(await prompts(hosted)).toEqual(['@wait', '@say now', '@say waited']);
  const log = await hosted.adapterLog();
  expect(log.filter((entry) => entry.method === 'session/cancel')).toHaveLength(1);
  expect(log.filter((entry) => entry.method === '_session/steering')).toEqual([]);
  expect(await hosted.result(waited)).toEqual({});
});

it('sends an at-once message that arrives with no turn running as any message', async () => {
  const hosted = await opened();

  hosted.call({ kind: 'message', text: '@say alone', first: false, at_once: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'alone' }]);
  expect(await prompts(hosted)).toEqual(['@say alone']);
  const log = await hosted.adapterLog();
  expect(log.filter((entry) => entry.method === '_session/steering' || entry.method === 'session/cancel')).toEqual([]);
});

it('ends the running process and its bridge for an open, opens a new session in a new process, answers its id and resumes only that session after', async () => {
  const hosted = await hostKit();
  hosted.call({ kind: 'open' });
  const { provider_session_id: old } = (await hosted.result(lastCall())) as { provider_session_id: string };
  hosted.call({ kind: 'message', provider_session_id: old, text: '@say before', first: true });
  await ends(hosted, 1);
  const [before] = await sessionsOpened(hosted);

  hosted.call({ kind: 'open', provider_session_id: old });

  const { provider_session_id: fresh } = (await hosted.result(lastCall())) as { provider_session_id: string };
  const sessions = await sessionsOpened(hosted);
  expect(sessions.map((entry) => entry.sessionId)).toEqual([old, fresh]);
  expect(fresh).not.toBe(old);
  expect(alive(before!.pid as number)).toBe(false);
  expect(alive(sessions[1]!.pid as number)).toBe(true);
  expect(processes(hosted)).toEqual([true, false, true]);
  expect(hosted.house.requests.filter((request) => request.path === '/kit/conversations/conversation-1/credential')).toHaveLength(2);
  hosted.call({ kind: 'message', provider_session_id: old, text: '@say after\n@exit 3', first: false });
  await ends(hosted, 2);
  hosted.call({ kind: 'message', provider_session_id: old, text: '@say again', first: false });
  expect(await ends(hosted, 3)).toEqual([{ text: 'before' }, { failed: 'exited' }, { text: 'again' }]);
  const log = await hosted.adapterLog();
  expect(log.filter((entry) => entry.method === 'session/prompt').map((entry) => (entry.params as { sessionId: string }).sessionId)).toEqual([
    old,
    fresh,
    fresh,
  ]);
  expect(log.filter((entry) => entry.method === 'session/resume').map((entry) => (entry.params as { sessionId: string }).sessionId)).toEqual([fresh]);
});

it('ends the process for a done once the running turn has ended as it would and the message that waited behind it has run, and shows no kill', async () => {
  const hosted = await opened();
  const [cli] = await sessionsOpened(hosted);
  const release = gated(hosted, 'first');
  hosted.call({ kind: 'message', text: '@gate first\n@say first', first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.call({ kind: 'message', text: '@say second', first: false });

  hosted.call({ kind: 'done' });

  const done = lastCall();
  await settle();
  expect(hosted.results.map((result) => result.params.input)).not.toContain(done);
  expect(alive(cli!.pid as number)).toBe(true);
  await release();
  expect(await hosted.result(done)).toEqual({});
  expect(await ends(hosted, 2)).toEqual([{ text: 'first' }, { text: 'second' }]);
  expect(alive(cli!.pid as number)).toBe(false);
  await until(() => processes(hosted).length === 2);
  expect(processes(hosted)).toEqual([true, false]);
});

it('keeps a question waiting through a done until the owner answers it, then ends the process once its turn ends', async () => {
  const hosted = await opened();
  const [cli] = await sessionsOpened(hosted);
  hosted.call({ kind: 'message', text: '@ask', first: false });
  const question = await until(() => hosted.interactions[0]);

  hosted.call({ kind: 'done' });

  const done = lastCall();
  await settle();
  expect(hosted.results.map((result) => result.params.input)).not.toContain(done);
  expect(alive(cli!.pid as number)).toBe(true);
  const response = { outcome: { outcome: 'selected', optionId: 'allow' } };
  hosted.call({ kind: 'answer', interaction_id: (question.body as { interaction_id: string }).interaction_id, response });
  expect(await hosted.result(done)).toEqual({});
  expect(await ends(hosted, 1)).toEqual([{ text: JSON.stringify(response) }]);
  expect(alive(cli!.pid as number)).toBe(false);
  await until(() => processes(hosted).length === 2);
  expect(processes(hosted)).toEqual([true, false]);
});

it('answers a done for a conversation with no process and starts nothing', async () => {
  const hosted = await hostKit();

  hosted.call({ kind: 'done' });

  expect(await hosted.result(lastCall())).toEqual({});
  await settle();
  expect(await sessionsOpened(hosted)).toEqual([]);
  expect(hosted.house.requests.filter((request) => request.path.endsWith('/credential'))).toEqual([]);
  expect(processes(hosted)).toEqual([]);
});

it('resumes the provider session for a message that waited while the process crashed and sends it as the next turn', async () => {
  const hosted = await opened();
  const session = ((await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!.sessionId) as string;
  const release = gated(hosted, 'crash');
  hosted.call({ kind: 'message', text: '@gate crash\n@exit 3', first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.call({ kind: 'message', text: '@say after', first: false });
  await settle();

  await release();

  expect(await ends(hosted, 2)).toEqual([{ failed: 'exited' }, { text: 'after' }]);
  const log = await hosted.adapterLog();
  expect(log.find((entry) => entry.method === 'session/resume')!.params).toMatchObject({ sessionId: session });
  expect(new Set(log.filter((entry) => entry.method === 'session/prompt').map((entry) => entry.pid)).size).toBe(2);
});

it('keeps output a crashed Conversation process leaves behind out of the process that resumed its session', async () => {
  const hosted = await opened();
  const late = gated(hosted, 'late');
  const release = gated(hosted, 'replaced');
  hosted.call({ kind: 'message', text: '@linger late stale\n@exit 3', first: false });
  const lingering = (await until(async () => (await hosted.adapterLog()).find((entry) => entry.lingering !== undefined))).lingering as number;
  await until(() => hosted.connection.notifications.find((notification) => notification.type === 'process' && notification.running === false));
  hosted.call({ kind: 'message', text: '@gate replaced\n@say fresh', first: false });
  await until(() => hosted.turns.filter((turn) => turn.path.endsWith('/started'))[1]);

  await late();
  await until(() => !alive(lingering));
  await settle();
  await release();

  expect(await ends(hosted, 2)).toEqual([{ failed: 'exited' }, { text: 'fresh' }]);
  await settle();
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/started'))).toHaveLength(2);
});

it("does not return a result for a waiting message, so a restarted Kit process receives it again when its connection opens and sends it as the next turn", async () => {
  const hosted = await opened();
  const session = ((await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!.sessionId) as string;
  hosted.call({ kind: 'message', text: '@wait', first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.call({ kind: 'message', text: '@say again', first: false });
  const waiting = lastCall();
  await settle();
  expect(hosted.results.map((result) => result.params.input)).not.toContain(waiting);

  await hosted.restart();
  hosted.house.connections.at(-1)!.send({
    type: 'input',
    input_id: waiting,
    kind: 'message',
    message_id: 'message-again',
    conversation_id: 'conversation-1',
    agent_id: 'agent-1',
    provider_session_id: session,
    text: '@say again',
    first: false,
  });

  expect(await hosted.result(waiting)).toEqual({});
  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(outcome(ended.body)).toEqual({ text: 'again' });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/resume').map((entry) => entry.params)).toEqual([
    expect.objectContaining({ sessionId: session }),
  ]);
});

it('reports a turn start and end once each under the turn id Kit gave it', async () => {
  const hosted = await opened();

  hosted.call({ kind: 'message', text: '@say Hello', first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  const started = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
  expect(started).toHaveLength(1);
  expect(started[0]!.params).toEqual({ conversation: 'conversation-1', turn: expect.stringMatching(UUID) });
  expect(ended.params.turn).toBe(started[0]!.params.turn);
  expect(ended.body).toEqual({ parts: [{ type: 'text', text: 'Hello' }], context: null });
});

it('ends a turn failed as exited when its process exits during it, with the parts it had, and logs the exit only on its computer', async () => {
  const hosted = await opened();

  hosted.call({ kind: 'message', text: '@say partial\n@exit 3', first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(ended.body).toEqual({ parts: [{ type: 'text', text: 'partial' }], context: null, failed: 'exited' });
  expect(hosted.kit.stderr()).toMatch(/^kit: conversation conversation-1 turn \S+ failed: the CLI exited with 3/m);
  await until(() => hosted.connection.notifications.find((notification) => notification.type === 'process' && notification.running === false));
});

const FAST_SILENCE = fileURLToPath(new URL('./fast-silence.ts', import.meta.url));

// A silent CLI ends five seconds after its last message under fast-silence, so twenty seconds see it end on a loaded runner.
const SILENCE_SEEN_MS = 20_000;

// Seven seconds outlast the five-second silence a CLI that owed the Kit an answer would be ended after.
const PAST_SILENCE_MS = 7_000;

async function silenced(kind = 'codex-acp'): Promise<Hosted> {
  const hosted = await hostKit([{ kind }], { environment: { NODE_OPTIONS: `--import=${FAST_SILENCE}` } });
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  return hosted;
}

it.each(KINDS)(
  'ends a turn whose %s sends nothing for the silence bound as failed silent, ends that CLI, and resumes its session in a new one for the next message',
  async (kind) => {
    const hosted = await silenced(kind);
    const session = (await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!.sessionId as string;

    hosted.call({ kind: 'message', text: '@wait', first: false });

    const hung = (await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt'))).pid as number;
    expect(await ends(hosted, 1, SILENCE_SEEN_MS)).toEqual([{ failed: 'silent' }]);
    expect(alive(hung)).toBe(false);
    expect(hosted.kit.stderr()).toMatch(/^kit: conversation conversation-1 turn \S+ failed: the CLI sent nothing for 30 minutes$/m);
    hosted.call({ kind: 'message', text: '@say back', first: false, provider_session_id: session });
    expect(await ends(hosted, 2)).toEqual([{ failed: 'silent' }, { text: 'back' }]);
    const log = await hosted.adapterLog();
    expect(log.find((entry) => entry.method === 'session/resume')!.params).toMatchObject({ sessionId: session });
    expect(new Set(log.filter((entry) => entry.method === 'session/prompt').map((entry) => entry.pid)).size).toBe(2);
  },
);

it('ends a turn the CLI started itself and then went silent in as failed silent, with the parts it had', async () => {
  const hosted = await silenced('claude-agent-acp');

  hosted.call({ kind: 'message', text: '@say ok\n@itself 100 @gate never-opened', first: false });

  expect(await ends(hosted, 2, SILENCE_SEEN_MS)).toEqual([{ text: 'ok' }, { failed: 'silent' }]);
  await until(() => hosted.connection.notifications.find((notification) => notification.type === 'process' && notification.running === false));
});

it("keeps a turn whose CLI waits on the owner's answer to its question past the silence bound, and ends it with the answer", async () => {
  const hosted = await silenced();
  hosted.call({ kind: 'message', text: '@ask', first: false });
  const question = await until(() => hosted.interactions[0]);
  const asking = (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt')!.pid as number;

  await new Promise((resolve) => setTimeout(resolve, PAST_SILENCE_MS));

  expect(alive(asking)).toBe(true);
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/ended'))).toEqual([]);
  const response = { outcome: { outcome: 'selected', optionId: 'allow' } };
  hosted.call({ kind: 'answer', interaction_id: (question.body as { interaction_id: string }).interaction_id, response });
  expect(await ends(hosted, 1)).toEqual([{ text: JSON.stringify(response) }]);
});

it("refuses an open whose CLI never answers its session's opening once the silence bound passes, and opens the next one", async () => {
  const hosted = await hostKit([{}], { environment: { NODE_OPTIONS: `--import=${FAST_SILENCE}` } });
  await writeFile(join(hosted.home, 'hold-new'), '');

  hosted.call({ kind: 'open' });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI did not open a session" });
  expect(hosted.kit.stderr()).toMatch(/^kit: conversation conversation-1 did not start: .*the CLI sent nothing for 30 minutes$/m);
  await rm(join(hosted.home, 'hold-new'));
  hosted.call({ kind: 'open' });
  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
});

it('ends a CLI that never answers an option the owner changed once the silence bound passes, so the next message reaches a new one', async () => {
  const hosted = await silenced();
  await writeFile(join(hosted.home, 'hold-option'), '');

  hosted.call({ kind: 'option', option: 'model', value: 'gpt-5.5-mini' });

  expect(await hosted.result(lastCall())).toEqual({});
  const held = (await hosted.adapterLog()).find(
    (entry) => entry.method === 'session/set_config_option' && (entry.params as { value: string }).value === 'gpt-5.5-mini',
  )!.pid as number;
  await until(() => !alive(held));
  await rm(join(hosted.home, 'hold-option'));
  hosted.call({ kind: 'message', text: '@say next', first: false });
  expect(await ends(hosted, 1)).toEqual([{ text: 'next' }]);
  expect((await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt')!.pid).not.toBe(held);
});

it.each(['codex-acp', 'claude-agent-acp'])(
  'ends the %s process when a prompt fails with no turn left running, so the next message resumes the session in a fresh one',
  async (kind) => {
    const hosted = await opened(kind);
    const session = ((await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!.sessionId) as string;

    hosted.call({ kind: 'message', text: '@fail The agent process exited unexpectedly', first: true });

    expect(await ends(hosted, 1)).toEqual([{ failed: 'error' }]);
    await until(() => hosted.connection.notifications.find((notification) => notification.type === 'process' && notification.running === false));
    hosted.call({ kind: 'message', text: '@say back', first: false, provider_session_id: session });
    expect(await ends(hosted, 2)).toEqual([{ failed: 'error' }, { text: 'back' }]);
    const log = await hosted.adapterLog();
    expect(log.find((entry) => entry.method === 'session/resume')!.params).toMatchObject({ sessionId: session });
    expect(new Set(log.filter((entry) => entry.method === 'session/prompt').map((entry) => entry.pid)).size).toBe(2);
  },
);

it('sends a message that waited on a prompt the CLI failed to a fresh process that resumes the session', async () => {
  const hosted = await opened();
  const release = gated(hosted, 'failing');
  hosted.call({ kind: 'message', text: '@gate failing\n@fail provider request failed', first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.call({ kind: 'message', text: '@say next', first: false });
  await settle();

  await release();

  expect(await ends(hosted, 2)).toEqual([{ failed: 'error' }, { text: 'next' }]);
  const log = await hosted.adapterLog();
  expect(new Set(log.filter((entry) => entry.method === 'session/prompt').map((entry) => entry.pid)).size).toBe(2);
});

it.each(KINDS)('ends a turn failed as an error when %s fails the prompt after it ends the turn, its answer only in the Kit log', async (kind) => {
  const hosted = await opened(kind);

  // The prompt fails a tenth of a second after the CLI ends its turn, so the failure arrives after the end.
  hosted.call({ kind: 'message', text: '@say partial\n@ended\n@hold 100\n@fail provider request failed', first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(outcome(ended.body)).toEqual({ failed: 'error' });
  expect(hosted.kit.stderr()).toMatch(/^kit: conversation conversation-1 turn \S+ failed: provider request failed/m);
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/started')).map((turn) => turn.params.turn)).toEqual([
    ended.params.turn,
  ]);
});

it('ends a turn failed as a limit when Claude answers its prompt with an exhausted limit, shows its words as an error marker and keeps the process', async () => {
  const hosted = await opened('claude-agent-acp');
  const limit = "You've hit your weekly limit · resets 11am (UTC)";

  hosted.call({ kind: 'message', text: `@sessionfailure ${limit}`, first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(ended.body).toEqual({ parts: [{ type: 'marker', marker: 'retry', text: limit }], context: null, failed: 'limit' });
  hosted.call({ kind: 'message', text: '@say back', first: false });
  expect(await ends(hosted, 2)).toEqual([{ failed: 'limit' }, { text: 'back' }]);
  const log = await hosted.adapterLog();
  expect(new Set(log.filter((entry) => entry.method === 'session/prompt').map((entry) => entry.pid)).size).toBe(1);
});

it.each(KINDS)('ends a turn failed when %s refuses its prompt, with the explanation it gave or none', async (kind) => {
  const hosted = await opened(kind);

  hosted.call({ kind: 'message', text: '@refusal', first: true });
  hosted.call({ kind: 'message', text: '@say I cannot help with that.\n@refusal', first: false });

  await ends(hosted, 2);
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/ended')).map((turn) => turn.body)).toEqual([
    { parts: [], context: null, failed: 'refused' },
    { parts: [{ type: 'text', text: 'I cannot help with that.' }], context: null, failed: 'refused' },
  ]);
});

it.each(KINDS)('ends a turn failed as signed out when %s answers its prompt that it needs a sign-in, its answer only in the Kit log', async (kind) => {
  const hosted = await opened(kind);

  hosted.call({ kind: 'message', text: '@say partial\n@signedout', first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  expect(ended.body).toEqual({ parts: [{ type: 'text', text: 'partial' }], context: null, failed: 'signed_out' });
  expect(hosted.kit.stderr()).toMatch(/^kit: conversation conversation-1 turn \S+ failed: Authentication required/m);
});

it('ends a turn when Claude answers its prompt without an end notice, as it does for a local command', async () => {
  const hosted = await opened('claude-agent-acp');

  hosted.call({ kind: 'message', text: '@say local output\n@answer', first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'local output' }]);
});

it.each(KINDS)('reports a turn the CLI starts by itself like any other and ends it when %s ends it', async (kind) => {
  const hosted = await opened(kind);

  // The CLI starts its own turn half a second after the prompted one ends, so the two stay apart.
  hosted.call({ kind: 'message', text: '@later 500 by itself', first: true });

  expect(await ends(hosted, 2)).toEqual([{ text: '' }, { text: 'by itself' }]);
  const starts = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
  const finished = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
  expect(starts.map((turn) => turn.params.turn)).toEqual(finished.map((turn) => turn.params.turn));
});

it.each(KINDS)('reports a turn %s starts by itself when it starts it, before it writes any text', async (kind) => {
  const hosted = await opened(kind);

  // The CLI starts its own turn half a second after the prompted one ends, so the two stay apart.
  hosted.call({ kind: 'message', text: '@later 500', first: true });

  expect(await ends(hosted, 2)).toEqual([{ text: '' }, { text: '' }]);
});

it('writes no part operation while nobody watches, and still reports the turn start, its question and its finished parts', async () => {
  const hosted = await opened();

  hosted.call({ kind: 'message', text: '@say Hello\n@tool Read the file\n@ask', first: true });
  const question = await until(() => hosted.interactions[0]);
  hosted.call({
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
  hosted.call({ kind: 'message', text: '@say one\n@tool Read it\n@gate second\n@say two\n@gate third\n@say three', first: true });
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

it("writes the running turn's operations so far once on a Kit connection that reopens watched, and none on one that reopens unwatched", async () => {
  const hosted = await opened();
  hosted.watch(true);
  const release = gated(hosted, 'later');
  hosted.call({ kind: 'message', text: '@say one\n@gate later\n@say  two', first: true });
  const turn = (await until(() => operations(hosted)[0])).turn_id;

  hosted.house.connections.at(-1)!.close(1001, 'shutting_down');
  const unwatched = await until(() => hosted.house.connections[1]);
  await settle();
  expect(operations(hosted, unwatched)).toEqual([]);
  unwatched.close(1001, 'shutting_down');
  const watched = await until(() => hosted.house.connections[2]);
  hosted.watch(true);
  await until(() => operations(hosted, watched)[0]);
  await release();

  expect(await ends(hosted, 1)).toEqual([{ text: 'one two' }]);
  expect(operations(hosted, watched)).toEqual([
    { type: 'turn', conversation_id: 'conversation-1', turn_id: turn, op: 'start', index: 0, part: { type: 'text', text: 'one' } },
    { type: 'turn', conversation_id: 'conversation-1', turn_id: turn, op: 'append', index: 0, text: ' two' },
  ]);
});

it("writes each operation of a turn as it happens, before House answers the turn's start report, so a turn that ends at once streams its text", async () => {
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

  hosted.call({ kind: 'message', text: '@say one\n@plan read|fix\n@say  two', first: true });
  await until(() => operations(hosted).length === 3);
  expect(hosted.turns).toEqual([]);
  admit();

  expect(await ends(hosted, 1)).toEqual([{ text: 'one two' }]);
  const turn = hosted.turns[0]!.params.turn;
  expect(operations(hosted)).toEqual([
    { type: 'turn', conversation_id: 'conversation-1', turn_id: turn, op: 'start', index: 0, part: { type: 'text', text: 'one' } },
    {
      type: 'turn',
      conversation_id: 'conversation-1',
      turn_id: turn,
      op: 'start',
      index: 1,
      part: {
        type: 'plan',
        entries: [
          { content: 'read', status: 'pending' },
          { content: 'fix', status: 'pending' },
        ],
      },
    },
    { type: 'turn', conversation_id: 'conversation-1', turn_id: turn, op: 'start', index: 2, part: { type: 'text', text: ' two' } },
  ]);
});

it('calls restarted before it opens its Kit connection', async () => {
  const hosted = await hostKit();

  const order = hosted.house.requests.map((request) => request.path);
  expect(order.indexOf('/kit/restarted')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('/kit/restarted')).toBeLessThan(order.indexOf('/kit/stream'));
});

it('reads the CLI again only after the conversation it opens has had two quiet seconds', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp', model: null, effort: null }], {
    prepare: async (home) => {
      await mkdir(join(home, 'signed-in'), { recursive: true });
      await writeFile(join(home, 'signed-in', 'codex-acp'), '');
    },
  });
  await until(() => hosted.reports.find((report) =>
    (report.agents as { kind: string; signed_in: boolean; models: unknown[] }[])
      .some((agent) => agent.kind === 'codex-acp' && agent.signed_in && agent.models.length > 0),
  ));
  const sessions = async () => (await hosted.adapterLog()).filter((entry) => entry.method === 'session/new').length;
  const before = await sessions();
  const opening = Date.now();
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  await until(async () => (await sessions()) === before + 1);
  await until(async () => (await sessions()) === before + 2);
  expect(Date.now() - opening).toBeGreaterThanOrEqual(2_000);
});

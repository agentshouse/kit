import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { until, type Answer } from './double.ts';
import { hostKit, installHeld, lastInput, type Hosted } from './environment.ts';
import { alive, filesUnder } from './kit.ts';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
const started = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/started'));

async function opened(hosted: Hosted): Promise<string> {
  hosted.input({ kind: 'open' });
  return ((await hosted.ack(lastInput())) as { provider_session_id: string }).provider_session_id;
}

it('cancels the running turn on interrupt and keeps the process and session', async () => {
  const hosted = await hostKit();
  const session = await opened(hosted);
  hosted.input({ kind: 'message', text: '@wait', files: [], first: true });
  const turn = (await until(() => started(hosted)[0])).params.turn!;

  hosted.input({ kind: 'interrupt', turn_id: turn });

  expect(await until(() => ended(hosted)[0])).toMatchObject({ params: { turn }, body: { text: '' } });
  hosted.input({ kind: 'interrupt', turn_id: turn });
  await hosted.ack(lastInput());
  hosted.input({ kind: 'message', text: '@say again', files: [], first: false });
  await until(() => ended(hosted)[1]);
  const log = await hosted.adapterLog();
  expect(log.filter((entry) => entry.method === 'session/cancel')).toHaveLength(1);
  expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
  expect(log.filter((entry) => entry.method === 'session/prompt').map((entry) => (entry.params as { sessionId: string }).sessionId)).toEqual([
    session,
    session,
  ]);
  expect(hosted.socket.frames.filter((frame) => frame.type === 'process')).toEqual([
    { type: 'process', conversation_id: 'conversation-1', running: true },
  ]);
});

it('kills the process and every process it started, and the next message resumes the session', async () => {
  const hosted = await hostKit();
  const session = await opened(hosted);
  hosted.input({ kind: 'message', text: '@spawn\n@wait', files: [], first: true });
  const spawned = await until(async () => (await hosted.adapterLog()).find((entry) => entry.spawned));
  const adapter = spawned.pid as number;
  expect(alive(spawned.spawned as number)).toBe(true);

  hosted.input({ kind: 'kill' });

  expect(await hosted.ack(lastInput())).toEqual({});
  expect(alive(adapter)).toBe(false);
  await until(() => !alive(spawned.spawned as number) && !alive(spawned.clean as number));
  expect(await until(() => ended(hosted)[0])).toMatchObject({ body: { failed: 'the conversation was killed' } });
  await until(() => hosted.socket.frames.find((frame) => frame.type === 'process' && frame.running === false));

  hosted.input({ kind: 'message', provider_session_id: session, text: 'after', files: [], first: false });
  await hosted.ack(lastInput());
  const resumed = await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/resume'));
  expect(resumed.params).toMatchObject({ sessionId: session });
});

it('kills a process still opening its session and refuses the open, and the next message opens a new one', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'hold-open'), '');
  hosted.input({ kind: 'open' });
  const open = lastInput();
  const spawned = await until(async () => (await hosted.adapterLog()).find((entry) => entry.spawned));

  hosted.input({ kind: 'kill' });

  expect(await hosted.ack(lastInput())).toEqual({});
  expect(await hosted.ack(open)).toEqual({ refused: 'the conversation was killed' });
  expect(alive(spawned.pid as number)).toBe(false);
  await until(() => !alive(spawned.spawned as number));
  await rm(join(hosted.home, 'hold-open'));
  hosted.input({ kind: 'message', text: '@say again', files: [], first: false });
  expect(await hosted.ack(lastInput())).toHaveProperty('provider_session_id');
});

it.each([
  ['its tool call', '/', {}, []],
  ['the tool list its call is classified by', '/kit/tools/mutations', { tools: [] }, []],
  ['the file it attaches', '/kit/conversation/originals/get', {}, [{ version: 'version-1', name: 'file.txt' }]],
])(
  'kills a running process the moment the kill arrives while House holds %s for its first message, and refuses that message',
  async (_held, path, body, files) => {
    const hosted = await hostKit();
    await opened(hosted);
    const adapter = (await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!.pid as number;
    let release!: (answer: Answer) => void;
    const held = new Promise<Answer>((resolve) => {
      release = resolve;
    });
    onTestFinished(() => release({ body }));
    hosted.house.route('POST', path, () => held);
    hosted.input({ kind: 'message', text: '@say hello', files, first: true });
    const message = lastInput();
    await until(() => hosted.house.requests.find((request) => request.path === path));

    hosted.input({ kind: 'kill' });

    expect(await hosted.ack(message)).toEqual({ refused: 'the conversation was killed' });
    expect(await hosted.ack(lastInput())).toEqual({});
    expect(alive(adapter)).toBe(false);
  },
);

it('refuses an open and acknowledges the kill at once while the Kit still installs the CLI the open needs', async () => {
  const hosted = await hostKit();
  await installHeld(hosted);
  hosted.input({ kind: 'open', agent_id: 'agent-2' });
  const open = lastInput();

  hosted.input({ kind: 'kill', agent_id: 'agent-2' });

  expect(await hosted.ack(lastInput())).toEqual({});
  expect(await hosted.ack(open)).toEqual({ refused: 'the conversation was killed' });
});

it('refuses an open and acknowledges the kill at once while House holds the credential for its process', async () => {
  const hosted = await hostKit();
  let release!: (answer: Answer) => void;
  const held = new Promise<Answer>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release({ status: 503, body: {} }));
  hosted.house.route('POST', '/kit/conversations/:conversation/credential', () => held);
  hosted.input({ kind: 'open' });
  const open = lastInput();
  await until(() => hosted.house.requests.find((request) => request.path === '/kit/conversations/conversation-1/credential'));

  hosted.input({ kind: 'kill' });

  expect(await hosted.ack(lastInput())).toEqual({});
  expect(await hosted.ack(open)).toEqual({ refused: 'the conversation was killed' });
});

it.each(['SIGTERM', 'SIGINT'] as const)(
  'kills every process it started, of a running conversation and of one still opening, when %s stops it',
  async (signal) => {
    const hosted = await hostKit();
    await opened(hosted);
    hosted.input({ kind: 'message', text: '@spawn\n@wait', files: [], first: true });
    await until(async () => (await hosted.adapterLog()).find((entry) => entry.spawned));
    await writeFile(join(hosted.home, 'hold-open'), '');
    hosted.input({ kind: 'open', conversation_id: 'conversation-2' });
    const spawned = await until(async () => {
      const entries = (await hosted.adapterLog()).filter((entry) => entry.spawned);
      return entries.length === 2 ? entries : undefined;
    });

    process.kill(hosted.kit.pid, signal);
    await hosted.kit.exited;

    await until(() =>
      spawned.every((entry) => [entry.pid, entry.spawned, entry.clean].every((pid) => !alive(pid as number))),
    );
  },
);

it('kills a background job its crashed process left behind when SIGTERM stops it', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'message', text: '@spawn\n@exit 1', files: [], first: false });
  const spawned = await until(async () => (await hosted.adapterLog()).find((entry) => entry.spawned));
  await until(() => ended(hosted)[0]);
  expect(alive(spawned.pid as number)).toBe(false);
  expect(alive(spawned.spawned as number)).toBe(true);
  expect(alive(spawned.clean as number)).toBe(true);

  process.kill(hosted.kit.pid, 'SIGTERM');
  await hosted.kit.exited;

  await until(() => !alive(spawned.spawned as number) && !alive(spawned.clean as number));
});

it('sets an option on the running process and relays the commands and options the CLI sends', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  const options = (frame: Record<string, unknown>) => frame.type === 'options';
  await until(() => hosted.socket.frames.find(options));

  hosted.input({ kind: 'option', option: 'model', value: 'other-model' });
  await hosted.ack(lastInput());
  hosted.input({ kind: 'message', text: '@commands\n@config', files: [], first: true });
  await until(() => ended(hosted)[0]);

  const log = await hosted.adapterLog();
  expect(log.filter((entry) => entry.method === 'session/set_config_option').at(-1)!.params).toMatchObject({
    configId: 'model',
    value: 'other-model',
  });
  const current = (frame: Record<string, unknown>) =>
    Object.fromEntries((frame.options as { id: string; currentValue: string }[]).map((option) => [option.id, option.currentValue]));
  expect(hosted.socket.frames.filter(options).map(current)).toEqual([
    { model: 'route-model', effort: 'route-effort' },
    { model: 'other-model', effort: 'route-effort' },
    { model: 'other-model', effort: 'from-cli' },
  ]);
  expect(hosted.socket.frames.filter((frame) => frame.type === 'commands')).toEqual([
    {
      type: 'commands',
      conversation_id: 'conversation-1',
      commands: [{ name: 'compact', description: 'Compact the conversation', input: null }],
    },
  ]);
});

it('reports a question with the CLI request unchanged and passes the answer back unchanged', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  hosted.input({ kind: 'message', text: '@ask', files: [], first: true });

  const question = await until(() => hosted.interactions[0]);
  const turn = started(hosted)[0]!.params.turn;
  expect(question.params).toEqual({ conversation: 'conversation-1', turn });
  expect(question.body).toEqual({
    interaction_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    request: {
      method: 'session/request_permission',
      params: {
        sessionId: expect.any(String),
        toolCall: { toolCallId: 'tool-1', title: 'Run a command' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    },
    secret: false,
  });
  const { interaction_id } = question.body as { interaction_id: string };
  const response = { outcome: { outcome: 'selected', optionId: 'allow' } };

  hosted.input({ kind: 'answer', interaction_id, response });

  expect((await until(() => ended(hosted)[0])).body).toEqual({ text: JSON.stringify(response) });
  hosted.input({ kind: 'answer', interaction_id, response: { outcome: { outcome: 'cancelled' } } });
  expect(await hosted.ack(lastInput())).toEqual({});
});

it.each([0, 2500])(
  'drops a question the CLI stops waiting on, its report %i ms on its way, so its answer does nothing and the turn no longer counts as waiting',
  async (delay) => {
    const hosted = await hostKit();
    hosted.house.route('POST', '/kit/conversations/:conversation/turns/:turn/interactions', async (request) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      hosted.interactions.push(request);
      return { body: {} };
    });
    await opened(hosted);
    await until(() => hosted.idles[1]);
    hosted.input({ kind: 'message', text: '@abandon 300\n@hold 1500\n@say after', files: [], first: true });
    await until(() => hosted.idles[2]);

    const abandoned = async () => (await hosted.adapterLog()).filter((entry) => 'abandoned' in entry);
    expect(await until(async () => (await abandoned())[0])).toMatchObject({ abandoned: 'cancelled' });
    const { interaction_id } = (await until(() => hosted.interactions[0])).body as { interaction_id: string };
    hosted.input({ kind: 'answer', interaction_id, response: { outcome: { outcome: 'selected', optionId: 'allow' } } });

    expect(await hosted.ack(lastInput())).toEqual({});
    expect((await until(() => ended(hosted)[0])).body).toEqual({ text: 'after' });
    await until(() => hosted.idles[3]);
    expect(await abandoned()).toHaveLength(1);
  },
);

it('passes a secret from the held secret-input request to the CLI and keeps it nowhere', async () => {
  const hosted = await hostKit();
  const secret = 's3cret-value-for-the-cli';
  const holds: Record<string, unknown>[] = [];
  hosted.house.route('POST', '/kit/secret-input/:subject', (request) => {
    holds.push({ subject: request.params.subject, body: request.body });
    return holds.length === 1
      ? { body: { outcome: 'released', release: 'held' } }
      : { body: { outcome: 'collected', content: { token: secret } } };
  });
  await opened(hosted);

  hosted.input({
    kind: 'message',
    text: `@secret ${createHash('sha256').update(secret).digest('hex')}`,
    files: [],
    first: true,
  });

  expect((await until(() => ended(hosted)[0])).body).toEqual({ text: 'secret matched' });
  const question = hosted.interactions[0]!.body as { interaction_id: string; secret: boolean };
  expect(question.secret).toBe(true);
  expect(holds).toEqual([
    { subject: question.interaction_id, body: { steps: [{ kind: 'collect', label: 'Token', name: 'token' }] } },
    { subject: question.interaction_id, body: { steps: [{ kind: 'collect', label: 'Token', name: 'token' }] } },
  ]);
  for (const file of await filesUnder(hosted.home)) {
    expect(await readFile(file, 'utf8')).not.toContain(secret);
  }
  expect(hosted.kit.stdout() + hosted.kit.stderr()).not.toContain(secret);
  expect(JSON.stringify(hosted.socket.frames)).not.toContain(secret);
});

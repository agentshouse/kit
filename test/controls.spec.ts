import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastInput, type Hosted } from './environment.ts';
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
  await until(() => !alive(spawned.spawned as number));
  expect(await until(() => ended(hosted)[0])).toMatchObject({ body: { failed: 'the conversation was killed' } });
  await until(() => hosted.socket.frames.find((frame) => frame.type === 'process' && frame.running === false));

  hosted.input({ kind: 'message', provider_session_id: session, text: 'after', files: [], first: false });
  await hosted.ack(lastInput());
  const resumed = await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/resume'));
  expect(resumed.params).toMatchObject({ sessionId: session });
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

it('drops a question the CLI stops waiting on, so its answer does nothing and the turn no longer counts as waiting', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);
  hosted.input({ kind: 'message', text: '@abandon 300\n@hold 1500\n@say after', files: [], first: true });
  const { interaction_id } = (await until(() => hosted.interactions[0])).body as { interaction_id: string };
  await until(() => hosted.idles[2]);

  const abandoned = async () => (await hosted.adapterLog()).filter((entry) => 'abandoned' in entry);
  expect(await until(async () => (await abandoned())[0])).toMatchObject({ abandoned: 'cancelled' });
  hosted.input({ kind: 'answer', interaction_id, response: { outcome: { outcome: 'selected', optionId: 'allow' } } });

  expect(await hosted.ack(lastInput())).toEqual({});
  expect((await until(() => ended(hosted)[0])).body).toEqual({ text: 'after' });
  await until(() => hosted.idles[3]);
  expect(await abandoned()).toHaveLength(1);
});

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

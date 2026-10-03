import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastInput } from './environment.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    { sessionId: opened.sessionId, configId: 'effort', value: 'high' },
  ]);
  expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
  expect(hosted.socket.frames).toContainEqual({ type: 'process', conversation_id: 'conversation-1', running: true });
});

it('creates an absent default launch directory before it opens the session there', async () => {
  const hosted = await hostKit([{ working_directory: '/agents/house/agent-1' }]);

  hosted.input({ kind: 'open' });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  expect((await stat('/agents/house/agent-1')).isDirectory()).toBe(true);
  const opened = (await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!;
  expect(opened.params).toMatchObject({ cwd: '/agents/house/agent-1' });
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

it('writes a message that arrives during a running turn to the CLI at once', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@wait', files: [], first: true });
  await hosted.ack(lastInput());
  hosted.input({ kind: 'message', text: 'meanwhile', files: [], first: false });
  await hosted.ack(lastInput());

  await until(async () => (await hosted.adapterLog()).some((entry) => entry.text === 'meanwhile'));
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/ended'))).toEqual([]);
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

it('reports a turn the CLI starts by itself like any other', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@later 300 by itself', files: [], first: true });

  const ends = await until(() => {
    const ended = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
    return ended.length === 2 ? ended : undefined;
  }, 20_000);
  expect(ends.map((turn) => turn.body)).toEqual([{ text: '' }, { text: 'by itself' }]);
  const starts = hosted.turns.filter((turn) => turn.path.endsWith('/started'));
  expect(starts.map((turn) => turn.params.turn)).toEqual(ends.map((turn) => turn.params.turn));
  expect(hosted.socket.frames).toContainEqual(
    expect.objectContaining({ type: 'draft', turn_id: ends[1]!.params.turn, blocks: [{ type: 'paragraph', text: 'by itself' }] }),
  );
});

it('writes each message chunk as a draft frame with the next sequence and plan updates as plan frames', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: '@say Hello\n@say  world\n@say \\n\\nNext\n@plan first|second', files: [], first: true });

  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));
  const turn = ended.params.turn;
  const drafts = hosted.socket.frames.filter((frame) => frame.type === 'draft');
  expect(drafts).toEqual([
    { type: 'draft', conversation_id: 'conversation-1', turn_id: turn, sequence: 1, from: 0, blocks: [{ type: 'paragraph', text: 'Hello' }] },
    { type: 'draft', conversation_id: 'conversation-1', turn_id: turn, sequence: 2, from: 0, blocks: [{ type: 'paragraph', text: 'Hello world' }] },
    { type: 'draft', conversation_id: 'conversation-1', turn_id: turn, sequence: 3, from: 1, blocks: [{ type: 'paragraph', text: 'Next' }] },
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
  expect(ended.body).toEqual({ text: 'Hello world\n\nNext' });
});

it('calls restarted before it opens its socket', async () => {
  const hosted = await hostKit();

  const order = hosted.house.requests.map((request) => request.path);
  expect(order.indexOf('/kit/restarted')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('/kit/restarted')).toBeLessThan(order.indexOf('/kit/stream'));
});

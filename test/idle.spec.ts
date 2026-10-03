import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastInput, type Hosted } from './environment.ts';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

async function opened(hosted: Hosted): Promise<void> {
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
}

it('reports idle once no turn runs and not while a turn runs without waiting on a question', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.input({ kind: 'message', text: '@hold 1500\n@say done', files: [], first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  await settle();
  expect(hosted.idles).toHaveLength(2);

  await until(() => ended(hosted)[0]);
  await until(() => hosted.idles[2]);
});

it('reports idle only after it acknowledges the input it carried out', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  hosted.house.route('POST', '/kit/inputs/:input/ack', async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    hosted.acks.push(request);
    return { body: {} };
  });

  hosted.input({ kind: 'open' });

  await hosted.ack(lastInput());
  const paths = (await until(() => hosted.idles[1] && hosted.house.requests)).map((request) => request.path);
  expect(paths.lastIndexOf('/kit/idle')).toBeGreaterThan(paths.indexOf(`/kit/inputs/${lastInput()}/ack`));
  expect(paths.filter((path) => path === '/kit/idle')).toHaveLength(2);
});

it('counts a turn waiting on a non-secret question as idle', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.input({ kind: 'message', text: '@ask', files: [], first: true });
  await until(() => hosted.interactions[0]);

  await until(() => hosted.idles[2]);
});

it('does not count a turn waiting on a secret question as idle', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/kit/secret-input/:subject', async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { body: { outcome: 'released', release: 'held' } };
  });
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.input({ kind: 'message', text: `@secret ${createHash('sha256').update('x').digest('hex')}`, files: [], first: true });
  await until(() => hosted.interactions[0]);
  await settle();

  expect(hosted.idles).toHaveLength(2);
});

it('does not report idle while the CLI reports a running background job', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);
  expect(
    ((await hosted.adapterLog()).find((entry) => entry.method === 'initialize')!.params as {
      clientCapabilities: { _meta: unknown };
    }).clientCapabilities._meta,
  ).toEqual({ jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } });

  hosted.input({ kind: 'message', text: '@job job-1\n@say started', files: [], first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  hosted.input({ kind: 'message', text: '@jobdone job-1', files: [], first: false });
  await until(() => ended(hosted)[1]);
  await until(() => hosted.idles[2]);
});

it('writes each running process frames again on a new socket and carries out the answer it then receives', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  hosted.input({ kind: 'message', text: '@commands\n@ask', files: [], first: true });
  const question = (await until(() => hosted.interactions[0])).body as { interaction_id: string };

  hosted.socket.close(1001, 'shutting_down');
  const reopened = await until(() => hosted.house.sockets[1]);
  await until(() => reopened.frames.find((frame) => frame.type === 'options'));
  expect(reopened.frames.map((frame) => frame.type)).toEqual(['process', 'commands', 'options']);
  expect(reopened.frames[0]).toEqual({ type: 'process', conversation_id: 'conversation-1', running: true });

  const response = { outcome: { outcome: 'selected', optionId: 'allow' } };
  hosted.input({ kind: 'answer', interaction_id: question.interaction_id, response });

  expect((await until(() => ended(hosted)[0])).body).toEqual({ text: JSON.stringify(response) });
});

import { expect, it } from 'vitest';
import { settle, until } from './double.ts';
import { hostKit, lastCall } from './environment.ts';

it('refuses a Kit call whose method it does not know, naming the method, and returns its refusal once', async () => {
  const hosted = await hostKit();

  hosted.call({ kind: 'rewind', turn_id: 'turn-1' });

  expect(await hosted.result(lastCall())).toEqual({ refused: 'This Kit does not know rewind; update the Kit' });
  await settle();
  expect(hosted.results.map((result) => result.params.input)).toEqual([lastCall()]);
  expect(hosted.socket.notifications.filter((notification) => notification.type === 'process')).toEqual([]);
});

it('carries a Kit call of a method it knows though the call names a field it does not know', async () => {
  const hosted = await hostKit();

  hosted.call({ kind: 'open', resumed_from: 'a later House' });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
});

it('opens no second session for an open its reopened connection sends after it returned its result, and returns the same result again', async () => {
  const hosted = await hostKit();
  hosted.call({ kind: 'open' });
  const call = lastCall();
  const answer = await hosted.result(call);
  hosted.socket.close(1001, 'shutting_down');
  await until(() => hosted.house.sockets[1]);

  hosted.call({ input_id: call, kind: 'open' });

  await until(() => hosted.results[1]);
  await settle();
  expect(hosted.results.map((result) => [result.params.input, result.body])).toEqual([
    [call, answer],
    [call, answer],
  ]);
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new')).toHaveLength(1);
});

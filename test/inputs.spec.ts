import { expect, it } from 'vitest';
import { settle, until } from './double.ts';
import { hostKit, lastInput } from './environment.ts';

it('refuses an input whose kind it does not know, naming the kind, and acknowledges nothing for it', async () => {
  const hosted = await hostKit();

  hosted.input({ kind: 'rewind', turn_id: 'turn-1' });

  expect(await hosted.ack(lastInput())).toEqual({ refused: 'This Kit does not know rewind; update the Kit' });
  await settle();
  expect(hosted.acks.map((ack) => ack.params.input)).toEqual([lastInput()]);
  expect(hosted.socket.frames.filter((frame) => frame.type === 'process')).toEqual([]);
});

it('carries an input of a kind it knows though the input names a field it does not know', async () => {
  const hosted = await hostKit();

  hosted.input({ kind: 'open', resumed_from: 'a later House' });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
});

it('opens no second session for an open its reopened socket sends after it was acknowledged, and acknowledges it again with the same answer', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  const input = lastInput();
  const answer = await hosted.ack(input);
  hosted.socket.close(1001, 'shutting_down');
  await until(() => hosted.house.sockets[1]);

  hosted.input({ input_id: input, kind: 'open' });

  await until(() => hosted.acks[1]);
  await settle();
  expect(hosted.acks.map((ack) => [ack.params.input, ack.body])).toEqual([
    [input, answer],
    [input, answer],
  ]);
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new')).toHaveLength(1);
});

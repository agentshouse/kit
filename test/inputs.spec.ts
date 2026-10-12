import { expect, it } from 'vitest';
import { settle } from './double.ts';
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

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startHouse, until, type House } from './double.ts';
import { runKit, temporaryHome, type KitRun } from './kit.ts';

let house: House;
let kit: KitRun | undefined;

beforeEach(async () => {
  house = await startHouse();
});

afterEach(async () => {
  await kit?.stop();
  await house.stop();
});

async function enrolled(): Promise<string> {
  const home = await temporaryHome();
  await writeFile(
    join(home, 'credential.json'),
    JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }),
  );
  return home;
}

it('holds the control stream with its credential and opens a new socket after every close', async () => {
  kit = runKit(['resident'], { HOUSE_KIT_HOME: await enrolled() });

  const first = await until(() => house.sockets[0]);
  expect(first.headers.authorization).toBe('Bearer ahk_held');
  expect(first.protocol).toBe('house.kit.stream.1');

  first.close(1008, 'replaced');
  const second = await until(() => house.sockets[1]);
  expect(second.headers.authorization).toBe('Bearer ahk_held');

  second.close(1001, 'shutting_down');
  await until(() => house.sockets[2]);

  house.sockets[2]!.socket.terminate();
  await until(() => house.sockets[3]);
}, 30_000);

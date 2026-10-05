import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, until, type House } from './double.ts';
import { runKit, temporaryHome } from './kit.ts';

async function enrol(house: House, home: string, credential: string) {
  await writeFile(
    join(home, 'credential.json'),
    JSON.stringify({ house: house.origin, environment: 'environment-one', credential }),
  );
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: false }));
}

it('holds the control stream with its credential and opens a new socket after every close', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await enrol(house, home, 'ahk_held');
  runKit(['resident'], { HOUSE_KIT_HOME: home });

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
});

it('presents the credential a later login stored when it opens its next socket', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await enrol(house, home, 'ahk_first');
  runKit(['resident'], { HOUSE_KIT_HOME: home });
  const first = await until(() => house.sockets[0]);

  await enrol(house, home, 'ahk_second');
  first.close(1008, 'authority_changed');

  const second = await until(() => house.sockets[1]);
  expect(second.headers.authorization).toBe('Bearer ahk_second');
});

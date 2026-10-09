import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, until, type House } from './double.ts';
import { runKit, temporaryHome, type KitRun } from './kit.ts';

async function enrol(house: House, home: string, credential: string) {
  await writeFile(
    join(home, 'credential.json'),
    JSON.stringify({ house: house.origin, environment: 'environment-one', credential }),
  );
}

async function resident(house: House): Promise<KitRun> {
  const home = await temporaryHome();
  await enrol(house, home, 'ahk_held');
  return runKit(['resident'], { HOUSE_KIT_HOME: home });
}

async function ended(kit: KitRun): Promise<number | null> {
  let code: number | null | undefined;
  void kit.exited.then((exited) => {
    code = exited;
  });
  await until(() => code !== undefined);
  return code!;
}

function openings(house: House): number {
  return house.requests.filter((request) => request.method === 'UPGRADE').length;
}

it('holds the control stream with its credential and opens a new socket after every other close', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await enrol(house, home, 'ahk_held');
  runKit(['resident'], { HOUSE_KIT_HOME: home });

  const first = await until(() => house.sockets[0]);
  expect(first.headers.authorization).toBe('Bearer ahk_held');
  expect(first.protocol).toBe('house.kit.stream.1');

  first.close(1008, 'heartbeat_missed');
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

it('ends, left stopped, when House replaces its socket with another Kit of its Environment', async () => {
  const house = await startHouse();
  const kit = await resident(house);

  (await until(() => house.sockets[0])).close(1008, 'replaced');

  expect(await ended(kit)).toBe(0);
  expect(kit.stderr()).toContain('kit: another Kit started for this Environment\n');
  expect(openings(house)).toBe(1);
});

it('ends, left stopped, asking to sign in again when House closes its socket for a rejected credential', async () => {
  const house = await startHouse();
  const kit = await resident(house);

  (await until(() => house.sockets[0])).close(1008, 'credential_rejected');

  expect(await ended(kit)).toBe(0);
  expect(kit.stderr()).toContain('kit: sign in again\n');
  expect(openings(house)).toBe(1);
});

it('ends, left stopped, asking to sign in again when House refuses its socket opening with 401', async () => {
  const house = await startHouse();
  house.route('UPGRADE', '/kit/stream', () => ({ status: 401, body: { error: { code: 'token_rejected' } } }));
  const kit = await resident(house);

  expect(await ended(kit)).toBe(0);
  expect(kit.stderr()).toContain('kit: sign in again\n');
  expect(house.sockets).toEqual([]);
});

it('ends, left stopped, asking to sign in again when House refuses any of its calls with 401', async () => {
  const house = await startHouse();
  house.route('POST', '/kit/restarted', () => ({ status: 401, body: { error: { code: 'token_rejected' } } }));
  const kit = await resident(house);

  expect(await ended(kit)).toBe(0);
  expect(kit.stderr()).toContain('kit: sign in again\n');
  expect(openings(house)).toBe(0);
});

it('ends, left stopped, naming the refusal when House refuses its socket opening with another 4xx', async () => {
  const house = await startHouse();
  house.route('UPGRADE', '/kit/stream', () => ({ status: 429, body: { error: { code: 'sockets_per_user_exceeded' } } }));
  const kit = await resident(house);

  expect(await ended(kit)).toBe(0);
  expect(kit.stderr()).toContain('kit: House refused /kit/stream with 429: sockets_per_user_exceeded\n');
  expect(openings(house)).toBe(1);
});

it('opens its socket again after House answers its opening with a 5xx', async () => {
  const house = await startHouse();
  house.route('UPGRADE', '/kit/stream', () =>
    openings(house) === 1 ? { status: 503, body: { error: { code: 'stream_unavailable' } } } : {},
  );
  await resident(house);

  await until(() => house.sockets[0]);
  expect(openings(house)).toBe(2);
});

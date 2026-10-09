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
  house.route('UPGRADE', '/kit/stream', () => ({ status: 401, body: { error: { code: 'token_rejected', retryable: false } } }));
  const kit = await resident(house);

  expect(await ended(kit)).toBe(0);
  expect(kit.stderr()).toContain('kit: sign in again\n');
  expect(house.sockets).toEqual([]);
});

it('ends, left stopped, asking to sign in again when House refuses any of its calls with 401', async () => {
  const house = await startHouse();
  house.route('POST', '/kit/restarted', () => ({ status: 401, body: { error: { code: 'token_rejected', retryable: false } } }));
  const kit = await resident(house);

  expect(await ended(kit)).toBe(0);
  expect(kit.stderr()).toContain('kit: sign in again\n');
  expect(openings(house)).toBe(0);
});

function delivered(house: House, path: string): number {
  return house.requests.filter((request) => request.path === path).length;
}

it('delivers again a delivery House refuses with a refusal it marks retryable, whatever its status, until House takes it', async () => {
  const house = await startHouse();
  house.route('POST', '/kit/restarted', () =>
    delivered(house, '/kit/restarted') < 3
      ? { status: 429, body: { error: { code: 'rate_limited', retry_after: 1, retry_at: '2026-10-09T00:00:01.000Z', retryable: true } } }
      : {},
  );
  await resident(house);

  await until(() => house.sockets[0]);
  expect(delivered(house, '/kit/restarted')).toBe(3);
});

it('returns a delivery House refuses with a 500 it does not mark retryable at once to the work that sent it', async () => {
  const house = await startHouse();
  house.route('POST', '/kit/restarted', () => ({ status: 500, body: { error: { code: 'sync_failed', retryable: false } } }));
  const kit = await resident(house);

  await until(() => house.sockets[0]);
  expect(delivered(house, '/kit/restarted')).toBe(1);
  expect(kit.stderr()).toContain('kit: House refused /kit/restarted with 500: {"error":{"code":"sync_failed","retryable":false}}\n');
  expect(kit.stderr()).not.toContain('did not reach House');
});

it('delivers again a delivery that gets no answer', async () => {
  const house = await startHouse();
  house.route('POST', '/kit/restarted', () => (delivered(house, '/kit/restarted') === 1 ? { drop: true } : {}));
  await resident(house);

  await until(() => house.sockets[0]);
  expect(delivered(house, '/kit/restarted')).toBe(2);
});

it.each([
  ['JSON without an error', { status: 503, body: { message: 'Service Unavailable' } }],
  ['an error that is no House refusal', { status: 502, body: { error: 'Bad Gateway' } }],
])('delivers again a delivery whose answer is no House answer, such as %s', async (_, answer) => {
  const house = await startHouse();
  house.route('POST', '/kit/restarted', () => (delivered(house, '/kit/restarted') === 1 ? answer : {}));
  await resident(house);

  await until(() => house.sockets[0]);
  expect(delivered(house, '/kit/restarted')).toBe(2);
});

it.each([
  [429, 'sockets_per_user_exceeded'],
  [500, 'stream_unavailable'],
])('ends, left stopped, naming the refusal when House refuses its socket opening with a %i it does not mark retryable', async (status, code) => {
  const house = await startHouse();
  house.route('UPGRADE', '/kit/stream', () => ({ status, body: { error: { code, retryable: false } } }));
  const kit = await resident(house);

  expect(await ended(kit)).toBe(0);
  expect(kit.stderr()).toContain(`kit: House refused /kit/stream with ${status}: {"error":{"code":"${code}","retryable":false}}\n`);
  expect(openings(house)).toBe(1);
});

it('opens its socket again after House refuses its opening with a refusal it marks retryable, whatever its status', async () => {
  const house = await startHouse();
  house.route('UPGRADE', '/kit/stream', () =>
    openings(house) === 1
      ? { status: 429, body: { error: { code: 'rate_limited', retry_after: 1, retry_at: '2026-10-09T00:00:01.000Z', retryable: true } } }
      : {},
  );
  await resident(house);

  await until(() => house.sockets[0]);
  expect(openings(house)).toBe(2);
});

it('opens its socket again after an answer to its opening that carries no House refusal', async () => {
  const house = await startHouse();
  house.route('UPGRADE', '/kit/stream', () => (openings(house) === 1 ? { status: 502 } : {}));
  await resident(house);

  await until(() => house.sockets[0]);
  expect(openings(house)).toBe(2);
});

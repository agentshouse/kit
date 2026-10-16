import { access, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { settle, startHouse, until, type House } from './double.ts';
import { runKit, stop, temporaryHome, type KitRun } from './kit.ts';
import { logIn, serveLogin } from './login.ts';

const RACING_LOGIN = fileURLToPath(new URL('./racing-login.ts', import.meta.url));
const FAST_TIMEOUTS = fileURLToPath(new URL('./fast-timeouts.ts', import.meta.url));
const PAUSED_SOCKET_REMOVAL = fileURLToPath(new URL('./paused-socket-removal.ts', import.meta.url));

async function enrol(house: House, home: string, credential: string) {
  await writeFile(
    join(home, 'credential.json'),
    JSON.stringify({ house: house.origin, environment: 'environment-one', credential }),
  );
}

async function resident(house: House, home?: string): Promise<KitRun> {
  home ??= await temporaryHome();
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

it('drops a silent control stream after two House beats and reconnects it', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await enrol(house, home, 'ahk_held');
  runKit(['resident'], { HOUSE_KIT_HOME: home }, ['--import', FAST_TIMEOUTS]);

  const first = await until(() => house.sockets[0]);
  const second = await until(() => house.sockets[1]);
  expect(second).not.toBe(first);
  expect(second.headers.authorization).toBe('Bearer ahk_held');
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

it('refuses a second resident of a Kit home whose Kit runs, naming that Kit and how to take over, and leaves that Kit holding the Environment', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const first = await resident(house, home);
  await until(() => house.sockets[0]);

  const second = runKit(['resident'], { HOUSE_KIT_HOME: home });

  expect(await ended(second)).toBe(1);
  expect(second.stderr()).toBe(`kit: Kit ${first.pid} already runs this Environment from Kit home ${home}; stop it first to run another here\n`);
  await settle();
  expect(openings(house)).toBe(1);
  const third = runKit(['resident'], { HOUSE_KIT_HOME: home });
  expect(await ended(third)).toBe(1);
  expect(third.stderr()).toContain(`kit: Kit ${first.pid} already runs`);
});

it('refuses a second resident while the first waits for a login, and leaves the first holding the Environment once it connects', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const first = runKit(['resident'], { HOUSE_KIT_HOME: home });
  await until(() => first.stderr().includes('run kit login'));

  const second = runKit(['resident'], { HOUSE_KIT_HOME: home });

  expect(await ended(second)).toBe(1);
  expect(second.stderr()).toBe(`kit: Kit ${first.pid} already runs this Environment from Kit home ${home}; stop it first to run another here\n`);
  await enrol(house, home, 'ahk_held');
  await until(() => house.sockets[0]);
  await settle();
  expect(openings(house)).toBe(1);
});

it('refuses a second resident that starts while the first removes the socket a killed Kit left, and leaves the first holding the Environment', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const killed = runKit(['resident'], { HOUSE_KIT_HOME: home });
  await until(() => killed.stderr().includes('run kit login'));
  stop(killed.pid);
  await killed.exited;
  const first = runKit(['resident'], { HOUSE_KIT_HOME: home }, ['--import', PAUSED_SOCKET_REMOVAL]);
  await until(() => first.stderr().includes('kit-test: removing the owner socket'));

  const second = runKit(['resident'], { HOUSE_KIT_HOME: home });

  expect(await ended(second)).toBe(1);
  expect(second.stderr()).toBe(`kit: another Kit already runs this Environment from Kit home ${home}; stop it first to run another here\n`);
  first.input.write('\n');
  await until(() => first.stderr().includes('run kit login'));
  await enrol(house, home, 'ahk_held');
  await until(() => house.sockets[0]);
  await settle();
  expect(openings(house)).toBe(1);
});

it('refuses a second resident that reaches the running Kit home through a symbolic link', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const first = await resident(house, home);
  await until(() => house.sockets[0]);
  const alias = join(await temporaryHome(), 'alias');
  await symlink(home, alias);

  const second = runKit(['resident'], { HOUSE_KIT_HOME: alias });

  expect(await ended(second)).toBe(1);
  expect(second.stderr()).toBe(`kit: Kit ${first.pid} already runs this Environment from Kit home ${alias}; stop it first to run another here\n`);
  await settle();
  expect(openings(house)).toBe(1);
});

it('waits for a login on a Kit home that does not exist yet, and connects once a login enrols it', async () => {
  const house = await startHouse();
  const home = join(await temporaryHome(), 'home');
  const kit = runKit(['resident'], { HOUSE_KIT_HOME: home });
  await until(() => kit.stderr().includes('run kit login'));

  await enrol(house, home, 'ahk_held');

  expect((await until(() => house.sockets[0])).headers.authorization).toBe('Bearer ahk_held');
});

it('ends with a failure when a start step after its claim fails, and leaves the Environment to the next resident', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await enrol(house, home, 'ahk_held');
  const workspace = join(home, 'workspace');
  await writeFile(workspace, '');
  const failed = runKit(['resident'], { HOUSE_KIT_HOME: home, HOUSE_KIT_WORKSPACE: workspace });

  expect(await ended(failed)).toBe(1);
  expect(failed.stderr()).toBe(`kit: ENOTDIR: not a directory, mkdir '${join(workspace, 'agents')}'\n`);
  runKit(['resident'], { HOUSE_KIT_HOME: home });
  await until(() => house.sockets[0]);
  await settle();
  expect(openings(house)).toBe(1);
});

async function forgotten(house: House, home: string): Promise<void> {
  await expect(access(join(home, 'credential.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(join(home, 'disconnected.json'), 'utf8'))).toEqual({ house: house.origin, environment: 'environment-one' });
}

it('forgets its credential and ends with a failure its service restarts when House closes its socket for a rejected credential, and the restarted one waits for a login that reconnects its Environment', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const kit = await resident(house, home);

  (await until(() => house.sockets[0])).close(1008, 'credential_rejected');

  expect(await ended(kit)).toBe(1);
  expect(kit.stderr()).toContain('kit: sign in again\n');
  expect(openings(house)).toBe(1);
  await forgotten(house, home);
  const restarted = runKit(['resident'], { HOUSE_KIT_HOME: home });
  await until(() => restarted.stderr().includes('run kit login'));
  serveLogin(house, 'environment-one', 'ahk_second');
  const { started, exit } = await logIn(house, home);
  expect(exit).toBe(0);
  expect(started).toMatchObject({ act: 'existing_environment', environment_id: 'environment-one' });
  expect((await until(() => house.sockets[1])).headers.authorization).toBe('Bearer ahk_second');
});

it('forgets its credential and ends with a failure its service restarts when House refuses its socket opening with 401', async () => {
  const house = await startHouse();
  house.route('UPGRADE', '/kit/stream', () => ({ status: 401, body: { error: { code: 'token_rejected', retryable: false } } }));
  const home = await temporaryHome();
  const kit = await resident(house, home);

  expect(await ended(kit)).toBe(1);
  expect(kit.stderr()).toContain('kit: sign in again\n');
  expect(house.sockets).toEqual([]);
  await forgotten(house, home);
});

it('forgets its credential and ends with a failure its service restarts when House refuses any of its calls with 401', async () => {
  const house = await startHouse();
  house.route('POST', '/kit/restarted', () => ({ status: 401, body: { error: { code: 'token_rejected', retryable: false } } }));
  const home = await temporaryHome();
  const kit = await resident(house, home);

  expect(await ended(kit)).toBe(1);
  expect(kit.stderr()).toContain('kit: sign in again\n');
  expect(openings(house)).toBe(0);
  await forgotten(house, home);
});

it('keeps the credential a later login stored when House rejects the one it held', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const kit = await resident(house, home);
  const socket = await until(() => house.sockets[0]);
  await enrol(house, home, 'ahk_second');

  socket.close(1008, 'credential_rejected');

  expect(await ended(kit)).toBe(1);
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toMatchObject({ credential: 'ahk_second' });
});

it('keeps the credential a login stores while it forgets the rejected one', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await enrol(house, home, 'ahk_held');
  const kit = runKit(['resident'], { HOUSE_KIT_HOME: home, KIT_RACING_CREDENTIAL: 'ahk_second' }, ['--import', RACING_LOGIN]);

  (await until(() => house.sockets[0])).close(1008, 'credential_rejected');

  expect(await ended(kit)).toBe(1);
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toMatchObject({ credential: 'ahk_second' });
  await expect(access(join(home, 'disconnected.json'))).rejects.toMatchObject({ code: 'ENOENT' });
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

const TOO_OLD = { status: 426, body: { error: { code: 'kit_update_required', retryable: false } } };

it('names its wire in its stream subprotocol and in a header on every other /kit/ request', async () => {
  const house = await startHouse();
  await resident(house);

  expect((await until(() => house.sockets[0])).protocol).toBe('house.kit.stream.1');
  const requests = house.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/kit/'));
  expect(requests.map((request) => request.path)).toContain('/kit/restarted');
  expect(requests.map((request) => request.headers['x-house-kit-wire'])).toEqual(requests.map(() => '1'));
});

it('ends, left stopped, saying it must be installed again, when House refuses its socket opening as too old and no bootstrap recorded its install command', async () => {
  const house = await startHouse();
  house.route('UPGRADE', '/kit/stream', () => TOO_OLD);
  const kit = await resident(house);

  expect(await ended(kit)).toBe(0);
  expect(kit.stderr()).toContain('kit: This Kit is too old for House; install it again.\n');
  expect(openings(house)).toBe(1);
});

it('ends, left stopped, naming the install command its bootstrap recorded even outside its service, when House refuses any of its calls as too old', async () => {
  const house = await startHouse();
  house.route('POST', '/kit/restarted', () => TOO_OLD);
  const home = await temporaryHome();
  const command = `HOUSE_KIT_RELAY=https://relay.example sh -c 'kit=$(curl -fsSL "$0") || exit 1; eval "$kit"' https://relay.example/dev.agents.house/kit --linux`;
  await writeFile(join(home, 'install-command'), `${command}\n`);
  const kit = await resident(house, home);

  expect(await ended(kit)).toBe(0);
  expect(kit.stderr()).toContain(`kit: This Kit is too old for House. Update it: ${command}\n`);
  expect(openings(house)).toBe(0);
});

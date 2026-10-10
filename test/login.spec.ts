import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, until } from './double.ts';
import { runKit, temporaryHome } from './kit.ts';
import { answerOwnAgent, LOGIN, logIn, loginLink, opener, ownAgent, serveLogin } from './login.ts';

it('prints the link, opens it with the host opener, waits for the confirmation and stores the credential, reading nothing from standard input', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const served = serveLogin(house, 'environment-one', 'ahk_first', { waiting: true });
  const { path, opened } = await opener(home);

  const login = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home, PATH: path });
  await until(() => house.requests.some((request) => request.path === '/kit/token'));
  served.confirm();

  expect(await login.exited).toBe(0);
  expect(login.stdout()).toContain(`Open this link and confirm: ${loginLink(house)}\n`);
  expect(await until(opened)).toBe(`${loginLink(house)}\n`);
  const started = house.requests.find((request) => request.path === '/kit')!.body;
  expect(started).toMatchObject({ act: 'new_environment', code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  expect(typeof (started as { label: unknown }).label).toBe('string');
  expect(started).not.toHaveProperty('environment_id');
  expect(started).not.toHaveProperty('presentation');
  expect(started).not.toHaveProperty('loopback_uri');
  const polls = house.requests.filter((request) => request.path === '/kit/token').map((request) => request.body);
  expect(polls.length).toBeGreaterThan(1);
  expect(new Set(polls.map((poll) => JSON.stringify(poll))).size).toBe(1);
  expect(polls[0]).toEqual({ login: LOGIN, code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    environment: 'environment-one',
    credential: 'ahk_first',
  });
});

it.each([
  ['no browser opener', false],
  ['a browser opener that fails', true],
])('prints the link with %s and completes once the login is confirmed elsewhere', async (_name, fails) => {
  const house = await startHouse();
  const home = await temporaryHome();
  const served = serveLogin(house, 'environment-one', 'ahk_first', { waiting: true });
  const environment = { HOUSE_KIT_HOME: home, PATH: fails ? (await opener(home, true)).path : join(home, 'empty') };

  const login = runKit(['login', '--house', house.origin], environment);
  await until(() => login.stdout().includes(loginLink(house)) && house.requests.some((request) => request.path === '/kit/token'));
  served.confirm();

  expect(await login.exited).toBe(0);
  expect(login.stdout()).toContain(`Open this link and confirm: ${loginLink(house)}\n`);
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toMatchObject({ credential: 'ahk_first' });
});

it('ends with the cause and no credential when the waiting login expires', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const served = serveLogin(house, 'environment-one', 'ahk_first', { waiting: true });

  const login = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home });
  await until(() => house.requests.some((request) => request.path === '/kit/token'));
  served.end();

  expect(await login.exited).toBe(1);
  expect(login.stderr()).toContain('kit_login_rejected');
  await expect(access(join(home, 'credential.json'))).rejects.toThrow();
});

it('ends with the cause and no credential when House refuses the exchange', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  house.route('POST', '/kit/token', () => ({ status: 400, body: { error: { code: 'kit_login_rejected', retryable: false } } }));

  const { exit, login } = await logIn(house, home);

  expect(exit).toBe(1);
  expect(login.stderr()).toContain('kit_login_rejected');
  expect(house.requests.filter((request) => request.path === '/kit/token')).toHaveLength(1);
  await expect(access(join(home, 'credential.json'))).rejects.toThrow();
});

it('refuses --manual as an unknown option before starting a login', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');

  const login = runKit(['login', '--house', house.origin, '--manual'], { HOUSE_KIT_HOME: home });

  expect(await login.exited).toBe(1);
  expect(login.stderr()).toContain("Unknown option '--manual'");
  expect(house.requests).toEqual([]);
});

it('reconnects the same Environment on a second login', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  await logIn(house, home);
  serveLogin(house, 'environment-one', 'ahk_second');

  const { started, exit } = await logIn(house, home);

  expect(exit).toBe(0);
  expect(started).toMatchObject({ act: 'existing_environment', environment_id: 'environment-one' });
  expect(started).not.toHaveProperty('label');
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    environment: 'environment-one',
    credential: 'ahk_second',
  });
});

it('enrols a new Environment naming the stored one it replaces, and keeps only the new enrolment', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  await logIn(house, home);
  serveLogin(house, 'environment-two', 'ahk_second');

  const { started, exit } = await logIn(house, home, { HOUSE_KIT_REPLACES: 'environment-one' });

  expect(exit).toBe(0);
  expect(started).toMatchObject({ act: 'new_environment', replaces: 'environment-one', label: expect.any(String) });
  expect(started).not.toHaveProperty('environment_id');
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    environment: 'environment-two',
    credential: 'ahk_second',
  });
});

it('starts the login again while House answers its start as retryable', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first', { busy: 2 });

  const { exit } = await logIn(house, home);

  expect(exit).toBe(0);
  expect(house.requests.filter((request) => request.path === '/kit')).toHaveLength(3);
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toMatchObject({ credential: 'ahk_first' });
});

it('ends with the cause when House refuses to start the login', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  house.route('POST', '/kit', () => ({ status: 404, body: { error: { code: 'kit_environment_not_found', retryable: false } } }));

  const login = runKit(['login', '--house', house.origin, '--environment', 'environment-gone'], {
    HOUSE_KIT_HOME: home,
  });

  expect(await login.exited).toBe(1);
  expect(login.stderr()).toContain('kit_environment_not_found');
});

it("asks for the User's own agent's connection when Kit holds none and keeps it owner-only beside the Kit credential", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first', { own: 'ahp_own' });

  const { started, exit } = await logIn(house, home);

  expect(exit).toBe(0);
  expect(started.headless).toBe(true);
  expect(await ownAgent(home)).toEqual({ house: house.origin, user: 'user-one', credential: 'ahp_own' });
  expect((await stat(join(home, 'own-agent.json'))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toMatchObject({ credential: 'ahk_first' });
});

it("asks for no connection while House accepts the User's own agent's one Kit holds", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const held = { house: house.origin, user: 'user-one', credential: 'ahp_live' };
  await writeFile(join(home, 'own-agent.json'), JSON.stringify(held));
  answerOwnAgent(house, 'ahp_live');
  serveLogin(house, 'environment-one', 'ahk_first');

  const { started, exit } = await logIn(house, home);

  expect(exit).toBe(0);
  expect(started).not.toHaveProperty('headless');
  expect(await ownAgent(home)).toEqual(held);
});

it("asks again when House answers the User's own agent's connection as revoked, and keeps the new one", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: house.origin, user: 'user-one', credential: 'ahp_revoked' }));
  answerOwnAgent(house, 'ahp_other');
  serveLogin(house, 'environment-one', 'ahk_first', { own: 'ahp_new' });

  const { started, exit } = await logIn(house, home);

  expect(exit).toBe(0);
  expect(started.headless).toBe(true);
  expect(await ownAgent(home)).toEqual({ house: house.origin, user: 'user-one', credential: 'ahp_new' });
});

it("never sends the User's own agent's connection to another House, and asks that House for one of its own", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: 'https://elsewhere.example', user: 'user-one', credential: 'ahp_elsewhere' }));
  serveLogin(house, 'environment-one', 'ahk_first', { own: 'ahp_here' });

  const { started, exit } = await logIn(house, home);

  expect(exit).toBe(0);
  expect(started.headless).toBe(true);
  expect(JSON.stringify(house.requests.map((request) => request.headers))).not.toContain('ahp_elsewhere');
  expect(await ownAgent(home)).toEqual({ house: house.origin, user: 'user-one', credential: 'ahp_here' });
});

it("drops the User's own agent's connection when another User confirms the login, and says to log in again", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: house.origin, user: 'user-two', credential: 'ahp_two' }));
  answerOwnAgent(house, 'ahp_two');
  serveLogin(house, 'environment-one', 'ahk_first');

  const { exit, login } = await logIn(house, home);

  expect(exit).toBe(0);
  expect(login.stdout()).toMatch(/kit login/);
  await expect(access(join(home, 'own-agent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it("stops with House's answer when House cannot say whether the User's own agent's connection still stands", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: house.origin, user: 'user-one', credential: 'ahp_held' }));
  house.route('POST', '/', () => ({ status: 503, body: { error: { code: 'house_unavailable' } } }));
  serveLogin(house, 'environment-one', 'ahk_first');

  const login = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home });

  expect(await login.exited).toBe(1);
  expect(login.stderr()).toContain('503');
  expect(house.requests.map((request) => request.path)).toEqual(['/']);
});

it('logs out by revoking and deleting the credential and stopping the resident, and a later login reconnects the same Environment', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  await logIn(house, home);
  const resident = runKit(['resident'], { HOUSE_KIT_HOME: home });
  await until(() => house.sockets[0]);
  house.route('POST', '/kit/logout', () => ({ body: {} }));
  house.requests.length = 0;

  const logout = runKit(['logout'], { HOUSE_KIT_HOME: home });

  expect(await logout.exited).toBe(0);
  expect(logout.stdout()).toBe('Environment environment-one is disconnected; kit login reconnects it.\n');
  expect(house.requests.filter((request) => request.path === '/kit/logout').map((request) => request.headers.authorization)).toEqual([
    'Bearer ahk_first',
  ]);
  await expect(access(join(home, 'credential.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await resident.exited).toBe(1);
  const restarted = runKit(['resident'], { HOUSE_KIT_HOME: home });
  await until(() => restarted.stderr().includes('run kit login'));
  expect(house.sockets).toHaveLength(1);

  serveLogin(house, 'environment-one', 'ahk_second');
  const { started, exit } = await logIn(house, home);

  expect(exit).toBe(0);
  expect(started).toMatchObject({ act: 'existing_environment', environment_id: 'environment-one' });
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    environment: 'environment-one',
    credential: 'ahk_second',
  });
  await expect(access(join(home, 'disconnected.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const reconnected = await until(() => house.sockets[1]);
  expect(reconnected.headers.authorization).toBe('Bearer ahk_second');
});

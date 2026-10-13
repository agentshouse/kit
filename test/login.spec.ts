import { access, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { certificate, startHouse, until, type House } from './double.ts';
import { LOGIN_SHELL } from './environment.ts';
import { readOnlyHome, runKit, temporaryHome } from './kit.ts';
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
  expect(started).not.toHaveProperty('rooms');
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

it('redeems a login code once with the machine label, stores both credentials and prints no link', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  house.route('POST', '/kit/token', () => ({
    body: {
      credential: 'ahk_code_credential',
      environment: 'environment-one',
      user: 'user-one',
      headless_credential: 'ahp_code_credential',
    },
  }));

  const login = runKit(['login', '--house', house.origin, '--code', 'ahk_code_one'], {
    HOUSE_KIT_HOME: home,
  });

  expect(await login.exited).toBe(0);
  expect(login.stdout()).toBe(`Environment environment-one is connected to ${house.origin}.\n`);
  expect(house.requests.map((request) => [request.path, request.body])).toEqual([['/kit/token', { code: 'ahk_code_one', label: expect.any(String) }]]);
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    environment: 'environment-one',
    credential: 'ahk_code_credential',
  });
  expect(await ownAgent(home)).toEqual({
    house: house.origin,
    user: 'user-one',
    credential: 'ahp_code_credential',
  });
});

it('connects from a read-only home with its Kit home under the temporary directory, naming the skills, the Codex rule and the Git helper it could not place', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const { temporary, kitHome } = await readOnlyHome(home);
  house.route('POST', '/kit/token', () => ({
    body: { credential: 'ahk_code_credential', environment: 'environment-one', user: 'user-one', headless_credential: 'ahp_code_credential' },
  }));

  const login = runKit(['login', '--house', house.origin, '--code', 'ahk_code_one'], { HOME: home, TMPDIR: temporary, CODEX_HOME: '', ...LOGIN_SHELL });

  expect(await login.exited).toBe(0);
  expect(login.stdout()).toBe(`Environment environment-one is connected to ${house.origin}.\n`);
  expect(login.stderr().split('\n')).toEqual([
    expect.stringMatching(/^kit: the skills could not be placed: EACCES: /),
    expect.stringMatching(/^kit: Codex's rule for house could not be written: EACCES: /),
    expect.stringMatching(/^kit: git config failed: .*\.gitconfig/),
    '',
  ]);
  expect(JSON.parse(await readFile(join(kitHome, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    environment: 'environment-one',
    credential: 'ahk_code_credential',
  });
  expect(await ownAgent(kitHome)).toEqual({ house: house.origin, user: 'user-one', credential: 'ahp_code_credential' });
});

async function placeHouse(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'house'), '#!/bin/sh\n', { mode: 0o755 });
  return join(directory, 'house');
}

function codexRule(houses: string[]): string {
  return `prefix_rule(pattern = ["house"], decision = "allow")\nhost_executable(name = "house", paths = ${JSON.stringify(houses)})\n`;
}

it("writes Codex's rule for a lone house at a login by code from a Kit home of its own, naming each house on the caller's and the login shell's PATH", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const onPath = await placeHouse(join(home, 'bin'));
  const inUserBin = await placeHouse(join(home, '.local', 'bin'));
  house.route('POST', '/kit/token', () => ({ body: { credential: 'ahk_code_credential', environment: 'environment-one', user: 'user-one' } }));

  const login = runKit(['login', '--house', house.origin, '--code', 'ahk_code_one'], {
    HOUSE_KIT_HOME: join(home, '.house-kit-own'),
    HOME: home,
    CODEX_HOME: '',
    PATH: `${join(home, 'bin')}:${join(home, 'empty')}`,
    ...LOGIN_SHELL,
  });

  expect(await login.exited).toBe(0);
  expect(await readFile(join(home, '.codex', 'rules', 'house.rules'), 'utf8')).toBe(codexRule([onPath, inUserBin]));
});

it("keeps each house another Kit home's Codex rule names and drops one that is gone when a login writes the rule", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const onPath = await placeHouse(join(home, 'bin'));
  const otherKit = await placeHouse(join(home, 'other-kit', 'bin'));
  await mkdir(join(home, '.codex', 'rules'), { recursive: true });
  await writeFile(join(home, '.codex', 'rules', 'house.rules'), codexRule([otherKit, join(home, 'gone', 'house')]));
  serveLogin(house, 'environment-one', 'ahk_first');

  const { exit } = await logIn(house, join(home, '.house-kit-own'), {
    HOME: home,
    CODEX_HOME: '',
    PATH: `${join(home, 'bin')}:${join(home, 'empty')}`,
    ...LOGIN_SHELL,
  });

  expect(exit).toBe(0);
  expect(await readFile(join(home, '.codex', 'rules', 'house.rules'), 'utf8')).toBe(codexRule([otherKit, onPath]));
});

it.each(['kit_code_used', 'kit_code_cancelled', 'kit_code_expired'])("ends with House's %s refusal after one login-code exchange", async (cause) => {
  const house = await startHouse();
  const home = await temporaryHome();
  house.route('POST', '/kit/token', () => ({
    status: 400,
    body: { error: { code: cause, retryable: false } },
  }));

  const login = runKit(['login', '--house', house.origin, '--code', 'ahk_code_one'], {
    HOUSE_KIT_HOME: home,
  });

  expect(await login.exited).toBe(1);
  expect(login.stderr()).toContain(cause);
  expect(house.requests.map((request) => request.path)).toEqual(['/kit/token']);
  await expect(access(join(home, 'credential.json'))).rejects.toThrow();
});

it('records the login-code relay and the resident uses it without an ambient variable', async () => {
  const house = await startHouse();
  const tls = certificate();
  const prefix = `/${new URL(house.origin).host}`;
  const relay = await startHouse(tls, `${prefix}/kit/stream`);
  const home = await temporaryHome();
  relay.route('POST', `${prefix}/kit/token`, () => ({
    body: {
      credential: 'ahk_code_credential',
      environment: 'environment-one',
      user: 'user-one',
      headless_credential: 'ahp_code_credential',
    },
  }));

  const login = runKit(['login', '--house', house.origin, '--code', 'ahk_code_one'], {
    HOUSE_KIT_HOME: home,
    HOUSE_KIT_RELAY: relay.origin,
    NODE_EXTRA_CA_CERTS: tls.path,
  });

  expect(await login.exited).toBe(0);
  expect(house.requests).toEqual([]);
  expect(relay.requests.map((request) => request.path)).toEqual([`${prefix}/kit/token`]);
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    relay: relay.origin,
    environment: 'environment-one',
    credential: 'ahk_code_credential',
  });

  relay.route('POST', `${prefix}/kit/restarted`, () => ({ body: {} }));
  relay.route('POST', `${prefix}/kit/agents/desired`, () => ({
    body: { agents: [], routes: [], transcribe: false },
  }));
  runKit(['resident'], { HOUSE_KIT_HOME: home, NODE_EXTRA_CA_CERTS: tls.path });

  const socket = await until(() => relay.sockets[0]);
  expect(socket.headers.authorization).toBe('Bearer ahk_code_credential');
  expect(relay.requests.map((request) => request.path)).toContain(`${prefix}/kit/restarted`);
  expect(relay.requests.map((request) => request.path)).toContain(`${prefix}/kit/stream`);
  expect(house.requests).toEqual([]);
});

it('clears a recorded relay when a later bare login has no relay variable', async () => {
  const house = await startHouse();
  const tls = certificate();
  const prefix = `/${new URL(house.origin).host}`;
  const relay = await startHouse(tls);
  const home = await temporaryHome();
  relay.route('POST', `${prefix}/kit/token`, () => ({
    body: {
      credential: 'ahk_code_credential',
      environment: 'environment-one',
      user: 'user-one',
      headless_credential: 'ahp_code_credential',
    },
  }));
  const coded = runKit(['login', '--house', house.origin, '--code', 'ahk_code_one'], {
    HOUSE_KIT_HOME: home,
    HOUSE_KIT_RELAY: relay.origin,
    NODE_EXTRA_CA_CERTS: tls.path,
  });
  expect(await coded.exited).toBe(0);
  const relayedRequests = relay.requests.length;
  answerOwnAgent(house, 'ahp_code_credential');
  serveLogin(house, 'environment-one', 'ahk_direct');

  const bare = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home });

  expect(await bare.exited).toBe(0);
  expect(relay.requests).toHaveLength(relayedRequests);
  expect(house.requests.map((request) => request.path)).toEqual(['/', '/kit', '/kit/token']);
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    environment: 'environment-one',
    credential: 'ahk_direct',
  });
});

it.each([
  [['--code', 'ahk_code_one', '--rooms', 'r_k2v.4'], '--code cannot be used with --rooms'],
  [['--code', 'ahk_code_one', '--no-private'], '--code cannot be used with --no-private'],
  [['--code', 'ahk_code_one', '--environment', 'environment-one'], '--code cannot be used with --environment'],
])('refuses %j before sending any request', async (argv, reason) => {
  const house = await startHouse();
  const home = await temporaryHome();

  const login = runKit(['login', '--house', house.origin, ...argv], { HOUSE_KIT_HOME: home });

  expect(await login.exited).toBe(1);
  expect(login.stderr()).toBe(`kit: ${reason}\n`);
  expect(house.requests).toEqual([]);
});

it.each(['credential.json', 'disconnected.json'])('refuses a login code when Kit home records an Environment in %s', async (record) => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(
    join(home, record),
    JSON.stringify({
      house: house.origin,
      environment: 'environment-one',
      credential: 'ahk_held',
    }),
  );

  const login = runKit(['login', '--house', house.origin, '--code', 'ahk_code_one'], {
    HOUSE_KIT_HOME: home,
  });

  expect(await login.exited).toBe(1);
  expect(login.stderr()).toBe('kit: --code connects a new machine; this Kit home records Environment environment-one, so run kit login to reconnect it\n');
  expect(house.requests).toEqual([]);
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

it.each([
  ['--rooms with their references', ['--rooms', 'r_k2v.4,r_9qd.x'], { reach: 'selected', refs: ['r_k2v.4', 'r_9qd.x'] }],
  ['--no-private with every Room but the Private Room', ['--no-private'], { reach: 'all_but_private' }],
])('gives a new Environment the Rooms of %s', async (_name, argv, rooms) => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');

  const { started, exit } = await logIn(house, home, {}, argv);

  expect(exit).toBe(0);
  expect(started).toMatchObject({ act: 'new_environment', rooms });
});

it('refuses --rooms beside --no-private before starting a login', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');

  const login = runKit(['login', '--house', house.origin, '--rooms', 'r_k2v.4', '--no-private'], { HOUSE_KIT_HOME: home });

  expect(await login.exited).toBe(1);
  expect(login.stderr()).toBe('kit: --rooms and --no-private are two choices of Rooms; pass one\n');
  expect(house.requests).toEqual([]);
});

it.each([
  ['--rooms', ['--rooms', 'r_k2v.4'], { reach: 'selected', refs: ['r_k2v.4'] }],
  ['--no-private', ['--no-private'], { reach: 'all_but_private' }],
])('sets the Rooms again on a reconnect with %s, and a plain reconnect names none', async (_name, argv, rooms) => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  await logIn(house, home);

  serveLogin(house, 'environment-one', 'ahk_second');
  const chosen = await logIn(house, home, {}, argv);
  serveLogin(house, 'environment-one', 'ahk_third');
  const plain = await logIn(house, home);

  expect([chosen.exit, plain.exit]).toEqual([0, 0]);
  expect(chosen.started).toMatchObject({
    act: 'existing_environment',
    environment_id: 'environment-one',
    rooms,
  });
  expect(plain.started).toMatchObject({ act: 'existing_environment', environment_id: 'environment-one' });
  expect(plain.started).not.toHaveProperty('rooms');
});

it('ends with the cause and no credential when House refuses a Room the login names', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  house.route('POST', '/kit/token', () => ({
    status: 404,
    body: { error: { code: 'room_not_found', retryable: false, room_ref: 'r_gone' } },
  }));

  const { exit, login } = await logIn(house, home, {}, ['--rooms', 'r_gone']);

  expect(exit).toBe(1);
  expect(login.stderr()).toContain('room_not_found');
  expect(login.stderr()).toContain('r_gone');
  await expect(access(join(home, 'credential.json'))).rejects.toThrow();
});

it('names --code, --rooms and --no-private in kit login --help, --code in a form apart from the other choices, and starts no login', async () => {
  const house = await startHouse();
  const home = await temporaryHome();

  const login = runKit(['login', '--house', house.origin, '--help'], { HOUSE_KIT_HOME: home });

  expect(await login.exited).toBe(0);
  expect(login.stdout()).toMatch(/^ +--code <code> +\S/m);
  expect(login.stdout()).toMatch(/^ +--rooms <ref>\[,<ref>\.\.\.\] +\S/m);
  expect(login.stdout()).toMatch(/^ +--no-private +\S/m);
  const forms = login.stdout().split('\n').filter((line) => line.includes('kit login'));
  expect(forms).toContainEqual(expect.stringMatching(/kit login \[--house <origin>\] --code <code>$/));
  expect(forms.filter((form) => form.includes('--code') && /--environment|--rooms|--no-private/.test(form))).toEqual([]);
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
  expect(typeof started.label).toBe('string');
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

const MACOS = ['--import', fileURLToPath(new URL('./darwin.ts', import.meta.url))];
const UID = process.getuid!();

const SYSTEMD = (scope: string, running: boolean) => `case "$1" in --user) held=user; shift ;; *) held=system ;; esac
[ "$held" = ${scope} ] || exit 1
case "$1" in
  is-enabled) ;;
  is-active) ${running ? 'exit 0' : 'exit 3'} ;;
  start) ;;
  *) exit 1 ;;
esac
`;

const LAUNCHD = (running: boolean) => `case "$1" in
  print) printf 'gui/%s/house-kit = {\\n\\tactive count = 0\\n\\tstate = ${running ? 'running' : 'not running'}\\n\\n\\tprogram = kit\\n}\\n' "$(id -u)" ;;
  kickstart) ;;
  *) exit 1 ;;
esac
`;

async function serviceManager(home: string, tool: string, script: string): Promise<{ path: string; starts: () => Promise<string[]> }> {
  const bin = join(home, 'manager');
  await mkdir(bin);
  const log = join(home, 'manager.log');
  await writeFile(join(bin, tool), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${script}`);
  await chmod(join(bin, tool), 0o755);
  const starts = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter((call) => /^(--user )?(start|kickstart) /.test(call));
  return { path: `${bin}:${process.env.PATH}`, starts };
}

async function loginWithCode(house: House, home: string, path: string, node: string[] = []) {
  house.route('POST', '/kit/token', () => ({ body: { credential: 'ahk_code_credential', environment: 'environment-one', user: 'user-one' } }));
  return runKit(['login', '--house', house.origin, '--code', 'ahk_code_one'], { HOUSE_KIT_HOME: home, PATH: path }, node);
}

it.each([
  ['systemd user service on Linux', 'systemctl', SYSTEMD('user', false), [], ['--user start house-kit.service']],
  ["server's systemd service", 'systemctl', SYSTEMD('system', false), [], ['start house-kit.service']],
  ['LaunchAgent on macOS', 'launchctl', LAUNCHD(false), MACOS, [`kickstart gui/${UID}/house-kit`]],
] as const)('starts the loaded %s that is not running once it stores the credential', async (_name, tool, script, node, started) => {
  const house = await startHouse();
  const home = await temporaryHome();
  const { path, starts } = await serviceManager(home, tool, script);

  const login = await loginWithCode(house, home, path, [...node]);

  expect(await login.exited).toBe(0);
  expect(await starts()).toEqual(started);
});

it.each([
  ['systemd user service on Linux', 'systemctl', SYSTEMD('user', true), []],
  ['LaunchAgent on macOS', 'launchctl', LAUNCHD(true), MACOS],
] as const)('leaves the running %s alone, for it reads the stored credential itself', async (_name, tool, script, node) => {
  const house = await startHouse();
  const home = await temporaryHome();
  const { path, starts } = await serviceManager(home, tool, script);

  const login = await loginWithCode(house, home, path, [...node]);

  expect(await login.exited).toBe(0);
  expect(await starts()).toEqual([]);
});

it('keeps the stored credential and names the cause when the stopped service does not start', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const refusing = SYSTEMD('user', false).replace('  start) ;;', "  start) echo 'Failed to start house-kit.service: Unit house-kit.service is masked.' >&2; exit 1 ;;");
  const { path } = await serviceManager(home, 'systemctl', refusing);

  const login = await loginWithCode(house, home, path);

  expect(await login.exited).toBe(0);
  expect(login.stderr()).toBe('kit: the House Kit service could not be started: Failed to start house-kit.service: Unit house-kit.service is masked.\n');
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toMatchObject({ credential: 'ahk_code_credential' });
});

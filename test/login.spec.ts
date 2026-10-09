import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, until, type House } from './double.ts';
import { runKit, temporaryHome } from './kit.ts';

function serveLogin(house: House, environment: string, credential: string, own?: string) {
  let challenge = '';
  house.route('POST', '/kit', ({ body }) => {
    challenge = (body as { code_challenge: string }).code_challenge;
    return { body: { start_url: `${house.origin}/kit/ahk_login_one` } };
  });
  house.route('POST', '/kit/token', ({ body }) => {
    const { code, code_verifier } = body as { code: string; code_verifier: string };
    const proved = createHash('sha256').update(code_verifier).digest('base64url') === challenge;
    if (code !== 'ahk_code_one' || !proved) {
      return { status: 400, body: { error: { code: 'kit_login_rejected' } } };
    }
    return {
      body: { credential, environment, user: 'user-one', ...(own === undefined ? {} : { headless_credential: own }) },
    };
  });
}

function answerOwnAgent(house: House, live: string) {
  house.route('POST', '/', ({ headers }) =>
    headers.authorization === `Bearer ${live}`
      ? { body: { jsonrpc: '2.0', id: 1, result: { tools: [] } } }
      : { status: 401, body: {} },
  );
}

async function ownAgent(home: string): Promise<unknown> {
  return JSON.parse(await readFile(join(home, 'own-agent.json'), 'utf8'));
}

async function confirm(house: House, home: string, environment: Record<string, string> = {}) {
  house.requests.length = 0;
  const login = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home, ...environment });
  const started = await until(() => house.requests.find((request) => request.path === '/kit'));
  await until(() => login.stdout().includes(`${house.origin}/kit/ahk_login_one`));
  const { loopback_uri } = started.body as { loopback_uri: string };
  const browser = await (await fetch(`${loopback_uri}?code=ahk_code_one`)).text();
  return { started: started.body as Record<string, unknown>, browser, exit: await login.exited, login };
}

it('enrols a new Environment through the PKCE exchange and stores its credential', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');

  const { started, browser, exit } = await confirm(house, home);

  expect(exit).toBe(0);
  expect(browser).toContain('This Environment is connected');
  expect(started).toMatchObject({
    act: 'new_environment',
    presentation: 'loopback',
    code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
  });
  expect(typeof started.label).toBe('string');
  expect(started).not.toHaveProperty('environment_id');
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    environment: 'environment-one',
    credential: 'ahk_first',
  });
});

it('reconnects the same Environment on a second login', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  await confirm(house, home);
  serveLogin(house, 'environment-one', 'ahk_second');

  const { started, exit } = await confirm(house, home);

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
  await confirm(house, home);
  serveLogin(house, 'environment-two', 'ahk_second');

  const { started, exit } = await confirm(house, home, { HOUSE_KIT_REPLACES: 'environment-one' });

  expect(exit).toBe(0);
  expect(started).toMatchObject({ act: 'new_environment', replaces: 'environment-one', label: expect.any(String) });
  expect(started).not.toHaveProperty('environment_id');
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    environment: 'environment-two',
    credential: 'ahk_second',
  });
});

it('ends with the cause when House refuses to start the login', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  house.route('POST', '/kit', () => ({ status: 404, body: { error: { code: 'kit_environment_not_found' } } }));

  const login = runKit(['login', '--house', house.origin, '--environment', 'environment-gone'], {
    HOUSE_KIT_HOME: home,
  });

  expect(await login.exited).toBe(1);
  expect(login.stderr()).toContain('kit_environment_not_found');
});

it('tells the browser the Environment was not connected when the exchange is refused', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  house.route('POST', '/kit/token', () => ({ status: 400, body: { error: { code: 'kit_login_rejected' } } }));

  const { browser, exit, login } = await confirm(house, home);

  expect(exit).toBe(1);
  expect(browser).toContain('This Environment was not connected');
  expect(login.stderr()).toContain('kit_login_rejected');
  await expect(access(join(home, 'credential.json'))).rejects.toThrow();
});

it('finishes and keeps the credential when the browser disconnects before its answer', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  const login = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home });
  const started = await until(() => house.requests.find((request) => request.path === '/kit'));
  const { loopback_uri } = started.body as { loopback_uri: string };
  const browser = get(`${loopback_uri}?code=ahk_code_one`);
  browser.on('error', () => undefined);
  house.route('POST', '/kit/token', async () => {
    browser.destroy();
    // Fifty milliseconds let the closed browser connection reach the Kit before House answers the token.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { body: { credential: 'ahk_first', environment: 'environment-one', user: 'user-one' } };
  });

  expect(await login.exited).toBe(0);
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toMatchObject({ credential: 'ahk_first' });
});

it('takes the browser return on the published callback port from beyond the loopback interface', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');
  const probe = createServer().listen(0);
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  probe.close();
  const outside = Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === 'IPv4' && !address.internal)!.address;

  const login = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home, HOUSE_KIT_LOGIN_PORT: String(port) });
  const started = await until(() => house.requests.find((request) => request.path === '/kit'));
  const browser = await (await fetch(`http://${outside}:${port}/callback?code=ahk_code_one`)).text();

  expect((started.body as { loopback_uri: string }).loopback_uri).toBe(`http://127.0.0.1:${port}/callback`);
  expect(browser).toContain('This Environment is connected');
  expect(await login.exited).toBe(0);
});

it('ends without a credential when the code it asks for never comes', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first');

  const login = runKit(['login', '--house', house.origin, '--manual'], { HOUSE_KIT_HOME: home });
  await until(() => login.stdout().includes('Code: '));
  login.input.end();

  expect(await login.exited).toBe(1);
  expect(login.stderr()).toContain('no code was typed');
  await expect(access(join(home, 'credential.json'))).rejects.toThrow();
});

it("asks for the User's own agent's connection when Kit holds none and keeps it owner-only beside the Kit credential", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  serveLogin(house, 'environment-one', 'ahk_first', 'ahp_own');

  const { started, exit } = await confirm(house, home);

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

  const { started, exit } = await confirm(house, home);

  expect(exit).toBe(0);
  expect(started).not.toHaveProperty('headless');
  expect(await ownAgent(home)).toEqual(held);
});

it("asks again when House answers the User's own agent's connection as revoked, and keeps the new one", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: house.origin, user: 'user-one', credential: 'ahp_revoked' }));
  answerOwnAgent(house, 'ahp_other');
  serveLogin(house, 'environment-one', 'ahk_first', 'ahp_new');

  const { started, exit } = await confirm(house, home);

  expect(exit).toBe(0);
  expect(started.headless).toBe(true);
  expect(await ownAgent(home)).toEqual({ house: house.origin, user: 'user-one', credential: 'ahp_new' });
});

it("never sends the User's own agent's connection to another House, and asks that House for one of its own", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: 'https://elsewhere.example', user: 'user-one', credential: 'ahp_elsewhere' }));
  serveLogin(house, 'environment-one', 'ahk_first', 'ahp_here');

  const { started, exit } = await confirm(house, home);

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

  const { exit, login } = await confirm(house, home);

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
  await confirm(house, home);
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
  const { started, exit } = await confirm(house, home);

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

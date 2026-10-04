import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, until, type House } from './double.ts';
import { runKit, temporaryHome } from './kit.ts';

function serveLogin(house: House, environment: string, credential: string) {
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
    return { body: { credential, environment, user: 'user-one' } };
  });
}

async function confirm(house: House, home: string) {
  house.requests.length = 0;
  const login = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home });
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

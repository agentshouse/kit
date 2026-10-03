import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startHouse, until, type House } from './double.ts';
import { runKit, temporaryHome } from './kit.ts';

let house: House;

beforeEach(async () => {
  house = await startHouse();
});

afterEach(async () => {
  await house.stop();
});

function serveLogin(environment: string, credential: string) {
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

async function confirm(home: string) {
  const login = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home });
  const started = await until(() => house.requests.find((request) => request.path === '/kit'));
  await until(() => login.stdout().includes(`${house.origin}/kit/ahk_login_one`));
  const { loopback_uri } = started.body as { loopback_uri: string };
  await fetch(`${loopback_uri}?code=ahk_code_one`);
  expect(await login.exited).toBe(0);
  return started.body as Record<string, unknown>;
}

it('enrols a new Environment through the PKCE exchange and stores its credential', async () => {
  const home = await temporaryHome();
  serveLogin('environment-one', 'ahk_first');

  const started = await confirm(home);

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
  const home = await temporaryHome();
  serveLogin('environment-one', 'ahk_first');
  await confirm(home);
  house.requests.length = 0;
  serveLogin('environment-one', 'ahk_second');

  const started = await confirm(home);

  expect(started).toMatchObject({ act: 'existing_environment', environment_id: 'environment-one' });
  expect(started).not.toHaveProperty('label');
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: house.origin,
    environment: 'environment-one',
    credential: 'ahk_second',
  });
});

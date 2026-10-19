import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { startHouse, type House } from './double.ts';
import { temporaryHome } from './kit.ts';

function entry(name: string, argv: string[], home: string, input = '', environment: Record<string, string> = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../src/${name}`, import.meta.url)), ...argv], {
    env: { ...process.env, ...environment, HOUSE_KIT_HOME: home },
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stdin.end(input);
  return new Promise<{ status: number | null; output: string }>((resolve) =>
    child.on('close', (status) => resolve({ status, output })),
  );
}

async function enrolled(house: House, home: string, credential: string) {
  await writeFile(
    join(home, 'credential.json'),
    JSON.stringify({ house: house.origin, environment: 'environment-one', credential }),
  );
}

it('stores the credential it reads on standard input for the named Environment and prints nothing', async () => {
  const home = await temporaryHome();

  const stored = await entry('enrol-main.ts', ['https://house.test', 'environment-one'], home, 'ahk_supplied\n');

  expect(stored).toEqual({ status: 0, output: '' });
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: 'https://house.test',
    environment: 'environment-one',
    credential: 'ahk_supplied',
  });
  expect((await stat(join(home, 'credential.json'))).mode & 0o777).toBe(0o600);
});

it('stores the Kit relay beside a server or Sandbox enrolment', async () => {
  const home = await temporaryHome();

  const stored = await entry('enrol-main.ts', ['https://house.test', 'environment-one'], home, 'ahk_supplied\n', {
    HOUSE_KIT_RELAY: 'https://kit-relay.example',
  });

  expect(stored).toEqual({ status: 0, output: '' });
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({
    house: 'https://house.test',
    relay: 'https://kit-relay.example',
    environment: 'environment-one',
    credential: 'ahk_supplied',
  });
});

it('accepts a stored credential House answers with it', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await enrolled(house, home, 'ahk_valid');
  house.route('POST', '/kit/agents/desired', () => ({ body: { clis: [] } }));

  expect(await entry('authority-main.ts', [], home)).toEqual({ status: 0, output: '' });
  expect(house.requests.at(-1)?.headers.authorization).toBe('Bearer ahk_valid');
});

it('refuses a stored credential House rejects, with its cause', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await enrolled(house, home, 'ahk_revoked');
  house.route('POST', '/kit/agents/desired', () => ({ status: 401, body: { error: { code: 'token_rejected', retryable: false } } }));

  const refused = await entry('authority-main.ts', [], home);

  expect(refused.status).toBe(1);
  expect(refused.output).toContain('token_rejected');
});

const COMMANDS = { macos: 'macos command', linux: 'linux command', container: 'container command', server: 'server command', windows: 'windows command' };

it.each([
  ['too old', { code: 'kit_update_required', retryable: false }, 'This Kit is too old for House; install it again.'],
  [
    'newer than the Building',
    { code: 'kit_newer_than_house', retryable: false, release: '0.2.0-c0ffee000001', commands: COMMANDS },
    'is newer than this Building supports (Kit 0.2.0-c0ffee000001). Install Kit 0.2.0-c0ffee000001: linux command',
  ],
] as const)('fails, saying why, when House refuses this Kit as %s', async (_, error, said) => {
  const house = await startHouse();
  const home = await temporaryHome();
  await enrolled(house, home, 'ahk_valid');
  house.route('POST', '/kit/agents/desired', () => ({ status: 426, body: { error } }));

  const refused = await entry('authority-main.ts', [], home);

  expect(refused.status).toBe(1);
  expect(refused.output).toContain(said);
});

it('keeps a stored credential when House does not answer', async () => {
  const home = await temporaryHome();
  await writeFile(
    join(home, 'credential.json'),
    JSON.stringify({ house: 'http://127.0.0.1:9', environment: 'environment-one', credential: 'ahk_unchecked' }),
  );

  const kept = await entry('authority-main.ts', [], home);

  expect(kept.status).toBe(0);
  expect(kept.output).toContain('the stored credential stands');
});

it('refuses a stored credential it cannot read', async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), '{"house":"http://127.0.0.1:9","environment":"environment-one","credential":"ahk_');

  const refused = await entry('authority-main.ts', [], home);

  expect(refused.status).toBe(1);
  expect(refused.output).not.toContain('the stored credential stands');
});

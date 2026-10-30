import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startHouse, type House } from './double.ts';
import { temporaryHome } from './kit.ts';

const CONTENT = Buffer.from('the bytes of a file the release names\n');
const SHA256 = createHash('sha256').update(CONTENT).digest('hex');

afterEach(() => {
  vi.unstubAllEnvs();
});

async function enrolled(house: string): Promise<{ home: string; building: typeof import('../src/building.ts') }> {
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house, environment: 'environment-one', credential: 'ahk_held' }));
  vi.stubEnv('HOUSE_KIT_HOME', home);
  vi.resetModules();
  return { home, building: await import('../src/building.ts') };
}

const MANIFEST = {
  schemaVersion: 3,
  version: '0.2.1-c000000000002',
  hosts: { linux: 'connect-linux.sh', macos: 'connect-linux.sh', windows: 'connect-windows.ps1' },
  files: { 'connect-linux.sh': { sha256: SHA256 }, 'connect-windows.ps1': { sha256: '0'.repeat(64) } },
};

function serving(house: House, prefix = '', manifest: unknown = MANIFEST): void {
  house.route('GET', `${prefix}/kit-installer/bootstrap.json`, () => ({ body: manifest }));
  house.route('GET', `${prefix}/kit-installer/connect-linux.sh`, () => ({ bytes: { type: 'application/octet-stream', content: CONTENT } }));
}

it('reads the Kit release the House its enrolment names serves, with its Linux installer and that file’s sha256, and downloads that file', async () => {
  const house = await startHouse();
  serving(house);
  const { home, building } = await enrolled(house.origin);

  expect(await building.servedRelease()).toEqual({ version: '0.2.1-c000000000002', installer: 'connect-linux.sh', sha256: SHA256 });
  await building.downloadServed('connect-linux.sh', SHA256, join(home, 'file'));

  expect(await readFile(join(home, 'file'))).toEqual(CONTENT);
  expect(house.requests.map((request) => request.path)).toEqual(['/kit-installer/bootstrap.json', '/kit-installer/connect-linux.sh']);
});

it('refuses a manifest that names no Kit release or no digest of its Linux installer', async () => {
  for (const manifest of [{ ...MANIFEST, version: undefined }, { ...MANIFEST, files: {} }]) {
    const house = await startHouse();
    serving(house, '', manifest);
    const { building } = await enrolled(house.origin);

    await expect(building.servedRelease()).rejects.toThrow('House serves no Kit release in bootstrap.json');
  }
});

it('downloads through the Kit relay, naming the House host first, and never House directly', async () => {
  const house = await startHouse();
  const relay = await startHouse();
  serving(relay, `/${new URL(house.origin).host}`);
  vi.stubEnv('HOUSE_KIT_RELAY', relay.origin);
  const { home, building } = await enrolled(house.origin);

  await building.downloadServed('connect-linux.sh', (await building.servedRelease()).sha256, join(home, 'file'));

  expect(await readFile(join(home, 'file'))).toEqual(CONTENT);
  expect(relay.requests.map((request) => request.path)).toEqual([
    `/${new URL(house.origin).host}/kit-installer/bootstrap.json`,
    `/${new URL(house.origin).host}/kit-installer/connect-linux.sh`,
  ]);
  expect(house.requests).toEqual([]);
});

it('keeps nothing of a file whose bytes do not match the sha256 it was given, naming the file', async () => {
  const house = await startHouse();
  serving(house);
  const { home, building } = await enrolled(house.origin);

  await expect(building.downloadServed('connect-linux.sh', '0'.repeat(64), join(home, 'file'))).rejects.toThrow(
    'connect-linux.sh does not match its sha256',
  );
  await expect(readFile(join(home, 'file'))).rejects.toThrow();
});

it('names the status House answered for a file it does not serve', async () => {
  const house = await startHouse();
  const { home, building } = await enrolled(house.origin);

  await expect(building.downloadServed('kit-0.2.1.tar.gz', SHA256, join(home, 'file'))).rejects.toThrow('House answered 404 for kit-0.2.1.tar.gz');
});

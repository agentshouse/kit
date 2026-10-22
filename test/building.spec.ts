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

function serving(house: House, prefix = ''): void {
  house.route('GET', `${prefix}/kit-installer/bootstrap.json`, () => ({
    body: { schemaVersion: 3, files: { 'codex-acp-2.1.1.tar.gz': { sha256: SHA256 } } },
  }));
  house.route('GET', `${prefix}/kit-installer/codex-acp-2.1.1.tar.gz`, () => ({ bytes: { type: 'application/octet-stream', content: CONTENT } }));
}

it('downloads a file by name from the House its enrolment names and answers the sha256 that House names for it', async () => {
  const house = await startHouse();
  serving(house);
  const { home, building } = await enrolled(house.origin);

  expect(await building.servedDigest('codex-acp-2.1.1.tar.gz')).toBe(SHA256);
  expect(await building.servedDigest('claude-agent-acp-0.85.1.tar.gz')).toBeNull();
  await building.downloadServed('codex-acp-2.1.1.tar.gz', SHA256, join(home, 'file'));

  expect(await readFile(join(home, 'file'))).toEqual(CONTENT);
  expect(house.requests.map((request) => request.path)).toEqual([
    '/kit-installer/bootstrap.json',
    '/kit-installer/bootstrap.json',
    '/kit-installer/codex-acp-2.1.1.tar.gz',
  ]);
});

it('downloads through the Kit relay, naming the House host first, and never House directly', async () => {
  const house = await startHouse();
  const relay = await startHouse();
  serving(relay, `/${new URL(house.origin).host}`);
  vi.stubEnv('HOUSE_KIT_RELAY', relay.origin);
  const { home, building } = await enrolled(house.origin);

  await building.downloadServed('codex-acp-2.1.1.tar.gz', await building.servedDigest('codex-acp-2.1.1.tar.gz') ?? '', join(home, 'file'));

  expect(await readFile(join(home, 'file'))).toEqual(CONTENT);
  expect(relay.requests.map((request) => request.path)).toEqual([
    `/${new URL(house.origin).host}/kit-installer/bootstrap.json`,
    `/${new URL(house.origin).host}/kit-installer/codex-acp-2.1.1.tar.gz`,
  ]);
  expect(house.requests).toEqual([]);
});

it('keeps nothing of a file whose bytes do not match the sha256 it was given, naming the file', async () => {
  const house = await startHouse();
  serving(house);
  const { home, building } = await enrolled(house.origin);

  await expect(building.downloadServed('codex-acp-2.1.1.tar.gz', '0'.repeat(64), join(home, 'file'))).rejects.toThrow(
    'codex-acp-2.1.1.tar.gz does not match its sha256',
  );
  await expect(readFile(join(home, 'file'))).rejects.toThrow();
});

it('names the status House answered for a file it does not serve', async () => {
  const house = await startHouse();
  const { home, building } = await enrolled(house.origin);

  await expect(building.downloadServed('kit-0.2.1.tar.gz', SHA256, join(home, 'file'))).rejects.toThrow('House answered 404 for kit-0.2.1.tar.gz');
});

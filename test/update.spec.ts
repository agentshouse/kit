import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CLIS, KIT_RELEASE, adapterArchive } from '../src/clis.ts';
import { settle, until } from './double.ts';
import { hostKit, lastCall, releasePrefix, type Hosted } from './environment.ts';
import { alive, entriesUnder } from './kit.ts';
import { ADAPTED, callUpdate, placing, released, serveRelease, sha256 } from './release.ts';

const PLACED = '0.2.1-c000000000002';
const LATER = '0.2.1-c000000000003';
const OLDER = '0.2.0-c000000000001';

const FAST_PLACEMENTS = fileURLToPath(new URL('./fast-placements.ts', import.meta.url));

const COMMANDS = { macos: 'macos command', linux: 'linux command', container: 'container command', server: 'server command', windows: 'windows command' };

function unserved(code: 'kit_update_required' | 'kit_newer_than_house', release: string) {
  return { status: 426, body: { error: { code, retryable: false, release, commands: COMMANDS } } };
}

function openings(hosted: Hosted): number {
  return hosted.house.requests.filter((request) => request.method === 'UPGRADE').length;
}

function prefix(hosted: Hosted): string {
  return releasePrefix(hosted.home);
}

async function placedReleases(hosted: Hosted): Promise<string[]> {
  return (await readdir(join(prefix(hosted), 'releases'))).sort();
}

async function current(hosted: Hosted): Promise<string> {
  return (await readFile(join(prefix(hosted), 'current'), 'utf8')).trim();
}

function adapterOf(hosted: Hosted, release: string, kind: string): string {
  const adapter = join(prefix(hosted), 'releases', release, 'adapters', kind, 'node_modules', '.bin', CLIS[kind]!.adapter!.bin);
  return spawnSync(adapter, { encoding: 'utf8' }).stdout;
}

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));

async function opened(hosted: Hosted): Promise<void> {
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
}

it('places the release House names with its adapters beside the one it runs, writing nothing into that one, and ends with a failure once it is idle so its supervisor starts the new one', async () => {
  const hosted = await hostKit();
  await serveRelease(hosted, await released(PLACED));
  const running = await entriesUnder(join(prefix(hosted), 'releases', KIT_RELEASE));

  callUpdate(hosted, 'update-1', PLACED);

  expect(await hosted.result('update-1')).toEqual({});
  expect(await hosted.kit.exited).toBe(1);
  expect(hosted.kit.stderr()).toContain(`kit: Kit ${PLACED} is placed; its supervisor starts it\n`);
  expect(await current(hosted)).toBe(PLACED);
  expect(await placedReleases(hosted)).toEqual([KIT_RELEASE, PLACED].sort());
  for (const kind of ADAPTED) expect(adapterOf(hosted, PLACED, kind)).toBe(`${adapterArchive(kind)}\n`);
  expect(await entriesUnder(join(prefix(hosted), 'releases', KIT_RELEASE))).toEqual(running);
});

it('keeps running a turn open when it placed the release, refuses to place another meanwhile, and ends once that turn ended', async () => {
  const hosted = await hostKit();
  await serveRelease(hosted, await released(PLACED));
  await opened(hosted);
  hosted.call({ kind: 'message', text: '@gate go\n@say done', first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));

  callUpdate(hosted, 'update-busy', PLACED);
  expect(await hosted.result('update-busy')).toEqual({});
  callUpdate(hosted, 'update-later', LATER);
  expect(await hosted.result('update-later')).toEqual({ refused: `Kit ${PLACED} is placed and starts first, once no turn is open` });
  await settle();
  expect(alive(hosted.kit.pid)).toBe(true);
  await writeFile(join(hosted.home, 'go'), '');

  expect(await hosted.kit.exited).toBe(1);
  expect(ended(hosted)).toHaveLength(1);
  expect(await current(hosted)).toBe(PLACED);
});

it('keeps running while a turn waits on a question, though it reports idle, and ends once that turn ended', async () => {
  const hosted = await hostKit();
  await serveRelease(hosted, await released(PLACED));
  await opened(hosted);
  await until(() => hosted.idles[1]);
  hosted.call({ kind: 'message', text: '@ask', first: true });
  const question = await until(() => hosted.interactions[0]);
  await until(() => hosted.idles[2]);

  callUpdate(hosted, 'update-asking', PLACED);
  expect(await hosted.result('update-asking')).toEqual({});
  await settle();
  expect(alive(hosted.kit.pid)).toBe(true);
  const { interaction_id } = question.body as { interaction_id: string };
  hosted.call({ kind: 'answer', interaction_id, response: { outcome: { outcome: 'selected', optionId: 'allow' } } });

  expect(await hosted.kit.exited).toBe(1);
  expect(ended(hosted)).toHaveLength(1);
});

it.each([
  ['a Kit archive that does not match its digest', 'the Kit download does not match its pinned checksum'],
  ['a Building that does not answer', /^the Building did not answer: .+/],
] as const)('answers with the reason and keeps running on its release after %s, and places the release when House calls again', async (failure, reason) => {
  const hosted = await hostKit();
  const release = await released(PLACED);
  const mismatched = failure.startsWith('a Kit archive');
  const building = await serveRelease(hosted, release, mismatched ? await placing(release, sha256(Buffer.from('another archive'))) : undefined);
  building.answers = mismatched;

  callUpdate(hosted, 'update-failed', PLACED);

  const answered = (await hosted.result('update-failed')) as { refused: string };
  const refused = answered.refused.replace(`Kit ${PLACED} could not be placed: `, '');
  if (typeof reason === 'string') expect(refused).toBe(reason);
  else expect(refused).toMatch(reason);
  expect(answered.refused.startsWith(`Kit ${PLACED} could not be placed: `)).toBe(true);
  await settle();
  expect(alive(hosted.kit.pid)).toBe(true);
  expect(await current(hosted)).toBe(KIT_RELEASE);
  expect(await placedReleases(hosted)).toEqual([KIT_RELEASE]);

  await serveRelease(hosted, release);
  callUpdate(hosted, 'update-again', PLACED);

  expect(await hosted.result('update-again')).toEqual({});
  expect(await hosted.kit.exited).toBe(1);
  expect(await current(hosted)).toBe(PLACED);
});

it('answers an update naming the release it runs at once and keeps running, placing nothing', async () => {
  const hosted = await hostKit();
  await serveRelease(hosted, await released(PLACED));

  callUpdate(hosted, 'update-same', KIT_RELEASE);

  expect(await hosted.result('update-same')).toEqual({});
  await settle();
  expect(alive(hosted.kit.pid)).toBe(true);
  expect(hosted.house.requests.filter((request) => request.path.startsWith('/kit-installer/'))).toEqual([]);
  expect(await current(hosted)).toBe(KIT_RELEASE);
});

it('places the release House names when it refuses its Kit connection as too old at once, though a turn is open, opening no Kit connection again, and ends with a failure so its supervisor starts it', async () => {
  const hosted = await hostKit();
  await serveRelease(hosted, await released(PLACED));
  await opened(hosted);
  hosted.call({ kind: 'message', text: '@gate go\n@say done', first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  hosted.house.route('UPGRADE', '/kit/stream', () => unserved('kit_update_required', PLACED));

  hosted.connection.close(1012, 'deploy');

  expect(await hosted.kit.exited).toBe(1);
  expect(hosted.kit.stderr()).toContain(`kit: Kit ${PLACED} is placed; its supervisor starts it\n`);
  expect(await current(hosted)).toBe(PLACED);
  expect(await placedReleases(hosted)).toEqual([KIT_RELEASE, PLACED].sort());
  expect(ended(hosted)).toEqual([]);
  expect(openings(hosted)).toBe(2);
});

it('places the older release House names when it refuses any of its calls as newer than the Building the same way', async () => {
  const hosted = await hostKit();
  await serveRelease(hosted, await released(OLDER));
  await opened(hosted);
  hosted.house.route('POST', '/kit/conversations/:conversation/turns/:turn/started', () => unserved('kit_newer_than_house', OLDER));

  hosted.call({ kind: 'message', text: '@gate go\n@say done', first: true });

  expect(await hosted.kit.exited).toBe(1);
  expect(hosted.kit.stderr()).toContain(`kit: Kit ${OLDER} is placed; its supervisor starts it\n`);
  expect(await current(hosted)).toBe(OLDER);
  expect(await placedReleases(hosted)).toEqual([KIT_RELEASE, OLDER].sort());
  expect(openings(hosted)).toBe(1);
});

it('stays offline on its release while it cannot place the release a refusal names, saying why with the install command Kit home records, and tries again at its interval until it places it and ends', async () => {
  const command = `sh -c 'kit=$(curl -fsSL "$0") || exit 1; eval "$kit"' https://bank.example/kit`;
  const hosted = await hostKit([{}], {
    node: ['--import', FAST_PLACEMENTS],
    prepare: (home) => writeFile(join(home, 'install-command'), `${command}\n`),
  });
  const building = await serveRelease(hosted, await released(PLACED));
  building.answers = false;
  hosted.house.route('UPGRADE', '/kit/stream', () => unserved('kit_update_required', PLACED));
  const failed = `kit: Kit ${PLACED} could not be placed: the Building did not answer: `;
  const offline = `kit: Kit ${KIT_RELEASE} stays offline and tries again in 5 minutes. Update it: ${command}\n`;

  hosted.connection.close(1012, 'deploy');

  await until(() => hosted.kit.stderr().split(offline).length > 2);
  expect(hosted.kit.stderr().split(failed).length).toBeGreaterThan(2);
  expect(alive(hosted.kit.pid)).toBe(true);
  expect(await current(hosted)).toBe(KIT_RELEASE);
  expect(openings(hosted)).toBe(2);
  building.answers = true;

  expect(await hosted.kit.exited).toBe(1);
  expect(hosted.kit.stderr()).toContain(`kit: Kit ${PLACED} is placed; its supervisor starts it\n`);
  expect(await current(hosted)).toBe(PLACED);
  expect(openings(hosted)).toBe(2);
});

it('places the release its Building serves when it tries again after the Building took another release than its refusal named', async () => {
  const hosted = await hostKit([{}], { node: ['--import', FAST_PLACEMENTS] });
  const building = await serveRelease(hosted, await released(PLACED));
  building.answers = false;
  hosted.house.route('UPGRADE', '/kit/stream', () => unserved('kit_update_required', PLACED));

  hosted.connection.close(1012, 'deploy');

  await until(() => hosted.kit.stderr().includes(`kit: Kit ${PLACED} could not be placed: `));
  await serveRelease(hosted, await released(LATER));

  expect(await hosted.kit.exited).toBe(1);
  expect(hosted.kit.stderr()).toContain(`kit: Kit ${LATER} is placed; its supervisor starts it\n`);
  expect(await current(hosted)).toBe(LATER);
  expect(openings(hosted)).toBe(2);
});

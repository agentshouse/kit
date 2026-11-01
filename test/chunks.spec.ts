import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { importCommits } from '../src/git.ts';
import { until } from './double.ts';
import { hostKit, type Hosted } from './environment.ts';
import { temporaryHome } from './kit.ts';
import { commitAll, git, house, serveRooms, type Room } from './rooms.ts';

const ASKED_AGAIN = fileURLToPath(new URL('./asked-again.ts', import.meta.url));
const COLLECTING = fileURLToPath(new URL('./collecting.ts', import.meta.url));
const FORMER_BUNDLE_BYTES = 512 * 1024 * 1024;
const KIT_HEAP_MEGABYTES = 96;
const LIST = '/kit/door/room-chunks/list';
const NOT_READY = 'not ready yet; Kit copies it once House has built it';

function record(hosted: Hosted, room: Room): string {
  return join(hosted.home, 'local-copies/rooms', `${room.ref}.json`);
}

function tracked(room: Room, repository = room.repository): string[] {
  return git(repository, 'ls-files').trim().split('\n');
}

function listed(hosted: Hosted): unknown[] {
  return hosted.house.requests.filter((request) => request.path === LIST).map((request) => request.body);
}

function enumerated(hosted: Hosted): unknown[] {
  return hosted.house.requests.filter((request) => request.path === '/kit/door/enumerate').map((request) => request.body);
}

function chunkReads(hosted: Hosted): string[] {
  return hosted.store.requests.filter((request) => request.key.startsWith('room-chunks/')).map((request) => request.key);
}

function at(room: Room, position: number): { authority: string; position: string; log_epoch: string } {
  return { authority: room.ref, position: String(position), log_epoch: room.logEpoch };
}

it('carries a Room it holds nothing of through the enumeration from position zero, reading no chunk', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  room.put('capture/mail/one.md', 'one\n', 'source: s_mail\n');
  room.remove('capture/mail/one.md');
  room.put('capture/mail/two.md', 'two\n', 'source: s_mail\n');

  expect(await rooms.fetch([room])).toMatchObject({ status: 0, stdout: `${room.root}: copied to ${room.repository}\n` });

  expect(enumerated(hosted)).toEqual([
    {
      prefixes: [room.root],
      positions: [{ ...at(room, 0), page: { through: String(room.position), read: 0 } }],
    },
  ]);
  expect(listed(hosted)).toEqual([]);
  expect(chunkReads(hosted)).toEqual([]);
  expect(tracked(room)).toEqual(['a.md']);
  expect(await readFile(join(room.repository, 'capture/mail/two.md'), 'utf8')).toBe('two\n');
  expect(await readFile(join(room.repository, 'capture/mail/_provenance/two.md'), 'utf8')).toBe('source: s_mail\n');
  expect(existsSync(join(room.repository, 'capture/mail/one.md'))).toBe(false);
  expect(JSON.parse(await readFile(record(hosted, room), 'utf8'))).toMatchObject({ position: String(room.position), log_epoch: room.logEpoch });
});

it('copies a Room House answers too old at position zero from its chunks straight from storage into its Git repository, with no binary entry and no folder', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.write = ['ROOM.md', 'plans'];
  room.put('ROOM.md', 'The notes Room\n');
  room.put('plans/q4.md', 'Ship it\n');
  room.put('archive/old.md', 'Read only for this grant\n');
  room.put('capture/mail/inbox/one.md', 'Hello from mail\n', 'source: s_mail\n');
  room.upload('plans/photo.jpg', Buffer.from('jpeg bytes'));
  room.folders.add('plans/empty');
  rooms.expired.add(room.ref);

  expect(await rooms.fetch([room])).toMatchObject({ status: 0, stdout: `${room.root}: copied to ${room.repository}\n` });

  expect(listed(hosted)).toEqual([{ prefixes: [room.root] }]);
  expect(chunkReads(hosted)).toHaveLength(1);
  expect(tracked(room)).toEqual(['ROOM.md', 'plans/q4.md']);
  expect(git(room.repository, 'show', 'refs/house/received:plans/q4.md')).toBe('Ship it\n');
  expect(git(room.repository, 'status', '--porcelain')).toBe('');
  expect(await readFile(join(room.repository, 'archive/old.md'), 'utf8')).toBe('Read only for this grant\n');
  expect(await readFile(join(room.repository, 'capture/mail/inbox/one.md'), 'utf8')).toBe('Hello from mail\n');
  expect(await readFile(join(room.repository, 'capture/mail/inbox/_provenance/one.md'), 'utf8')).toBe('source: s_mail\n');
  expect(existsSync(join(room.repository, 'plans/photo.jpg'))).toBe(false);
  expect(existsSync(join(room.repository, 'plans/empty'))).toBe(false);
  expect(git(room.repository, 'check-ignore', 'archive/old.md').trim()).toBe('archive/old.md');
  expect((await readdir(join(room.repository, '.git'))).filter((name) => name.includes('chunk'))).toEqual([]);

  await writeFile(join(room.repository, 'plans/q4.md'), 'Ship it, edited\n');
  commitAll(room.repository, 'local');
  expect(await house(hosted, room.repository, 'push', '--owner')).toMatchObject({ status: 0 });
  expect(room.files.get('plans/q4.md')!.content).toBe('Ship it, edited\n');
});

it("places the Space schema a Room's chunk list names as its model, which no chunk holds", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  room.models = [{ path: 'settings/schema.yaml', revision: 'fr_schema', sha256: 'unused', bytes: 7, lines: 1, content: 'note: {}\n', space: 's_one.x' }];
  rooms.expired.add(room.ref);

  await rooms.fetch([room]);

  expect(git(room.repository, 'show', 'refs/house/received:settings/schema.yaml')).toBe('note: {}\n');
  expect(JSON.parse(await readFile(record(hosted, room), 'utf8')).manifests).toEqual(
    expect.objectContaining({ [git(room.repository, 'rev-parse', 'refs/house/received').trim()]: { parent: null, files: expect.objectContaining({ 'settings/schema.yaml': 'fr_schema' }) } }),
  );
});

it('downloads many chunks at once and shows nothing of the Room until every one arrived', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('large');
  const text = 'x'.repeat(600_000);
  for (let document = 0; document < 8; document += 1) room.put(`d${document}.md`, `${text}${document}\n`);
  rooms.expired.add(room.ref);
  const release = hosted.store.holdReads();

  const fetching = rooms.fetch([room]);

  await until(() => hosted.store.reading >= 3);
  expect(existsSync(room.repository)).toBe(false);
  release();
  expect(await fetching).toMatchObject({ status: 0 });
  expect(tracked(room)).toEqual(Array.from({ length: 8 }, (_, document) => `d${document}.md`));
});

it('keeps every chunk body through a garbage collection that runs between its answer and its download', async () => {
  const hosted = await hostKit([{}], { node: ['--expose-gc', '--import', COLLECTING] });
  const rooms = serveRooms(hosted);
  const room = rooms.room('large');
  const text = 'x'.repeat(600_000);
  for (let document = 0; document < 40; document += 1) room.put(`d${document}.md`, `${text}${document}\n`);
  rooms.expired.add(room.ref);

  expect(await rooms.fetch([room])).toMatchObject({ stderr: '', status: 0 });

  expect(tracked(room)).toHaveLength(40);
});

it("reads what changed since the chunk list's position through the enumeration, so a fetch after a push shows the push", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  room.put('b.md', 'b\n');
  await rooms.fetch([room]);
  await writeFile(join(room.repository, 'a.md'), 'a, pushed\n');
  commitAll(room.repository, 'local');
  room.build();
  const built = room.position;
  expect(await house(hosted, room.repository, 'push', '--owner')).toMatchObject({ status: 0 });
  rooms.expired.add(room.ref);
  const asked = enumerated(hosted).length;

  expect(await house(hosted, '/', 'fetch')).toMatchObject({ status: 0, stdout: expect.stringMatching(/^\/rooms\/notes: refs\/house\/received is at [0-9a-f]{12}\n$/) });

  expect(enumerated(hosted).slice(asked).at(1)).toEqual({ prefixes: [room.root], positions: [at(room, built)] });
  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a, pushed\n');
  expect(chunkReads(hosted)).toHaveLength(1);
});

it("brings a new copy's branch to what changed since the chunk list's position", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  room.build();
  room.put('late.md', 'late\n');
  rooms.expired.add(room.ref);

  expect(await rooms.fetch([room])).toMatchObject({ status: 0, stdout: `${room.root}: copied to ${room.repository}\n` });

  expect(tracked(room)).toEqual(['a.md', 'late.md']);
  expect(await readFile(join(room.repository, 'late.md'), 'utf8')).toBe('late\n');
  expect(git(room.repository, 'rev-parse', 'HEAD')).toBe(git(room.repository, 'rev-parse', 'refs/house/received'));
  expect(git(room.repository, 'status', '--porcelain')).toBe('');
});

it('reads a Room whose carry from zero fits no one answer from its chunks, and leaves a Room that fits carried', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const large = rooms.room('large');
  const text = 'x'.repeat(900_000);
  for (let document = 0; document < 6; document += 1) large.put(`d${document}.md`, `${text}${document}\n`);
  const small = rooms.room('small');
  small.put('a.md', 'a\n');

  expect(await rooms.fetch([large, small])).toMatchObject({ status: 0 });

  expect(listed(hosted)).toEqual([{ prefixes: [large.root] }]);
  expect(tracked(large)).toHaveLength(6);
  expect(tracked(small)).toEqual(['a.md']);
});

it('asks a Room answered not ready again after 1, 2, 3, 5, 8, 11 and 15 seconds, then every 15 seconds, and copies it once its build job builds it', async () => {
  const pauses = join(await temporaryHome(), 'pauses');
  await writeFile(pauses, '');
  const hosted = await hostKit([{}], { node: ['--import', ASKED_AGAIN], environment: { KIT_TEST_PAUSES: pauses } });
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  rooms.carriedDocuments = 0;
  rooms.notReady.set(room.ref, 9);

  expect(await rooms.fetch([room])).toMatchObject({ status: 0, stdout: `${room.root}: ${NOT_READY}\n` });

  expect(existsSync(room.repository)).toBe(false);
  await until(() => existsSync(record(hosted, room)));
  expect(listed(hosted)).toHaveLength(10);
  expect(enumerated(hosted).filter((body) => (body as { positions: { position: string }[] }).positions[0]!.position === '0')).toHaveLength(1);
  expect((await readFile(pauses, 'utf8')).trim().split('\n').map(Number)).toEqual([1000, 2000, 3000, 5000, 8000, 11_000, 15_000, 15_000, 15_000]);
  expect(tracked(room)).toEqual(['a.md']);
});

it('keeps what a held Room shows while House answers it not ready, and takes it from chunks with its unpushed commits kept once it is built', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  await rooms.fetch([room]);
  await writeFile(join(room.repository, 'a.md'), 'a, local\n');
  const unpushed = commitAll(room.repository, 'local');
  const before = git(room.repository, 'rev-parse', 'refs/house/received').trim();
  room.put('b.md', 'b, from House\n');
  rooms.carriedDocuments = 0;
  rooms.notReady.set(room.ref, 2);

  expect(await house(hosted, '/', 'fetch')).toMatchObject({ status: 0, stdout: `${room.root}: ${NOT_READY}\n` });
  expect(git(room.repository, 'rev-parse', 'refs/house/received').trim()).toBe(before);

  await until(() => git(room.repository, 'rev-parse', 'refs/house/received').trim() !== before);
  await until(async () => JSON.parse(await readFile(record(hosted, room), 'utf8')).position === String(room.position));
  expect(git(room.repository, 'show', 'refs/house/received:b.md')).toBe('b, from House\n');
  expect(git(room.repository, 'rev-parse', 'HEAD').trim()).toBe(unpushed);
  expect(listed(hosted)).toHaveLength(3);
});

it('keeps asking a Room answered not ready when one of its asks fails, and copies it once House answers', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  rooms.carriedDocuments = 0;
  rooms.notReady.set(room.ref, 1);

  expect(await rooms.fetch([room])).toMatchObject({ status: 0, stdout: `${room.root}: ${NOT_READY}\n` });
  rooms.unreadable.add(room.ref);
  const asked = listed(hosted).length;
  await until(() => listed(hosted).length > asked);
  rooms.unreadable.clear();

  await until(() => existsSync(record(hosted, room)));
  expect(tracked(room)).toEqual(['a.md']);
});

it("asks a Room answered not ready again when another Room's read fails in the same fetch", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const regranted = rooms.room('regranted');
  regranted.put('a.md', 'a\n');
  const other = rooms.room('other');
  other.put('b.md', 'b\n');
  await rooms.fetch([regranted, other]);
  regranted.protected = [...regranted.protected, 'archive'];
  rooms.notReady.set(regranted.ref, 1);
  rooms.reads = [false];

  const fetched = await house(hosted, '/', 'fetch');

  expect(fetched.status).toBe(1);
  expect(fetched.stderr).toContain(`${regranted.root}: ${NOT_READY}\n`);
  await until(() => listed(hosted).length >= 2);
  await until(async () => JSON.parse(await readFile(record(hosted, regranted), 'utf8')).protected.includes('archive'));
});

it('stops asking a Room answered not ready once it leaves the selection', async () => {
  const pauses = join(await temporaryHome(), 'pauses');
  await writeFile(pauses, '');
  const hosted = await hostKit([{}], { node: ['--import', ASKED_AGAIN], environment: { KIT_TEST_PAUSES: pauses } });
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  rooms.carriedDocuments = 0;
  rooms.notReady.set(room.ref, Infinity);
  const selections = () => hosted.house.requests.filter((request) => request.path === '/kit/local-copy/selection').length;

  await rooms.fetch([room]);
  await until(() => listed(hosted).length >= 3);
  rooms.answered = [];
  const left = selections();
  await until(() => selections() > left);
  const asked = (await readFile(pauses, 'utf8')).trim().split('\n').length;
  await house(hosted, '/', 'fetch');

  expect((await readFile(pauses, 'utf8')).trim().split('\n').length).toBeLessThanOrEqual(asked + 1);
  expect(existsSync(room.repository)).toBe(false);
});

it('downloads what a failed chunk left once more and finishes the copy from what it holds', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('large');
  const text = 'x'.repeat(600_000);
  for (let document = 0; document < 8; document += 1) room.put(`d${document}.md`, `${text}${document}\n`);
  rooms.expired.add(room.ref);
  hosted.store.refuseReads(1);

  expect(await rooms.fetch([room])).toMatchObject({ stderr: '', status: 0 });

  const whole = hosted.store.requests.filter((request) => request.key.startsWith('room-chunks/') && request.status === 200).map((request) => request.key);
  expect(new Set(whole).size).toBe(whole.length);
  expect(tracked(room)).toHaveLength(8);
  expect(listed(hosted)).toHaveLength(2);
});

it("sweeps the staging its Kit left when stopped during a copy as it starts again, and leaves another Kit's", async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], { environment: { HOUSE_KIT_WORKSPACE: workspace } });
  const rooms = serveRooms(hosted);
  const room = rooms.room('large');
  room.put('a.md', 'a\n');
  rooms.expired.add(room.ref);
  const copies = join(workspace, 'local-copies', 'rooms');
  const staged = async () => (await readdir(copies).catch(() => [])).filter((name) => name.startsWith('.'));
  const release = hosted.store.holdReads();

  const stopped = rooms.fetch([room]).catch(() => undefined);
  await until(() => hosted.store.reading >= 1);
  expect(await staged()).toHaveLength(1);
  await mkdir(join(copies, '.another-kit'));
  release();
  await hosted.restart();
  await stopped;

  await until(async () => (await staged()).length === 1);
  expect(await staged()).toEqual(['.another-kit']);
});

it('removes what a copy staged when its chunks cannot be read', async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], { environment: { HOUSE_KIT_WORKSPACE: workspace } });
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  rooms.expired.add(room.ref);
  rooms.damagesChunks = true;

  expect((await rooms.fetch([room])).status).toBe(1);

  expect(await readdir(join(workspace, 'local-copies', 'rooms'))).toEqual([]);
});

it("names git's cause when git fast-import dies while a large commit is sent", async () => {
  const repository = await temporaryHome();
  git(repository, 'init', '-q');
  const text = 'x'.repeat(1_000_000);
  async function* files(): AsyncGenerator<readonly [string, string]> {
    for (let document = 0; document < 200; document += 1) yield [`d${document}.md`, text];
  }

  await expect(importCommits(repository, [{ message: 'a', from: 'f'.repeat(40), files: files() }])).rejects.toThrow(/git fast-import failed: .*f{40}/su);
});

it('asks the list again when a chunk address expired, and downloads only the chunks it lacks', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('large');
  const text = 'x'.repeat(600_000);
  for (let document = 0; document < 8; document += 1) room.put(`d${document}.md`, `${text}${document}\n`);
  rooms.expired.add(room.ref);
  rooms.expiringChunks = 1;

  expect(await rooms.fetch([room])).toMatchObject({ status: 0 });

  expect(listed(hosted)).toHaveLength(2);
  expect(tracked(room)).toHaveLength(8);
  const reads = hosted.store.requests.filter((request) => request.key.startsWith('room-chunks/'));
  const whole = reads.filter((request) => request.status === 200).map((request) => request.key);
  expect(new Set(whole).size).toBe(whole.length);
  expect(reads.filter((request) => request.status === 403)).toHaveLength(1);
});

it("refuses a chunk that did not arrive whole, keeps the copy where it was, and leaves the House ref alone when a chunk's text cannot be read", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  await rooms.fetch([room]);
  const before = git(room.repository, 'rev-parse', 'refs/house/received').trim();
  room.put('a.md', 'a, later\n');
  room.put('b.md', 'b\n');
  rooms.expired.add(room.ref);
  rooms.damagesChunks = true;

  const damaged = await house(hosted, '/', 'fetch');

  expect(damaged.status).toBe(1);
  expect(git(room.repository, 'rev-parse', 'refs/house/received').trim()).toBe(before);

  rooms.damagesChunks = false;
  rooms.unparsedChunks = true;
  rooms.expired.add(room.ref);

  expect((await house(hosted, '/', 'fetch')).status).toBe(1);
  expect(git(room.repository, 'rev-parse', 'refs/house/received').trim()).toBe(before);
  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a\n');
  expect((await readdir(join(room.repository, '.git'))).filter((name) => name.includes('chunk'))).toEqual([]);

  rooms.unparsedChunks = false;
  expect(await house(hosted, '/', 'fetch')).toMatchObject({ status: 0 });
  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a, later\n');
});

it("copies a Room larger than the former bundle limit with the Kit's heap capped far below the Room and its peak memory under half of it", { timeout: 300_000 }, async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], { node: [`--max-old-space-size=${KIT_HEAP_MEGABYTES}`], environment: { HOUSE_KIT_WORKSPACE: workspace } });
  const rooms = serveRooms(hosted);
  const room = rooms.room('large');
  const text = `${'a line of a large document\n'.repeat(37_000)}`;
  const documents = Math.ceil(FORMER_BUNDLE_BYTES / text.length) + 20;
  for (let document = 0; document < documents; document += 1) room.put(`d/${document}.md`, `${document}\n${text}`);
  rooms.expired.add(room.ref);

  const copying = await rooms.fetch([room]);
  expect({ ...copying, kit: hosted.kit.stderr() }).toMatchObject({ stderr: '', kit: '', status: 0 });

  const repository = join(workspace, 'local-copies', 'rooms', room.ref);
  const written = await stat(join(repository, 'd/0.md'));
  expect(written.size * documents).toBeGreaterThan(FORMER_BUNDLE_BYTES);
  expect(tracked(room, repository)).toHaveLength(documents);
  const peak = /VmHWM:\s+(\d+) kB/.exec(await readFile(`/proc/${hosted.kit.pid}/status`, 'utf8'))![1]!;
  expect(Number(peak) * 1024).toBeLessThan(FORMER_BUNDLE_BYTES / 2);
});

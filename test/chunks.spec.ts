import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, type Hosted } from './environment.ts';
import { temporaryHome } from './kit.ts';
import { house, MANIFEST, manifestOf, serveRooms, upload, type ManifestEntry, type Room } from './rooms.ts';

const COLLECTING = fileURLToPath(new URL('./collecting.ts', import.meta.url));
const FORMER_BUNDLE_BYTES = 512 * 1024 * 1024;
const KIT_HEAP_MEGABYTES = 96;
const LIST = '/kit/door/room-chunks/list';
const NOT_READY = 'not ready yet; Kit copies it once House has built it';
// Two and a half seconds is past the first two asks of the schedule the notice replaced, so a Kit still asking on its own is seen.
const UNASKED_MS = 2_500;
const LOCAL_COPY_READS = new Set(['/kit/local-copies/selection/read', '/kit/door/rooms/discover', '/kit/door/changes/enumerate', LIST]);

function record(hosted: Hosted, room: Room): string {
  return join(hosted.home, 'local-copies/rooms', `${room.ref}.json`);
}

function tracked(room: Room, repository = room.repository): string[] {
  const { files } = JSON.parse(readFileSync(join(repository, MANIFEST), 'utf8')) as { files: Record<string, ManifestEntry> };
  return Object.entries(files)
    .filter(([, entry]) => entry.read_only === undefined && entry.skipped === undefined)
    .map(([path]) => path)
    .sort();
}

function listed(hosted: Hosted): unknown[] {
  return hosted.house.requests.filter((request) => request.path === LIST).map((request) => request.body);
}

function copyReads(hosted: Hosted): string[] {
  return hosted.house.requests.filter((request) => LOCAL_COPY_READS.has(request.path)).map((request) => request.path);
}

function noticed(hosted: Hosted, room: Room): void {
  hosted.house.connections.at(-1)!.send({ type: 'work_available', subject: 'rooms', room_ref: room.ref });
}

async function unasked(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, UNASKED_MS));
}

function enumerated(hosted: Hosted): unknown[] {
  return hosted.house.requests.filter((request) => request.path === '/kit/door/changes/enumerate').map((request) => request.body);
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
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  room.put('capture/mail/one.md', 'one\n', 'source: s_mail\n');
  room.remove('capture/mail/one.md');
  room.put('capture/mail/two.md', 'two\n', 'source: s_mail\n');

  expect(await rooms.download([room])).toMatchObject({ status: 0, stdout: `${room.root}: copied to ${room.repository}\n` });

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

it('copies a Room House answers too old at position zero from its chunks straight from storage into its folder, recording its attachment as skipped and making no folder', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.write = ['ROOM.md', 'plans'];
  room.put('ROOM.md', 'The notes Room\n');
  room.put('plans/q4.md', 'Ship it\n');
  room.put('archive/old.md', 'Read only for this grant\n');
  room.put('capture/mail/inbox/one.md', 'Hello from mail\n', 'source: s_mail\n');
  room.upload('plans/photo.jpg', Buffer.from('jpeg bytes'));
  room.folders.add('plans/empty');
  rooms.expired.add(room.ref);

  expect(await rooms.download([room])).toMatchObject({ status: 0, stdout: `${room.root}: copied to ${room.repository}\n` });

  expect(listed(hosted)).toEqual([{ prefixes: [room.root] }]);
  expect(chunkReads(hosted)).toHaveLength(1);
  expect(tracked(room)).toEqual(['ROOM.md', 'plans/q4.md']);
  expect(await readFile(join(room.repository, 'plans/q4.md'), 'utf8')).toBe('Ship it\n');
  expect(await readFile(join(room.repository, 'archive/old.md'), 'utf8')).toBe('Read only for this grant\n');
  expect(await readFile(join(room.repository, 'capture/mail/inbox/one.md'), 'utf8')).toBe('Hello from mail\n');
  expect(await readFile(join(room.repository, 'capture/mail/inbox/_provenance/one.md'), 'utf8')).toBe('source: s_mail\n');
  expect(existsSync(join(room.repository, 'plans/photo.jpg'))).toBe(false);
  expect(existsSync(join(room.repository, 'plans/empty'))).toBe(false);
  expect(existsSync(join(room.repository, '.git'))).toBe(false);
  const { files } = await manifestOf(room);
  expect(files['archive/old.md']!.read_only).toBe(true);
  expect(files['plans/photo.jpg']).toMatchObject({ bytes: 10, skipped: true });
  expect((await readdir(dirname(room.repository))).filter((name) => name.startsWith('.') && !name.endsWith('work'))).toEqual([]);

  await writeFile(join(room.repository, 'plans/q4.md'), 'Ship it, edited\n');
  expect(await upload(hosted, room)).toMatchObject({ status: 0 });
  expect(room.files.get('plans/q4.md')!.content).toBe('Ship it, edited\n');
});

it("places the Space schema a Room's chunk list names as its model, which no chunk holds", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  room.models = [{ path: 'settings/schema.yaml', revision: 'v_9.1.x', sha256: 'unused', bytes: 7, lines: 1, content: 'note: {}\n', space: 's_one.x' }];
  rooms.expired.add(room.ref);

  await rooms.download([room]);

  expect(await readFile(join(room.repository, 'settings/schema.yaml'), 'utf8')).toBe('note: {}\n');
  expect((await manifestOf(room)).files['settings/schema.yaml']).toMatchObject({ revision: 'v_9.1.x' });
});

it('downloads many chunks at once and shows nothing of the Room until every one arrived', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('large');
  const text = 'x'.repeat(600_000);
  for (let document = 0; document < 8; document += 1) room.put(`d${document}.md`, `${text}${document}\n`);
  rooms.expired.add(room.ref);
  const release = hosted.store.holdReads();

  const fetching = rooms.download([room]);

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

  expect(await rooms.download([room])).toMatchObject({ stderr: '', status: 0 });

  expect(tracked(room)).toHaveLength(40);
});

it("reads what changed since the chunk list's position through the enumeration, so a download after an upload keeps what the upload sent", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  room.put('b.md', 'b\n');
  await rooms.download([room]);
  await writeFile(join(room.repository, 'a.md'), 'a, uploaded\n');
  room.build();
  const built = room.position;
  expect(await upload(hosted, room)).toMatchObject({ status: 0 });
  rooms.expired.add(room.ref);
  const asked = enumerated(hosted).length;

  expect(await house(hosted, '/', 'download')).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });

  expect(enumerated(hosted).slice(asked).at(1)).toEqual({ prefixes: [room.root], positions: [at(room, built)] });
  expect(await readFile(join(room.repository, 'a.md'), 'utf8')).toBe('a, uploaded\n');
  expect((await manifestOf(room)).files['a.md']!.revision).toBe(room.revision('a.md'));
  expect(chunkReads(hosted)).toHaveLength(1);
});

it("brings a new copy to what changed since the chunk list's position", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  room.build();
  room.put('late.md', 'late\n');
  rooms.expired.add(room.ref);

  expect(await rooms.download([room])).toMatchObject({ status: 0, stdout: `${room.root}: copied to ${room.repository}\n` });

  expect(tracked(room)).toEqual(['a.md', 'late.md']);
  expect(await readFile(join(room.repository, 'late.md'), 'utf8')).toBe('late\n');
});

it('reads a Room whose carry from zero fits no one answer from its chunks, and leaves a Room that fits carried', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const large = rooms.room('large');
  const text = 'x'.repeat(900_000);
  for (let document = 0; document < 6; document += 1) large.put(`d${document}.md`, `${text}${document}\n`);
  const small = rooms.room('small');
  small.put('a.md', 'a\n');

  expect(await rooms.download([large, small])).toMatchObject({ status: 0 });

  expect(listed(hosted)).toEqual([{ prefixes: [large.root] }]);
  expect(tracked(large)).toHaveLength(6);
  expect(tracked(small)).toEqual(['a.md']);
});

it("asks a Room answered not ready again only when House's notice that its chunks are built arrives, then once, and copies it", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  rooms.carriedDocuments = 0;
  rooms.notReady.set(room.ref, 1);

  expect(await rooms.download([room])).toMatchObject({ status: 0, stdout: `${room.root}: ${NOT_READY}\n` });
  await unasked();
  expect(listed(hosted)).toHaveLength(1);
  expect(existsSync(room.repository)).toBe(false);

  noticed(hosted, room);

  await until(() => existsSync(record(hosted, room)));
  await unasked();
  expect(listed(hosted)).toHaveLength(2);
  expect(enumerated(hosted).filter((body) => (body as { positions: { position: string }[] }).positions[0]!.position === '0')).toHaveLength(1);
  expect(tracked(room)).toEqual(['a.md']);
});

it('copies a Room once at a notice that arrives before the download that answered it not ready ends', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  rooms.carriedDocuments = 0;
  rooms.notReady.set(room.ref, 1);
  rooms.answeringNotReady = (answered) => noticed(hosted, answered);

  expect(await rooms.download([room])).toMatchObject({ status: 0, stdout: `${room.root}: ${NOT_READY}\n` });

  await until(() => existsSync(record(hosted, room)));
  await unasked();
  expect(listed(hosted)).toHaveLength(2);
  expect(tracked(room)).toEqual(['a.md']);
});

it('asks at a notice only about the Room it names, while another Room it waits for waits for its own notice', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const first = rooms.room('first');
  first.put('a.md', 'a\n');
  const second = rooms.room('second');
  second.put('b.md', 'b\n');
  rooms.carriedDocuments = 0;
  rooms.notReady.set(first.ref, 1);
  rooms.notReady.set(second.ref, 1);

  expect(await rooms.download([first, second])).toMatchObject({ status: 0 });
  expect(listed(hosted)).toHaveLength(2);

  noticed(hosted, first);

  await until(() => existsSync(record(hosted, first)));
  await unasked();
  expect(listed(hosted).slice(2)).toEqual([{ prefixes: [first.root] }]);
  expect(existsSync(second.repository)).toBe(false);

  noticed(hosted, second);

  await until(() => existsSync(record(hosted, second)));
  await unasked();
  expect(listed(hosted).slice(3)).toEqual([{ prefixes: [second.root] }]);
  expect(tracked(second)).toEqual(['b.md']);
});

it('keeps what a held Room shows while House answers it not ready, and takes it from chunks keeping what changed here once it is built', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  await rooms.download([room]);
  await writeFile(join(room.repository, 'a.md'), 'a, local\n');
  room.put('b.md', 'b, from House\n');
  rooms.carriedDocuments = 0;
  rooms.notReady.set(room.ref, 1);

  expect(await house(hosted, '/', 'download')).toMatchObject({ status: 0, stdout: `${room.root}: ${NOT_READY}\n` });
  expect(existsSync(join(room.repository, 'b.md'))).toBe(false);
  noticed(hosted, room);

  await until(() => existsSync(join(room.repository, 'b.md')));
  await until(async () => JSON.parse(await readFile(record(hosted, room), 'utf8')).position === String(room.position));
  expect(await readFile(join(room.repository, 'b.md'), 'utf8')).toBe('b, from House\n');
  expect(await readFile(join(room.repository, 'a.md'), 'utf8')).toBe('a, local\n');
  expect(listed(hosted)).toHaveLength(2);
});

it('copies a Room it waits for in the download its next connection opens with, with no notice', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  rooms.carriedDocuments = 0;
  rooms.notReady.set(room.ref, 1);

  expect(await rooms.download([room])).toMatchObject({ status: 0, stdout: `${room.root}: ${NOT_READY}\n` });
  hosted.connection.close(1012, 'deploy');
  await until(() => hosted.house.connections[1]);

  await until(() => existsSync(record(hosted, room)));
  expect(listed(hosted)).toHaveLength(2);
  expect(tracked(room)).toEqual(['a.md']);
});

it("keeps waiting for a Room answered not ready when another Room's read fails in the same fetch, and asks it again at its notice", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const regranted = rooms.room('regranted');
  regranted.put('a.md', 'a\n');
  const other = rooms.room('other');
  other.put('b.md', 'b\n');
  await rooms.download([regranted, other]);
  regranted.protected = [...regranted.protected, 'archive'];
  rooms.notReady.set(regranted.ref, 1);
  rooms.reads = [false];

  const fetched = await house(hosted, '/', 'download');

  expect(fetched.status).toBe(1);
  expect(fetched.stderr).toContain(`${regranted.root}: ${NOT_READY}\n`);
  noticed(hosted, regranted);
  await until(() => listed(hosted).length >= 2);
  await until(async () => JSON.parse(await readFile(record(hosted, regranted), 'utf8')).protected.includes('archive'));
});

it('reads nothing of a Room at its notice once it left the selection while the Kit waited for it, and downloads a Room it follows at its notice', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  const held = rooms.room('held');
  held.put('b.md', 'b\n');
  rooms.carriedDocuments = 0;
  rooms.notReady.set(room.ref, 1);

  expect(await rooms.download([room, held])).toMatchObject({ status: 0 });
  expect(await rooms.download([held])).toMatchObject({ status: 0 });
  const read = copyReads(hosted).length;

  noticed(hosted, room);
  noticed(hosted, held);
  await unasked();

  expect(copyReads(hosted).slice(read)).toEqual([
    '/kit/local-copies/selection/read',
    '/kit/local-copies/selection/read',
    '/kit/door/rooms/discover',
    '/kit/door/changes/enumerate',
  ]);
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

  expect(await rooms.download([room])).toMatchObject({ stderr: '', status: 0 });

  const whole = hosted.store.requests.filter((request) => request.key.startsWith('room-chunks/') && request.status === 200).map((request) => request.key);
  expect(new Set(whole).size).toBe(whole.length);
  expect(tracked(room)).toHaveLength(8);
  expect(listed(hosted)).toHaveLength(2);
});

it("sweeps the staging its Kit left when stopped during a copy as it starts again, and leaves another Kit's", async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], { workspace });
  const rooms = serveRooms(hosted);
  const room = rooms.room('large');
  room.put('a.md', 'a\n');
  rooms.expired.add(room.ref);
  const copies = join(workspace, 'rooms');
  const staged = async () => (await readdir(copies).catch(() => [])).filter((name) => name.startsWith('.'));
  const release = hosted.store.holdReads();

  const stopped = rooms.download([room]).catch(() => undefined);
  await until(() => hosted.store.reading >= 1);
  const kits = await staged();
  expect(kits.length).toBeGreaterThan(0);
  await mkdir(join(copies, '.another-kit'));
  release();
  await hosted.restart();
  await stopped;

  await until(async () => (await staged()).every((name) => !kits.includes(name)));
  expect((await staged()).filter((name) => !name.endsWith('work'))).toEqual(['.another-kit']);
});

it('removes what a copy staged when its chunks cannot be read', async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], { workspace });
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  rooms.expired.add(room.ref);
  rooms.damagesChunks = true;

  expect((await rooms.download([room])).status).toBe(1);

  expect(await readdir(join(workspace, 'rooms'))).toEqual([]);
});

it('asks the list again when a chunk address expired, and downloads only the chunks it lacks', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('large');
  const text = 'x'.repeat(600_000);
  for (let document = 0; document < 8; document += 1) room.put(`d${document}.md`, `${text}${document}\n`);
  rooms.expired.add(room.ref);
  rooms.expiringChunks = 1;

  expect(await rooms.download([room])).toMatchObject({ status: 0 });

  expect(listed(hosted)).toHaveLength(2);
  expect(tracked(room)).toHaveLength(8);
  const reads = hosted.store.requests.filter((request) => request.key.startsWith('room-chunks/'));
  const whole = reads.filter((request) => request.status === 200).map((request) => request.key);
  expect(new Set(whole).size).toBe(whole.length);
  expect(reads.filter((request) => request.status === 403)).toHaveLength(1);
});

it("refuses a chunk that did not arrive whole or whose text cannot be read, and keeps the copy and its manifest where they were", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  await rooms.download([room]);
  const before = await manifestOf(room);
  room.put('a.md', 'a, later\n');
  room.put('b.md', 'b\n');
  rooms.expired.add(room.ref);
  rooms.damagesChunks = true;

  expect((await house(hosted, '/', 'download')).status).toBe(1);
  expect(await manifestOf(room)).toEqual(before);

  rooms.damagesChunks = false;
  rooms.unparsedChunks = true;
  rooms.expired.add(room.ref);

  expect((await house(hosted, '/', 'download')).status).toBe(1);
  expect(await manifestOf(room)).toEqual(before);
  expect(await readFile(join(room.repository, 'a.md'), 'utf8')).toBe('a\n');
  expect((await readdir(dirname(room.repository))).filter((name) => name.startsWith('.') && !name.endsWith('work'))).toEqual([]);

  rooms.unparsedChunks = false;
  expect(await house(hosted, '/', 'download')).toMatchObject({ status: 0 });
  expect(await readFile(join(room.repository, 'a.md'), 'utf8')).toBe('a, later\n');
});

it("copies a Room larger than the former bundle limit with the Kit's heap capped far below the Room and its peak memory under half of it", { timeout: 300_000 }, async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], { node: [`--max-old-space-size=${KIT_HEAP_MEGABYTES}`], workspace });
  const rooms = serveRooms(hosted);
  const room = rooms.room('large');
  const text = `${'a line of a large document\n'.repeat(37_000)}`;
  const documents = Math.ceil(FORMER_BUNDLE_BYTES / text.length) + 20;
  for (let document = 0; document < documents; document += 1) room.put(`d/${document}.md`, `${document}\n${text}`);
  rooms.expired.add(room.ref);

  const copying = await rooms.download([room]);
  expect({ ...copying, kit: hosted.kit.stderr() }).toMatchObject({ stderr: '', kit: '', status: 0 });

  const repository = join(workspace, 'rooms', room.handle);
  const written = await stat(join(repository, 'd/0.md'));
  expect(written.size * documents).toBeGreaterThan(FORMER_BUNDLE_BYTES);
  expect(tracked(room, repository)).toHaveLength(documents);
  const peak = /VmHWM:\s+(\d+) kB/.exec(await readFile(`/proc/${hosted.kit.pid}/status`, 'utf8'))![1]!;
  expect(Number(peak) * 1024).toBeLessThan(FORMER_BUNDLE_BYTES / 2);
});

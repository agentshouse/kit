import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { until, type Received } from './double.ts';
import { conversationCredential, hostKit, opened, type Hosted, type McpCall } from './environment.ts';
import { commitAll, git, house, serveRooms, tryGit, type Room, type Rooms } from './rooms.ts';

const FAST_TIMEOUTS = fileURLToPath(new URL('./fast-timeouts.ts', import.meta.url));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const REDRAWN = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66]);
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
const RECORDING = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]);

const UNSENT = 'house push again resumes this push and sends only what it has not sent';
const STORED = 'limit_reached: this file would pass your storage limit';
const STORAGE = {
  status: 429,
  body: { error: { code: 'limit_reached', limit: 'blob', value: '1000', used: '990', message: STORED, retryable: false } },
};

interface Shelled {
  status: number;
  stdout: string;
  stderr: string;
}

interface CopyRecord {
  manifests: { [commit: string]: { files: { [path: string]: string | null }; binary?: { [path: string]: unknown } } };
  push?: unknown;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

function part(path: string, bytes: Buffer, mediaType: string, base?: string): Record<string, unknown> {
  return {
    op: 'upload',
    path: `/rooms/notes/${path}`,
    ...(base === undefined ? {} : { base }),
    bytes: bytes.length,
    sha256: digest(bytes),
    media_type: mediaType,
  };
}

function batches(hosted: Hosted): { operation_id: string; changes: Record<string, unknown>[] }[] {
  return hosted.house.requests
    .filter((request) => request.path === '/kit/door/files/batch')
    .map((request) => request.body as { operation_id: string; changes: Record<string, unknown>[] });
}

function called(received: Received): McpCall['params'] {
  return (received.body as McpCall).params;
}

function toolBatches(hosted: Hosted): Received[] {
  return hosted.mcp.filter((received) => called(received).name === 'files_batch');
}

function operationOf(received: Received): string {
  return (received.body as { params: { _meta: Record<string, string> } }).params._meta['agents.house/agent-operation']!;
}

function puts(hosted: Hosted): [number | null, number][] {
  return hosted.store.requests.filter((request) => request.method === 'PUT').map((request) => [request.part, request.status]);
}

function gets(hosted: Hosted): number {
  return hosted.store.requests.filter((request) => request.method === 'GET').length;
}

function blobAt(room: Room, revision: string, path: string): Buffer | null {
  const shown = spawnSync('git', ['cat-file', 'blob', `${revision}:${path}`], { cwd: room.repository });
  return shown.status === 0 ? shown.stdout : null;
}

function clean(room: Room): void {
  expect(git(room.repository, 'status', '--porcelain')).toBe('');
  expect(git(room.repository, 'diff', '--stat', 'HEAD', 'refs/house/received')).toBe('');
}

async function record(hosted: Hosted, room: Room): Promise<CopyRecord> {
  return JSON.parse(await readFile(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`), 'utf8')) as CopyRecord;
}

async function ownAgent(hosted: Hosted): Promise<void> {
  await writeFile(join(hosted.home, 'own-agent.json'), JSON.stringify({ house: hosted.house.origin, user: 'user-one', credential: 'ahp_own' }));
}

async function placed(room: Room, files: { [path: string]: Buffer | string }): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(room.repository, path, '..'), { recursive: true });
    await writeFile(join(room.repository, path), content);
  }
}

async function ran(hosted: Hosted, line: string): Promise<Shelled> {
  const before = (await hosted.adapterLog()).filter((entry) => 'sh' in entry).length;
  hosted.call({ kind: 'message', text: line, first: false });
  return until(async () => (await hosted.adapterLog()).filter((entry) => 'sh' in entry)[before] as unknown as Shelled | undefined);
}

async function copied(
  setup: (room: Room) => void = () => {},
  node?: string[],
): Promise<{ hosted: Hosted; rooms: Rooms; room: Room }> {
  const hosted = await hostKit([{}], node === undefined ? {} : { node });
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('ROOM.md', 'The notes Room\n');
  room.put('plan.md', 'one\n');
  setup(room);
  await rooms.fetch([room]);
  return { hosted, rooms, room };
}

it('pushes a commit of text and binary files once as the owner, each binary file staged in its parts, and the Room holds every file with its bytes', async () => {
  const { hosted, rooms, room } = await copied();
  rooms.authoredFileBytes = 64;
  const log = 'a'.repeat(65);
  const nul = 'valid UTF-8 \0 with a NUL\n';
  await placed(room, { 'scans/cover.jpg': JPEG, 'scans/report.pdf': PDF, 'notes.txt': nul, 'log.txt': log, 'plan.md': 'one\ntwo\n' });
  const commit = commitAll(room.repository, 'a folder');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  const sent = [
    part('log.txt', Buffer.from(log), 'text/plain'),
    part('notes.txt', Buffer.from(nul), 'text/plain'),
    { op: 'replace_preamble', path: '/rooms/notes/plan.md', base: 'one\n', content: 'one\ntwo\n' },
    part('scans/cover.jpg', JPEG, 'image/jpeg'),
    part('scans/report.pdf', PDF, 'application/pdf'),
  ];
  expect(batches(hosted).map((batch) => batch.changes)).toEqual([sent, sent]);
  expect(new Set(batches(hosted).map((batch) => batch.operation_id)).size).toBe(1);
  expect(room.batches).toHaveLength(1);
  expect(room.files.get('plan.md')!.content).toBe('one\ntwo\n');
  const held = { 'log.txt': Buffer.from(log), 'notes.txt': Buffer.from(nul), 'scans/cover.jpg': JPEG, 'scans/report.pdf': PDF };
  for (const [path, bytes] of Object.entries(held)) expect(digest(room.binaries.get(path)!.bytes)).toBe(digest(bytes));
  expect(puts(hosted).filter(([, status]) => status === 200)).toHaveLength(9 + 4 + 2 + 2);
  clean(room);
  const manifest = (await record(hosted, room)).manifests[git(room.repository, 'rev-parse', 'refs/house/received').trim()]!;
  expect(manifest.binary).toEqual(
    Object.fromEntries(Object.entries(held).map(([path, bytes]) => [path, { bytes: bytes.length, sha256: digest(bytes) }])),
  );
  for (const path of Object.keys(held)) expect(manifest.files[path]).toBe(room.binaries.get(path)!.revision);

  const fetched = await house(hosted, '/', 'fetch');
  const again = await house(hosted, room.repository, 'push', '--owner');

  expect(fetched.status).toBe(0);
  clean(room);
  expect(again).toEqual({ status: 0, stdout: `Nothing to submit: ${short(commit)} matches House.\n`, stderr: '' });
  expect(hosted.mcp).toEqual([]);
  expect(gets(hosted)).toBe(0);
});

it("pushes text and a binary file under the conversation's own credential, finishing each staged upload through upload, and a fetch there brings the held file's new bytes", async () => {
  const { hosted, room } = await copied();
  await opened(hosted);
  await placed(room, { 'photo.jpg': JPEG, 'plan.md': 'one\ntwo\n' });
  const commit = commitAll(room.repository, 'a photo');

  const pushed = await ran(hosted, `@sh cd ${room.repository} && house push`);
  const pushedRevision = room.binaries.get('photo.jpg')!.revision;
  room.upload('photo.jpg', REDRAWN);
  const fetched = await ran(hosted, `@sh cd ${room.repository} && house fetch && git merge -q --ff-only refs/house/received`);

  expect(pushed).toMatchObject({ status: 0, stdout: `House accepted ${short(commit)}.\n` });
  expect(fetched.status).toBe(0);
  expect(pushedRevision).not.toBe(room.binaries.get('photo.jpg')!.revision);
  const credential = `Bearer ${conversationCredential('conversation-1')}`;
  const finishing = { upload: expect.any(String), room_ref: room.ref, part_sha256: [JPEG.subarray(0, 8), JPEG.subarray(8)].map(digest) };
  expect(hosted.mcp.map((received) => [received.headers.authorization, called(received).name, called(received).arguments])).toEqual([
    [credential, 'files_batch', { changes: expect.any(Array) }],
    [credential, 'upload', finishing],
    [credential, 'upload', finishing],
    [credential, 'files_batch', { changes: expect.any(Array) }],
    [credential, 'info', { path: '/rooms/notes/photo.jpg', ref: room.binaries.get('photo.jpg')!.revision }],
  ]);
  expect(called(hosted.mcp[0]!).arguments!.changes).toEqual([
    part('photo.jpg', JPEG, 'image/jpeg'),
    { op: 'replace_preamble', path: '/rooms/notes/plan.md', base: 'one\n', content: 'one\ntwo\n' },
  ]);
  expect(new Set(toolBatches(hosted).map(operationOf)).size).toBe(1);
  expect(await readFile(join(room.repository, 'photo.jpg'))).toEqual(REDRAWN);
  clean(room);
});

it('sends a changed binary file against its base, removes a removed one and replaces each path whose kind changed, in one push', async () => {
  const { hosted, room } = await copied((setup) => setup.put('notes.txt', 'text first\n'));
  await placed(room, { 'cover.jpg': JPEG, 'report.pdf': PDF, 'data.bin': RECORDING });
  commitAll(room.repository, 'binary files');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  const revisions = Object.fromEntries(['cover.jpg', 'report.pdf', 'data.bin'].map((path) => [path, room.binaries.get(path)!.revision]));
  const notes = room.revision('notes.txt');
  await placed(room, { 'cover.jpg': REDRAWN, 'data.bin': 'now text\n', 'notes.txt': JPEG });
  await rm(join(room.repository, 'report.pdf'));
  const commit = commitAll(room.repository, 'changed');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted).at(-1)!.changes).toEqual([
    part('cover.jpg', REDRAWN, 'image/jpeg', revisions['cover.jpg']),
    { op: 'remove', path: '/rooms/notes/data.bin', base: revisions['data.bin'] },
    { op: 'create', path: '/rooms/notes/data.bin', content: 'now text\n' },
    { op: 'remove', path: '/rooms/notes/notes.txt', base: notes },
    part('notes.txt', JPEG, 'text/plain'),
    { op: 'remove', path: '/rooms/notes/report.pdf', base: revisions['report.pdf'] },
  ]);
  expect(digest(room.binaries.get('cover.jpg')!.bytes)).toBe(digest(REDRAWN));
  expect(digest(room.binaries.get('notes.txt')!.bytes)).toBe(digest(JPEG));
  expect(room.files.get('data.bin')!.content).toBe('now text\n');
  expect([room.binaries.has('report.pdf'), room.binaries.has('data.bin'), room.files.has('notes.txt')]).toEqual([false, false, false]);
  clean(room);
  const manifest = (await record(hosted, room)).manifests[git(room.repository, 'rev-parse', 'refs/house/received').trim()]!;
  expect(Object.keys(manifest.binary!).sort()).toEqual(['cover.jpg', 'notes.txt']);
});

it("sends a text of exactly the authored-file cap House's discovery answers as text, and one byte more as a binary file in its place", async () => {
  const { hosted, rooms, room } = await copied();
  rooms.authoredFileBytes = 64;
  await placed(room, { 'log.txt': 'ü'.repeat(32) });
  commitAll(room.repository, 'at the cap');

  const at = await house(hosted, room.repository, 'push', '--owner');
  const text = room.revision('log.txt');
  await placed(room, { 'log.txt': `${'ü'.repeat(32)}!` });
  commitAll(room.repository, 'one byte above the cap');
  const above = await house(hosted, room.repository, 'push', '--owner');

  expect(at).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}/) });
  expect(above).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}/) });
  expect(batches(hosted).map((batch) => batch.changes)).toEqual([
    [{ op: 'create', path: '/rooms/notes/log.txt', content: 'ü'.repeat(32) }],
    [{ op: 'remove', path: '/rooms/notes/log.txt', base: text }, part('log.txt', Buffer.from(`${'ü'.repeat(32)}!`), 'text/plain')],
    [{ op: 'remove', path: '/rooms/notes/log.txt', base: text }, part('log.txt', Buffer.from(`${'ü'.repeat(32)}!`), 'text/plain')],
  ]);
  expect(room.binaries.get('log.txt')!.bytes.toString('utf8')).toBe(`${'ü'.repeat(32)}!`);
});

it('refuses a push holding a .md file that is not text before any House mutation, naming it, and keeps no pending push', async () => {
  const { hosted, room } = await copied();
  await placed(room, { 'notes.md': 'valid UTF-8 \0 with a NUL\n', 'photo.jpg': JPEG });
  commitAll(room.repository, 'a NUL in Markdown');

  const refused = await house(hosted, room.repository, 'push', '--owner');

  expect(refused).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: notes.md is Markdown, which holds text only: UTF-8 without NUL, at most 1000000 bytes; commit it as text and push again\n',
  });
  expect(batches(hosted)).toEqual([]);
  expect(hosted.store.requests).toEqual([]);
  expect((await record(hosted, room)).push).toBeUndefined();
  expect([room.files.has('notes.md'), room.binaries.has('photo.jpg')]).toEqual([false, false]);
});

it('stops a push the Write limit refuses, naming each binary file it has not sent with its reason and time, and house push again from a conversation sends only those and commits once', async () => {
  const { hosted, rooms, room } = await copied();
  await opened(hosted);
  rooms.writeUnits = 2;
  await placed(room, { 'a.jpg': JPEG, 'b.pdf': PDF, 'c.bin': RECORDING, 'plan.md': 'one\ntwo\n' });
  const commit = commitAll(room.repository, 'three binary files');

  const stopped = await house(hosted, room.repository, 'push', '--owner');
  const stoppedPuts = puts(hosted).length;
  const unchanged = [room.batches.length, room.files.get('plan.md')!.content, room.binaries.size];
  rooms.writeUnits = 2;
  const resumed = await ran(hosted, `@sh cd ${room.repository} && house push`);

  expect(stopped).toEqual({
    status: 1,
    stdout: '',
    stderr: [
      `house: House holds nothing of ${short(commit)} yet, so /rooms/notes is unchanged; these binary files are not sent:`,
      "c.bin: limit_reached: you reached today's Write limit; try again at 2026-11-17T00:00:00.000Z",
      UNSENT,
      '',
    ].join('\n'),
  });
  expect(unchanged).toEqual([0, 'one\n', 0]);
  expect(resumed).toMatchObject({ status: 0, stdout: `House accepted ${short(commit)}.\n` });
  expect([batches(hosted).length, toolBatches(hosted).length]).toEqual([2, 2]);
  const operations = [...batches(hosted).map((batch) => batch.operation_id), ...toolBatches(hosted).map(operationOf)];
  expect(new Set(operations).size).toBe(1);
  expect(puts(hosted).slice(stoppedPuts)).toEqual([[1, 200]]);
  expect(room.batches).toHaveLength(1);
  for (const [path, bytes] of [['a.jpg', JPEG], ['b.pdf', PDF], ['c.bin', RECORDING]] as const) {
    expect(digest(room.binaries.get(path)!.bytes)).toBe(digest(bytes));
  }
  clean(room);
});

it("stops a conversation's push the open-uploads cap refuses without sending it again, and the next push lands it under the same operation", async () => {
  const { hosted, rooms, room } = await copied();
  await opened(hosted);
  rooms.openUploads = 0;
  await placed(room, { 'photo.jpg': JPEG });
  const commit = commitAll(room.repository, 'a photo');

  const stopped = await ran(hosted, `@sh cd ${room.repository} && house push`);
  const sent = rooms.edits().length;
  rooms.openUploads = 10;
  const landed = await ran(hosted, `@sh cd ${room.repository} && house push`);

  expect(stopped).toMatchObject({
    status: 1,
    stderr: [
      `house: House holds nothing of ${short(commit)} yet, so /rooms/notes is unchanged; these binary files are not sent:`,
      'photo.jpg: cap_reached: you hold the most uploads open at once; try again at 2026-11-17T00:00:00.000Z',
      UNSENT,
      '',
    ].join('\n'),
  });
  expect(sent).toBe(1);
  expect(landed).toMatchObject({ status: 0, stdout: `House accepted ${short(commit)}.\n` });
  expect(new Set(rooms.edits().map(operationOf)).size).toBe(1);
  expect(digest(room.binaries.get('photo.jpg')!.bytes)).toBe(digest(JPEG));
});

it('pushes another commit as a new push after a push stopped, and the stopped commit never reaches the Room', async () => {
  const { hosted, rooms, room } = await copied();
  rooms.writeUnits = 0;
  await placed(room, { 'photo.jpg': JPEG, 'plan.md': 'one\ntwo\n' });
  commitAll(room.repository, 'a photo');
  const stopped = await house(hosted, room.repository, 'push', '--owner');
  rooms.writeUnits = Infinity;
  await rm(join(room.repository, 'photo.jpg'));
  git(room.repository, 'add', '-A');
  git(room.repository, 'commit', '-q', '--amend', '-m', 'the plan alone');
  const commit = git(room.repository, 'rev-parse', 'HEAD').trim();

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(stopped.status).toBe(1);
  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  const [first, last] = [batches(hosted)[0]!, batches(hosted).at(-1)!];
  expect(last.operation_id).not.toBe(first.operation_id);
  expect(last.changes).toEqual([{ op: 'replace_preamble', path: '/rooms/notes/plan.md', base: 'one\n', content: 'one\ntwo\n' }]);
  expect(room.binaries.has('photo.jpg')).toBe(false);
  expect(room.files.get('plan.md')!.content).toBe('one\ntwo\n');
  expect((await record(hosted, room)).push).toBeUndefined();
  clean(room);
});

it("ends a push House refuses past the owner's storage as final, keeping no pending push, so the next push is a new one", async () => {
  const { hosted, rooms, room } = await copied();
  rooms.refusesBatches = [STORAGE];
  await placed(room, { 'photo.jpg': JPEG });
  const commit = commitAll(room.repository, 'a photo');

  const refused = await house(hosted, room.repository, 'push', '--owner');
  const pending = (await record(hosted, room)).push;
  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(refused).toEqual({ status: 1, stdout: '', stderr: `house: ${STORED}\n` });
  expect(pending).toBeUndefined();
  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  const [first, ...rest] = batches(hosted).map((batch) => batch.operation_id);
  expect(rest).toHaveLength(2);
  expect(new Set(rest).size).toBe(1);
  expect(rest).not.toContain(first);
});

it('lands a push of more binary files than House opens at once in turns under its one operation', async () => {
  const { hosted, rooms, room } = await copied();
  rooms.openUploads = 1;
  await placed(room, { 'a.jpg': JPEG, 'b.pdf': PDF, 'c.bin': RECORDING });
  const commit = commitAll(room.repository, 'three binary files');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted)).toHaveLength(4);
  expect(new Set(batches(hosted).map((batch) => batch.operation_id)).size).toBe(1);
  expect(room.batches).toHaveLength(1);
  expect([...room.binaries.keys()].sort()).toEqual(['a.jpg', 'b.pdf', 'c.bin']);
});

it('sends at most ten binary files of a push to the store at once', async () => {
  const { hosted, rooms, room } = await copied();
  rooms.openUploads = 20;
  await placed(room, Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`scans/${index}.bin`, Buffer.from([0xff, index])])));
  commitAll(room.repository, 'twelve binary files');
  const release = hosted.store.holdWrites();

  const pushing = house(hosted, room.repository, 'push', '--owner');
  await until(() => hosted.store.writing === 10);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const writing = hosted.store.writing;
  release();

  expect(writing).toBe(10);
  expect(await pushing).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}\.\n$/) });
  expect(room.binaries.size).toBe(12);
});

it('keeps a push a failed transfer stops, and resumes it after the Kit restarts under its operation, sending only the part the store lacks', async () => {
  const { hosted, room } = await copied(undefined, ['--import', FAST_TIMEOUTS]);
  hosted.store.failing.add(2);
  await placed(room, { 'photo.jpg': JPEG });
  const commit = commitAll(room.repository, 'a photo');

  const stopped = await house(hosted, room.repository, 'push', '--owner');
  hosted.store.failing.clear();
  await hosted.restart();
  const resumed = await house(hosted, room.repository, 'push', '--owner');

  expect(stopped).toEqual({
    status: 1,
    stdout: '',
    stderr: [
      `house: House holds nothing of ${short(commit)} yet, so /rooms/notes is unchanged; these binary files are not sent:`,
      'photo.jpg: its transfer failed: the store answered 500',
      UNSENT,
      '',
    ].join('\n'),
  });
  expect(resumed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(new Set(batches(hosted).map((batch) => batch.operation_id)).size).toBe(1);
  const sent = puts(hosted);
  expect(sent.filter(([index]) => index === 1)).toEqual([[1, 200]]);
  expect(sent.at(-1)).toEqual([2, 200]);
  expect(sent.filter(([, status]) => status === 200)).toHaveLength(2);
  expect(digest(room.binaries.get('photo.jpg')!.bytes)).toBe(digest(JPEG));
  expect(room.batches).toHaveLength(1);
});

it('keeps each binary file the Local copy holds current on house fetch, moving or removing it as the Room does, and never downloads one it does not hold', async () => {
  const { hosted, room } = await copied();
  await ownAgent(hosted);
  await placed(room, { 'scans/cover.jpg': JPEG, 'scans/report.pdf': PDF, 'photo.jpg': RECORDING });
  commitAll(room.repository, 'binary files');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  room.upload('scans/cover.jpg', REDRAWN);
  room.move('scans/report.pdf', 'archive/report.pdf');
  room.remove('photo.jpg');
  room.upload('elsewhere.jpg', JPEG);
  const asked = hosted.mcp.length;

  const fetched = await house(hosted, '/', 'fetch');
  git(room.repository, 'merge', '-q', '--ff-only', 'refs/house/received');
  const again = await house(hosted, '/', 'fetch');

  expect(fetched.status).toBe(0);
  expect(again.status).toBe(0);
  expect(await readFile(join(room.repository, 'scans/cover.jpg'))).toEqual(REDRAWN);
  expect(await readFile(join(room.repository, 'archive/report.pdf'))).toEqual(PDF);
  for (const path of ['scans/report.pdf', 'photo.jpg', 'elsewhere.jpg']) {
    expect(existsSync(join(room.repository, path))).toBe(false);
    expect(blobAt(room, 'refs/house/received', path)).toBeNull();
  }
  expect(hosted.mcp.slice(asked).map((received) => [received.headers.authorization, called(received).name, called(received).arguments])).toEqual([
    ['Bearer ahp_own', 'info', { path: '/rooms/notes/scans/cover.jpg', ref: room.binaries.get('scans/cover.jpg')!.revision }],
  ]);
  expect(gets(hosted)).toBe(1);
  clean(room);
  const manifest = (await record(hosted, room)).manifests[git(room.repository, 'rev-parse', 'refs/house/received').trim()]!;
  expect(manifest.binary).toEqual({
    'archive/report.pdf': { bytes: PDF.length, sha256: digest(PDF) },
    'scans/cover.jpg': { bytes: REDRAWN.length, sha256: digest(REDRAWN) },
  });
});

it('drops a held text file another writer replaces with a binary file on house fetch, downloading nothing the copy does not hold', async () => {
  const { hosted, room } = await copied((setup) => setup.put('notes.txt', 'text first\n'));
  await ownAgent(hosted);
  room.upload('notes.txt', JPEG);
  const [asked, got] = [hosted.mcp.length, gets(hosted)];

  const fetched = await house(hosted, '/', 'fetch');
  git(room.repository, 'merge', '-q', '--ff-only', 'refs/house/received');

  expect(fetched.status).toBe(0);
  expect(hosted.mcp.slice(asked)).toEqual([]);
  expect(gets(hosted)).toBe(got);
  expect(blobAt(room, 'refs/house/received', 'notes.txt')).toBeNull();
  expect(existsSync(join(room.repository, 'notes.txt'))).toBe(false);
  clean(room);
  const manifest = (await record(hosted, room)).manifests[git(room.repository, 'rev-parse', 'refs/house/received').trim()]!;
  expect(manifest).toEqual({ parent: expect.any(String), files: { 'notes.txt': null } });
});

it('keeps every binary file the Local copy holds through a whole reread, so the next push sends no removal of one', async () => {
  const { hosted, rooms, room } = await copied();
  await placed(room, { 'photo.jpg': JPEG });
  commitAll(room.repository, 'a photo');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  room.put('plan.md', 'one\nfrom elsewhere\n');
  room.upload('elsewhere.jpg', REDRAWN);
  rooms.expired.add(room.ref);

  const fetched = await house(hosted, '/', 'fetch');
  const reread = (await record(hosted, room)).manifests[git(room.repository, 'rev-parse', 'refs/house/received').trim()]!;
  git(room.repository, 'merge', '-q', '--ff-only', 'refs/house/received');
  await placed(room, { 'notes.txt': 'mine\n' });
  const commit = commitAll(room.repository, 'notes');
  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(fetched.status).toBe(0);
  expect(rooms.expired.has(room.ref)).toBe(false);
  expect(reread.binary).toEqual({ 'photo.jpg': { bytes: JPEG.length, sha256: digest(JPEG) } });
  expect(await readFile(join(room.repository, 'photo.jpg'))).toEqual(JPEG);
  expect(await readFile(join(room.repository, 'plan.md'), 'utf8')).toBe('one\nfrom elsewhere\n');
  expect(existsSync(join(room.repository, 'elsewhere.jpg'))).toBe(false);
  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted).at(-1)!.changes).toEqual([{ op: 'create', path: '/rooms/notes/notes.txt', content: 'mine\n' }]);
  expect(digest(room.binaries.get('photo.jpg')!.bytes)).toBe(digest(JPEG));
  expect(hosted.store.requests.filter((request) => request.method === 'GET' && request.key.startsWith('binary/'))).toEqual([]);
  clean(room);
});

it('brings the current version of each binary file a push conflicts with onto the House ref, and a native Git resolution then pushes', async () => {
  const { hosted, room } = await copied((setup) => {
    setup.upload('photo.jpg', JPEG);
    setup.upload('scan.pdf', PDF);
  });
  await ownAgent(hosted);
  const held = room.binaries.get('photo.jpg')!.revision;
  await placed(room, { 'photo.jpg': REDRAWN, 'scan.pdf': 'a caption where House holds a scan\n' });
  commitAll(room.repository, 'mine');

  const refused = await house(hosted, room.repository, 'push', '--owner');

  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('code: base_required');
  expect(refused.stderr).toContain('code: binary_file');
  expect(refused.stderr).toMatch(/refs\/house\/received holds House's current state; rebase onto it and push again\n$/);
  expect(blobAt(room, 'refs/house/received', 'photo.jpg')).toEqual(JPEG);
  expect(blobAt(room, 'refs/house/received', 'scan.pdf')).toEqual(PDF);
  expect(room.batches).toHaveLength(0);
  expect(tryGit(room.repository, 'merge', '-q', 'refs/house/received').status).not.toBe(0);
  git(room.repository, 'checkout', '--ours', 'photo.jpg');
  git(room.repository, 'checkout', '--theirs', 'scan.pdf');
  git(room.repository, 'add', 'photo.jpg', 'scan.pdf');
  git(room.repository, 'commit', '-q', '--no-edit');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}/) });
  expect(batches(hosted).at(-1)!.changes).toEqual([part('photo.jpg', REDRAWN, 'image/jpeg', held)]);
  expect(digest(room.binaries.get('photo.jpg')!.bytes)).toBe(digest(REDRAWN));
  expect(digest(room.binaries.get('scan.pdf')!.bytes)).toBe(digest(PDF));
  clean(room);
});

it('ends a push whose new binary file meets text another writer put at its Path with the rebase line, and the resolution replaces that text', async () => {
  const { hosted, room } = await copied();
  const caption = room.put('caption.txt', 'a caption another writer wrote\n');
  await placed(room, { 'caption.txt': RECORDING });
  commitAll(room.repository, 'a recording');

  const refused = await house(hosted, room.repository, 'push', '--owner');

  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('code: text_file');
  expect(refused.stderr).toMatch(/refs\/house\/received holds House's current state; rebase onto it and push again\n$/);
  expect(blobAt(room, 'refs/house/received', 'caption.txt')?.toString('utf8')).toBe('a caption another writer wrote\n');
  expect(tryGit(room.repository, 'merge', '-q', 'refs/house/received').status).not.toBe(0);
  git(room.repository, 'checkout', '--ours', 'caption.txt');
  git(room.repository, 'add', 'caption.txt');
  git(room.repository, 'commit', '-q', '--no-edit');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}/) });
  expect(batches(hosted).at(-1)!.changes).toEqual([
    { op: 'remove', path: '/rooms/notes/caption.txt', base: caption },
    part('caption.txt', RECORDING, 'text/plain'),
  ]);
  expect(digest(room.binaries.get('caption.txt')!.bytes)).toBe(digest(RECORDING));
  expect(room.files.has('caption.txt')).toBe(false);
  clean(room);
});

it('keeps every manifest an earlier push wrote as it was, and adds the binary fields only to the manifests of a push that carries a binary file', async () => {
  const { hosted, room } = await copied();
  await placed(room, { 'plan.md': 'one\ntwo\n' });
  commitAll(room.repository, 'text');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  const before = (await record(hosted, room)).manifests;
  await placed(room, { 'photo.jpg': JPEG });
  commitAll(room.repository, 'a photo');

  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);

  const after = (await record(hosted, room)).manifests;
  expect(Object.values(before).some((manifest) => 'binary' in manifest)).toBe(false);
  for (const [commit, manifest] of Object.entries(before)) expect(after[commit]).toEqual(manifest);
  expect(
    Object.entries(after)
      .filter(([commit]) => !(commit in before))
      .map(([, manifest]) => manifest.binary),
  ).toEqual([{ 'photo.jpg': { bytes: JPEG.length, sha256: digest(JPEG) } }, { 'photo.jpg': { bytes: JPEG.length, sha256: digest(JPEG) } }]);
});

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
    .filter((request) => request.path === '/kit/door/update')
    .map((request) => request.body as { operation_id: string; changes: Record<string, unknown>[] });
}

function called(received: Received): McpCall['params'] {
  return (received.body as McpCall).params;
}

function toolBatches(hosted: Hosted): Received[] {
  return hosted.mcp.filter((received) => called(received).name === 'update');
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

it("pushes text and a binary file under the conversation's own credential, finishing each staged upload through upload by the file's path in the Room, and a fetch there brings the held file's new bytes", async () => {
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
  const finishing = { upload: expect.any(String), path: '/rooms/notes/photo.jpg', part_sha256: [JPEG.subarray(0, 8), JPEG.subarray(8)].map(digest) };
  expect(hosted.mcp.map((received) => [received.headers.authorization, called(received).name, called(received).arguments])).toEqual([
    [credential, 'update', { changes: expect.any(Array) }],
    [credential, 'upload', finishing],
    [credential, 'upload', finishing],
    [credential, 'update', { changes: expect.any(Array) }],
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

it('sends a changed attachment against its base whatever its new bytes, removes a removed one and replaces a text House holds at a Path other than .md with an attachment, in one push', async () => {
  const { hosted, room } = await copied((setup) => setup.put('notes.txt', 'text first\n'));
  await placed(room, { 'cover.jpg': JPEG, 'report.pdf': PDF, 'data.bin': RECORDING });
  commitAll(room.repository, 'binary files');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  const revisions = Object.fromEntries(['cover.jpg', 'report.pdf', 'data.bin'].map((path) => [path, room.binaries.get(path)!.revision]));
  const notes = room.revision('notes.txt');
  await placed(room, { 'cover.jpg': REDRAWN, 'data.bin': 'now text\n', 'notes.txt': 'text second\n' });
  await rm(join(room.repository, 'report.pdf'));
  const commit = commitAll(room.repository, 'changed');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted).at(-1)!.changes).toEqual([
    part('cover.jpg', REDRAWN, 'image/jpeg', revisions['cover.jpg']),
    part('data.bin', Buffer.from('now text\n'), 'application/octet-stream', revisions['data.bin']),
    { op: 'remove', path: '/rooms/notes/notes.txt', base: notes },
    part('notes.txt', Buffer.from('text second\n'), 'text/plain'),
    { op: 'remove', path: '/rooms/notes/report.pdf', base: revisions['report.pdf'] },
  ]);
  expect(digest(room.binaries.get('cover.jpg')!.bytes)).toBe(digest(REDRAWN));
  expect(room.binaries.get('data.bin')!.bytes.toString('utf8')).toBe('now text\n');
  expect(room.binaries.get('notes.txt')!.bytes.toString('utf8')).toBe('text second\n');
  expect([room.binaries.has('report.pdf'), room.files.has('data.bin'), room.files.has('notes.txt')]).toEqual([false, false, false]);
  clean(room);
  const manifest = (await record(hosted, room)).manifests[git(room.repository, 'rev-parse', 'refs/house/received').trim()]!;
  expect(Object.keys(manifest.binary!).sort()).toEqual(['cover.jpg', 'data.bin', 'notes.txt']);
});

it('pushes each .md file as document text and every other file as an attachment whatever its bytes, asking Discovery only when a .md file arrives', async () => {
  const { hosted, room } = await copied();
  const discovered = () => hosted.house.requests.filter((request) => request.path === '/kit/door/rooms/discover').length;
  const text = { 'data.json': '{"one": 1}\n', 'notes.txt': 'plain words\n', 'src/main.ts': 'export const one = 1;\n' };
  await placed(room, text);
  const first = commitAll(room.repository, 'text that is no document');
  const before = discovered();
  const attached = await house(hosted, room.repository, 'push', '--owner');
  const asked = discovered() - before;
  const attachedManifest = (await record(hosted, room)).manifests[git(room.repository, 'rev-parse', 'refs/house/received').trim()]!;
  await placed(room, { 'plan.md': 'one\ntwo\n', 'README.MD': '# Read me\n' });
  const second = commitAll(room.repository, 'documents');
  const documents = await house(hosted, room.repository, 'push', '--owner');

  expect(attached).toEqual({ status: 0, stdout: `House accepted ${short(first)}.\n`, stderr: '' });
  expect(documents).toEqual({ status: 0, stdout: `House accepted ${short(second)}.\n`, stderr: '' });
  expect([asked, discovered() - before]).toEqual([0, 1]);
  expect(attachedManifest.binary).toEqual(
    Object.fromEntries(Object.entries(text).map(([path, content]) => [path, { bytes: Buffer.byteLength(content), sha256: digest(Buffer.from(content)) }])),
  );
  expect(batches(hosted).map((batch) => batch.changes)).toEqual([
    [
      part('data.json', Buffer.from(text['data.json']), 'application/json'),
      part('notes.txt', Buffer.from(text['notes.txt']), 'text/plain'),
      part('src/main.ts', Buffer.from(text['src/main.ts']), 'application/octet-stream'),
    ],
    [
      part('data.json', Buffer.from(text['data.json']), 'application/json'),
      part('notes.txt', Buffer.from(text['notes.txt']), 'text/plain'),
      part('src/main.ts', Buffer.from(text['src/main.ts']), 'application/octet-stream'),
    ],
    [
      { op: 'create', path: '/rooms/notes/README.MD', content: '# Read me\n' },
      { op: 'replace_preamble', path: '/rooms/notes/plan.md', base: 'one\n', content: 'one\ntwo\n' },
    ],
  ]);
  for (const [path, content] of Object.entries(text)) {
    expect(room.binaries.get(path)!.bytes.toString('utf8')).toBe(content);
    expect(room.files.has(path)).toBe(false);
  }
  expect([room.files.get('plan.md')!.content, room.files.get('README.MD')!.content]).toEqual(['one\ntwo\n', '# Read me\n']);
  clean(room);
});

it("sends a .md file of exactly the authored-file cap House's discovery answers as text, and refuses one byte more before any House mutation, naming it", async () => {
  const { hosted, rooms, room } = await copied();
  rooms.authoredFileBytes = 64;
  await placed(room, { 'log.md': 'ü'.repeat(32) });
  commitAll(room.repository, 'at the cap');

  const at = await house(hosted, room.repository, 'push', '--owner');
  await placed(room, { 'log.md': `${'ü'.repeat(32)}!` });
  commitAll(room.repository, 'one byte above the cap');
  const above = await house(hosted, room.repository, 'push', '--owner');

  expect(at).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}/) });
  expect(above).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: log.md is Markdown, which holds text only: UTF-8 without NUL, at most 64 bytes; commit it as text and push again\n',
  });
  expect(batches(hosted).map((batch) => batch.changes)).toEqual([[{ op: 'create', path: '/rooms/notes/log.md', content: 'ü'.repeat(32) }]]);
  expect(room.files.get('log.md')!.content).toBe('ü'.repeat(32));
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
      `house: House holds nothing of ${short(commit)} yet, so /rooms/notes is unchanged; these attachments are not sent:`,
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
      `house: House holds nothing of ${short(commit)} yet, so /rooms/notes is unchanged; these attachments are not sent:`,
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
      `house: House holds nothing of ${short(commit)} yet, so /rooms/notes is unchanged; these attachments are not sent:`,
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
  await placed(room, { 'notes.md': 'mine\n' });
  const commit = commitAll(room.repository, 'notes');
  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(fetched.status).toBe(0);
  expect(rooms.expired.has(room.ref)).toBe(false);
  expect(reread.binary).toEqual({ 'photo.jpg': { bytes: JPEG.length, sha256: digest(JPEG) } });
  expect(await readFile(join(room.repository, 'photo.jpg'))).toEqual(JPEG);
  expect(await readFile(join(room.repository, 'plan.md'), 'utf8')).toBe('one\nfrom elsewhere\n');
  expect(existsSync(join(room.repository, 'elsewhere.jpg'))).toBe(false);
  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted).at(-1)!.changes).toEqual([{ op: 'create', path: '/rooms/notes/notes.md', content: 'mine\n' }]);
  expect(digest(room.binaries.get('photo.jpg')!.bytes)).toBe(digest(JPEG));
  expect(hosted.store.requests.filter((request) => request.method === 'GET' && request.key.startsWith('binary/'))).toEqual([]);
  clean(room);
});

it('moves, updates or removes each held binary file across a whole reread as the Room did, downloading only the one another writer replaced', async () => {
  const { hosted, rooms, room } = await copied();
  await ownAgent(hosted);
  await placed(room, { 'scans/cover.jpg': JPEG, 'scans/report.pdf': PDF, 'photo.jpg': RECORDING });
  commitAll(room.repository, 'binary files');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  room.upload('scans/cover.jpg', REDRAWN);
  room.move('scans/report.pdf', 'archive/report.pdf');
  room.remove('photo.jpg');
  rooms.expired.add(room.ref);
  const downloads = () => hosted.store.requests.filter((request) => request.method === 'GET' && request.key.startsWith('binary/'));
  const got = downloads().length;

  const fetched = await house(hosted, '/', 'fetch');
  git(room.repository, 'merge', '-q', '--ff-only', 'refs/house/received');

  expect(fetched.status).toBe(0);
  expect(rooms.expired.has(room.ref)).toBe(false);
  expect(await readFile(join(room.repository, 'scans/cover.jpg'))).toEqual(REDRAWN);
  expect(await readFile(join(room.repository, 'archive/report.pdf'))).toEqual(PDF);
  for (const path of ['scans/report.pdf', 'photo.jpg']) expect(existsSync(join(room.repository, path))).toBe(false);
  expect(downloads()).toHaveLength(got + 1);
  clean(room);
  const manifest = (await record(hosted, room)).manifests[git(room.repository, 'rev-parse', 'refs/house/received').trim()]!;
  expect(manifest.binary).toEqual({
    'archive/report.pdf': { bytes: PDF.length, sha256: digest(PDF) },
    'scans/cover.jpg': { bytes: REDRAWN.length, sha256: digest(REDRAWN) },
  });
});

it('brings the current version of each attachment a push conflicts with onto the House ref, and a native Git resolution then pushes', async () => {
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
  expect(refused.stderr.match(/code: base_required/g)).toHaveLength(2);
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

it('renames a binary file a conversation moved with git mv into a folder, keeping its revision and sending no bytes, and the copy, clean after house fetch, holds it at its new Path and links it there', async () => {
  const { hosted, room } = await copied((setup) => setup.put('index.md', 'See ![a photo](photo.jpg).\n'));
  await placed(room, { 'photo.jpg': JPEG });
  commitAll(room.repository, 'a photo');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  const revision = room.binaries.get('photo.jpg')!.revision;
  const sent = puts(hosted).length;
  await opened(hosted);

  const moved = await ran(hosted, `@sh cd ${room.repository} && mkdir archive && git mv photo.jpg archive/photo.jpg && git commit -qm move && house push`);
  const fetched = await house(hosted, '/', 'fetch');

  expect(moved).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}; main is at [0-9a-f]{12}\.\n$/) });
  expect(hosted.mcp.map((received) => [called(received).name, called(received).arguments])).toEqual([
    ['update', { changes: [{ op: 'rename', path: '/rooms/notes/photo.jpg', to: '/rooms/notes/archive/photo.jpg', base: revision }] }],
  ]);
  expect(puts(hosted)).toHaveLength(sent);
  expect(room.binaries.has('photo.jpg')).toBe(false);
  expect(room.binaries.get('archive/photo.jpg')).toEqual({ revision, bytes: JPEG });
  expect(await readFile(join(room.repository, 'index.md'), 'utf8')).toBe('See ![a photo](archive/photo.jpg).\n');
  expect(fetched.status).toBe(0);
  expect(gets(hosted)).toBe(0);
  clean(room);
  await ownAgent(hosted);
  room.upload('archive/photo.jpg', REDRAWN);
  expect((await house(hosted, '/', 'fetch')).status).toBe(0);
  git(room.repository, 'merge', '-q', '--ff-only', 'refs/house/received');
  expect(await readFile(join(room.repository, 'archive/photo.jpg'))).toEqual(REDRAWN);
  clean(room);
});

it('sends a binary file a conversation moved with git mv and then redrew as its rename and its new bytes against the revision it had', async () => {
  const { hosted, room } = await copied();
  await placed(room, { 'photo.jpg': JPEG });
  commitAll(room.repository, 'a photo');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  const revision = room.binaries.get('photo.jpg')!.revision;
  await opened(hosted);
  expect((await ran(hosted, `@sh cd ${room.repository} && git mv photo.jpg cover.jpg`)).status).toBe(0);
  await placed(room, { 'cover.jpg': REDRAWN });

  const pushed = await ran(hosted, `@sh cd ${room.repository} && git commit -qam redrawn && house push`);
  const fetched = await house(hosted, '/', 'fetch');

  expect(pushed).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}\.\n$/) });
  const changes = [
    { op: 'rename', path: '/rooms/notes/photo.jpg', to: '/rooms/notes/cover.jpg', base: revision },
    part('cover.jpg', REDRAWN, 'image/jpeg', revision),
  ];
  expect(toolBatches(hosted).map((received) => called(received).arguments!.changes)).toEqual([changes, changes]);
  expect(room.binaries.has('photo.jpg')).toBe(false);
  expect(digest(room.binaries.get('cover.jpg')!.bytes)).toBe(digest(REDRAWN));
  expect(fetched.status).toBe(0);
  expect(gets(hosted)).toBe(0);
  clean(room);
});

it('renames a binary file moved with a plain mv and committed, and the document linking it links its new Path once the push lands', async () => {
  const { hosted, room } = await copied((setup) => setup.put('index.md', 'See ![a photo](photo.jpg).\n'));
  await placed(room, { 'photo.jpg': JPEG });
  commitAll(room.repository, 'a photo');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  const revision = room.binaries.get('photo.jpg')!.revision;
  const sent = puts(hosted).length;
  await rename(join(room.repository, 'photo.jpg'), join(room.repository, 'cover.jpg'));
  const commit = commitAll(room.repository, 'renamed');

  const pushed = await house(hosted, room.repository, 'push', '--owner');
  const fetched = await house(hosted, '/', 'fetch');

  expect(pushed).toEqual({ status: 0, stdout: expect.stringMatching(new RegExp(`^House accepted ${short(commit)}; main is at [0-9a-f]{12}\\.\\n$`)), stderr: '' });
  expect(batches(hosted).at(-1)!.changes).toEqual([{ op: 'rename', path: '/rooms/notes/photo.jpg', to: '/rooms/notes/cover.jpg', base: revision }]);
  expect(puts(hosted)).toHaveLength(sent);
  expect(room.binaries.get('cover.jpg')).toEqual({ revision, bytes: JPEG });
  expect(room.files.get('index.md')!.content).toBe('See ![a photo](cover.jpg).\n');
  expect(await readFile(join(room.repository, 'index.md'), 'utf8')).toBe('See ![a photo](cover.jpg).\n');
  expect(fetched.status).toBe(0);
  expect(gets(hosted)).toBe(0);
  clean(room);
});

it('finishes a push renaming a binary file whose operation expired once House holds the rename, sending nothing again', async () => {
  const { hosted, rooms, room } = await copied();
  await placed(room, { 'photo.jpg': JPEG });
  commitAll(room.repository, 'a photo');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  const revision = room.binaries.get('photo.jpg')!.revision;
  await rename(join(room.repository, 'photo.jpg'), join(room.repository, 'cover.jpg'));
  const commit = commitAll(room.repository, 'renamed');
  rooms.dropping = 1;
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(1);
  hosted.house.route('POST', '/kit/door/update', () => ({ status: 409, body: { error: { code: 'expired', retryable: false } } }));

  const recovered = await house(hosted, room.repository, 'push', '--owner');

  expect(recovered).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(room.batches.at(-1)).toEqual([{ op: 'rename', path: '/rooms/notes/photo.jpg', to: '/rooms/notes/cover.jpg', base: revision }]);
  expect(room.batches).toHaveLength(2);
  expect(room.binaries.get('cover.jpg')).toEqual({ revision, bytes: JPEG });
  expect(gets(hosted)).toBe(0);
  clean(room);
});

it.each<[string, (room: Room) => unknown, Record<string, Buffer>]>([
  ['redraws it', (room) => room.upload('cover.jpg', REDRAWN), { 'cover.jpg': REDRAWN }],
  ['puts text at its old Path', (room) => room.put('photo.jpg', 'a caption\n'), { 'cover.jpg': JPEG, 'photo.jpg': Buffer.from('a caption\n') }],
  ['removes it', (room) => room.remove('cover.jpg'), {}],
])('finishes a push renaming a binary file when another writer %s before the Kit reads House back, and the House ref holds what the Room does', async (_, writer, after) => {
  const { hosted, rooms, room } = await copied();
  await placed(room, { 'photo.jpg': JPEG });
  commitAll(room.repository, 'a photo');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  await rename(join(room.repository, 'photo.jpg'), join(room.repository, 'cover.jpg'));
  const commit = commitAll(room.repository, 'renamed');
  rooms.dropping = 1;
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(1);
  await ownAgent(hosted);
  writer(room);

  const finished = await house(hosted, room.repository, 'push', '--owner');

  expect(finished).toEqual({ status: 0, stdout: expect.stringMatching(new RegExp(`^House accepted ${short(commit)}(; main is at [0-9a-f]{12})?\\.\\n$`)), stderr: '' });
  expect((await record(hosted, room)).push).toBeUndefined();
  git(room.repository, 'merge', '-q', '--ff-only', 'refs/house/received');
  const held = async (path: string) => (existsSync(join(room.repository, path)) ? await readFile(join(room.repository, path)) : undefined);
  expect({ 'cover.jpg': await held('cover.jpg'), 'photo.jpg': await held('photo.jpg') }).toEqual(after);
  clean(room);
});

it.each<[string, Record<string, string>, Record<string, Buffer | string>, string[], Record<string, Buffer | string>, (revisions: Record<string, string>) => Record<string, unknown>[]]>([
  [
    'one removed path and two added ones',
    {},
    { 'photo.jpg': JPEG },
    ['photo.jpg'],
    { 'copy.jpg': JPEG, 'cover.jpg': JPEG },
    (revisions) => [
      part('copy.jpg', JPEG, 'image/jpeg'),
      part('cover.jpg', JPEG, 'image/jpeg'),
      { op: 'remove', path: '/rooms/notes/photo.jpg', base: revisions['photo.jpg'] },
    ],
  ],
  [
    'two removed paths and one added one',
    {},
    { 'a.jpg': JPEG, 'b.jpg': JPEG },
    ['a.jpg', 'b.jpg'],
    { 'c.jpg': JPEG },
    (revisions) => [
      { op: 'remove', path: '/rooms/notes/a.jpg', base: revisions['a.jpg'] },
      { op: 'remove', path: '/rooms/notes/b.jpg', base: revisions['b.jpg'] },
      part('c.jpg', JPEG, 'image/jpeg'),
    ],
  ],
  [
    'a removed path, an added one and a text House holds turned to an attachment',
    { 'cover.jpg': 'a caption\n' },
    { 'photo.jpg': JPEG },
    ['photo.jpg'],
    { 'copy.jpg': JPEG, 'cover.jpg': JPEG },
    (revisions) => [
      part('copy.jpg', JPEG, 'image/jpeg'),
      { op: 'remove', path: '/rooms/notes/cover.jpg', base: revisions['cover.jpg'] },
      part('cover.jpg', JPEG, 'image/jpeg'),
      { op: 'remove', path: '/rooms/notes/photo.jpg', base: revisions['photo.jpg'] },
    ],
  ],
])('removes and creates attachments, renaming none, when %s hold the same bytes', async (_, text, before, removed, after, sent) => {
  const { hosted, room } = await copied((setup) => {
    for (const [path, content] of Object.entries(text)) setup.put(path, content);
  });
  await placed(room, before);
  commitAll(room.repository, 'before');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  const revisions = Object.fromEntries([...Object.keys(text), ...Object.keys(before)].map((path) => [path, room.binaries.get(path)?.revision ?? room.revision(path)]));
  for (const path of removed) await rm(join(room.repository, path));
  await placed(room, after);
  const commit = commitAll(room.repository, 'after');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted).at(-1)!.changes).toEqual(sent(revisions));
  clean(room);
});

it('removes and creates attachments when two removed and two added paths hold the same bytes, and a moved text House holds, while the one removed and added pair of equal bytes is a rename', async () => {
  const { hosted, room } = await copied((setup) => setup.put('notes.txt', 'some notes\n'));
  await placed(room, { 'a.jpg': JPEG, 'b.jpg': JPEG, 'report.pdf': PDF });
  commitAll(room.repository, 'binary files');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  const revisions = Object.fromEntries(['a.jpg', 'b.jpg', 'report.pdf'].map((path) => [path, room.binaries.get(path)!.revision]));
  const notes = room.revision('notes.txt');
  const moves: [string, string][] = [
    ['a.jpg', 'c.jpg'],
    ['b.jpg', 'd.jpg'],
    ['report.pdf', 'scan.pdf'],
    ['notes.txt', 'notes-old.txt'],
  ];
  for (const [from, to] of moves) await rename(join(room.repository, from), join(room.repository, to));
  const commit = commitAll(room.repository, 'moved');

  const pushed = await house(hosted, room.repository, 'push', '--owner');
  const fetched = await house(hosted, '/', 'fetch');

  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted).at(-1)!.changes).toEqual([
    { op: 'remove', path: '/rooms/notes/a.jpg', base: revisions['a.jpg'] },
    { op: 'remove', path: '/rooms/notes/b.jpg', base: revisions['b.jpg'] },
    part('c.jpg', JPEG, 'image/jpeg'),
    part('d.jpg', JPEG, 'image/jpeg'),
    part('notes-old.txt', Buffer.from('some notes\n'), 'text/plain'),
    { op: 'remove', path: '/rooms/notes/notes.txt', base: notes },
    { op: 'rename', path: '/rooms/notes/report.pdf', to: '/rooms/notes/scan.pdf', base: revisions['report.pdf'] },
  ]);
  expect([...room.binaries.keys()].sort()).toEqual(['c.jpg', 'd.jpg', 'notes-old.txt', 'scan.pdf']);
  expect(room.binaries.get('scan.pdf')).toEqual({ revision: revisions['report.pdf'], bytes: PDF });
  expect(fetched.status).toBe(0);
  expect(gets(hosted)).toBe(0);
  clean(room);
});

it.each<[string, (rooms: Rooms, room: Room) => void, boolean]>([
  ['house fetch, on the branch that merges it', () => {}, true],
  ['a whole reread, on a branch that does not merge it', (rooms, room) => rooms.expired.add(room.ref), false],
])('keeps each text the Local copy holds that House turns into an attachment in place with the same bytes as that attachment at its revision, downloading nothing, and a change to it pushes as one; after %s', async (_, reading, merging) => {
  const text = { 'config.json': '{"one": 1}\n', 'notes.txt': 'plain words\n' };
  const { hosted, rooms, room } = await copied((setup) => {
    for (const [path, content] of Object.entries(text)) setup.put(path, content);
  });
  await ownAgent(hosted);
  const revisions = Object.fromEntries(Object.keys(text).map((path) => [path, room.revision(path)]));
  for (const path of Object.keys(text)) room.attach(path);
  reading(rooms, room);
  const asked = hosted.mcp.length;

  const fetched = await house(hosted, '/', 'fetch');
  if (merging) git(room.repository, 'merge', '-q', '--ff-only', 'refs/house/received');

  expect(fetched.status).toBe(0);
  expect(hosted.mcp.slice(asked)).toEqual([]);
  expect(hosted.store.requests.filter((request) => request.method === 'GET' && request.key.startsWith('binary/'))).toEqual([]);
  for (const [path, content] of Object.entries(text)) expect(await readFile(join(room.repository, path), 'utf8')).toBe(content);
  clean(room);
  const manifest = (await record(hosted, room)).manifests[git(room.repository, 'rev-parse', 'refs/house/received').trim()]!;
  expect(manifest.binary).toEqual(
    Object.fromEntries(Object.entries(text).map(([path, content]) => [path, { bytes: Buffer.byteLength(content), sha256: digest(Buffer.from(content)) }])),
  );
  expect(Object.fromEntries(Object.keys(text).map((path) => [path, manifest.files[path]]))).toEqual(revisions);
  await placed(room, { 'config.json': '{"one": 2}\n' });
  const commit = commitAll(room.repository, 'two');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted).at(-1)!.changes).toEqual([part('config.json', Buffer.from('{"one": 2}\n'), 'application/json', revisions['config.json'])]);
  expect(room.binaries.get('config.json')!.bytes.toString('utf8')).toBe('{"one": 2}\n');
  clean(room);
});

it('reads House first when a push would turn a text the copy holds into an attachment, so a change to a text House turned into one in place since the last read goes as an upload against its revision', async () => {
  const { hosted, room } = await copied((setup) => setup.put('config.json', '{"one": 1}\n'));
  const revision = room.revision('config.json');
  room.attach('config.json');
  await placed(room, { 'config.json': '{"one": 2}\n' });
  const commit = commitAll(room.repository, 'two');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted).map((batch) => batch.changes)).toEqual([
    [part('config.json', Buffer.from('{"one": 2}\n'), 'application/json', revision)],
    [part('config.json', Buffer.from('{"one": 2}\n'), 'application/json', revision)],
  ]);
  expect(room.binaries.get('config.json')!.bytes.toString('utf8')).toBe('{"one": 2}\n');
  expect(gets(hosted)).toBe(0);
  clean(room);
});

it.each([
  ['read', true],
  ['did not read', false],
])("ends a push of a change to a text another writer changed and House then turned into an attachment, which the copy %s, with House's stale-base conflict and the rebase line, and the resolution lands as an upload", async (_, reading) => {
  const { hosted, room } = await copied((setup) => setup.put('notes.txt', 'first\n'));
  await ownAgent(hosted);
  room.put('notes.txt', 'second\n');
  if (reading) expect((await house(hosted, '/', 'fetch')).status).toBe(0);
  room.attach('notes.txt');
  const held = room.binaries.get('notes.txt')!.revision;
  await placed(room, { 'notes.txt': 'mine\n' });
  commitAll(room.repository, 'mine');

  const refused = await house(hosted, room.repository, 'push', '--owner');

  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('code: base_revision_stale');
  expect(refused.stderr).toMatch(/refs\/house\/received holds House's current state; rebase onto it and push again\n$/);
  expect(room.batches).toHaveLength(0);
  expect(blobAt(room, 'refs/house/received', 'notes.txt')?.toString('utf8')).toBe('second\n');
  expect(tryGit(room.repository, 'merge', '-q', 'refs/house/received').status).not.toBe(0);
  git(room.repository, 'checkout', '--ours', 'notes.txt');
  git(room.repository, 'add', 'notes.txt');
  git(room.repository, 'commit', '-q', '--no-edit');

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}/) });
  expect(batches(hosted).at(-1)!.changes).toEqual([part('notes.txt', Buffer.from('mine\n'), 'text/plain', held)]);
  expect(room.binaries.get('notes.txt')!.bytes.toString('utf8')).toBe('mine\n');
  clean(room);
});

it('sends a git mv of a text House holds at a Path other than .md to another such Path as a rename, which House takes', async () => {
  const { hosted, room } = await copied((setup) => setup.put('notes.txt', 'some notes\n'));
  const revision = room.revision('notes.txt');
  await opened(hosted);

  const moved = await ran(hosted, `@sh cd ${room.repository} && git mv notes.txt notes.json && git commit -qm move && house push`);

  expect(moved).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}/) });
  expect(toolBatches(hosted).map((received) => called(received).arguments!.changes)).toEqual([
    [{ op: 'rename', path: '/rooms/notes/notes.txt', to: '/rooms/notes/notes.json', base: revision }],
  ]);
  expect([room.files.has('notes.txt'), room.files.get('notes.json')?.content]).toEqual([false, 'some notes\n']);
  clean(room);
});

it.each([
  ['a document to a Path other than .md', 'notes.md', 'notes.txt', 'document'],
  ['an attachment to a .md Path', 'photo.jpg', 'photo.md', 'attachment'],
])("sends a git mv of %s as the rename it is, and House's refusal of it ends the push with the Room unchanged", async (_, from, to, kind) => {
  const { hosted, room } = await copied((setup) => setup.put('notes.md', 'some notes\n'));
  await placed(room, { 'photo.jpg': JPEG });
  commitAll(room.repository, 'a photo');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(0);
  const base = room.binaries.get(from)?.revision ?? room.revision(from);
  const held = [new Map(room.files), new Map(room.binaries), room.batches.length];
  await opened(hosted);

  const moved = await ran(hosted, `@sh cd ${room.repository} && git mv ${from} ${to} && git commit -qm move && house push`);

  expect(moved).toMatchObject({
    status: 1,
    stderr: `house: kind_fixed: /rooms/notes/${to} would hold another kind than the ${kind} moved there, and an entry keeps its kind\n`,
  });
  expect(toolBatches(hosted).map((received) => called(received).arguments!.changes)).toEqual([
    [{ op: 'rename', path: `/rooms/notes/${from}`, to: `/rooms/notes/${to}`, base }],
  ]);
  expect([room.files, room.binaries, room.batches.length]).toEqual(held);
  expect((await record(hosted, room)).push).toBeUndefined();
});

it("ends a push an earlier Kit left pending with text for a Path other than .md in House's attachment_path refusal, and the next push sends that file as an attachment", async () => {
  const { hosted, rooms, room } = await copied();
  rooms.writeUnits = 0;
  await placed(room, { 'notes.txt': 'plain words\n' });
  const commit = commitAll(room.repository, 'notes');
  expect((await house(hosted, room.repository, 'push', '--owner')).status).toBe(1);
  const path = join(hosted.home, 'local-copies/rooms', `${room.ref}.json`);
  const earlier = JSON.parse(await readFile(path, 'utf8')) as { push: { changes: unknown[]; staged?: string[] } };
  earlier.push.changes = [{ op: 'create', path: '/rooms/notes/notes.txt', content: 'plain words\n' }];
  delete earlier.push.staged;
  await writeFile(path, JSON.stringify(earlier));
  await hosted.restart();
  rooms.writeUnits = Infinity;

  const refused = await house(hosted, room.repository, 'push', '--owner');
  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(refused).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: attachment_path: /rooms/notes/notes.txt holds an attachment, since its Path does not end .md; send its bytes with upload\n',
  });
  expect(pushed).toEqual({ status: 0, stdout: `House accepted ${short(commit)}.\n`, stderr: '' });
  expect(batches(hosted).at(-1)!.changes).toEqual([part('notes.txt', Buffer.from('plain words\n'), 'text/plain')]);
  expect([room.binaries.get('notes.txt')!.bytes.toString('utf8'), room.files.has('notes.txt')]).toEqual(['plain words\n', false]);
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

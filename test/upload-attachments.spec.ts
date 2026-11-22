import { CONVERSATION_META_KEY } from '@agentshouse/kit-wire';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { until, type Received } from './double.ts';
import { hostKit, opened, type Hosted, type McpCall } from './environment.ts';
import { digest, fileCalls, house, manifestOf, serveRooms, upload, type Room, type Rooms } from './rooms.ts';

const FAST_TIMEOUTS = fileURLToPath(new URL('./fast-timeouts.ts', import.meta.url));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const REDRAWN = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66]);
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
const RECORDING = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]);

const UNSENT = 'house upload again resumes this upload and sends only what it has not sent';
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

function part(path: string, bytes: Buffer, mediaType: string, base?: string): Record<string, unknown> {
  return { op: 'upload', path: `/rooms/notes/${path}`, ...(base === undefined ? {} : { base }), bytes: bytes.length, sha256: digest(bytes), media_type: mediaType };
}

function batches(hosted: Hosted): { operation_id: string; changes: Record<string, unknown>[] }[] {
  return hosted.house.requests
    .filter((request) => request.path === '/kit/door/update')
    .map((request) => request.body as { operation_id: string; changes: Record<string, unknown>[] });
}

function called(received: Received): McpCall['params'] {
  return (received.body as McpCall).params;
}

function operationOf(received: Received): string {
  return (received.body as { params: { _meta: Record<string, string> } }).params._meta['agents.house/agent-operation']!;
}

function puts(hosted: Hosted): [number | null, number][] {
  return hosted.store.requests.filter((request) => request.method === 'PUT').map((request) => [request.part, request.status]);
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

async function copied(setup: (room: Room) => void = () => {}, node?: string[]): Promise<{ hosted: Hosted; rooms: Rooms; room: Room }> {
  const hosted = await hostKit([{}], node === undefined ? {} : { node });
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('ROOM.md', 'The notes Room\n');
  room.put('plan.md', 'one\n');
  setup(room);
  await rooms.download([room]);
  return { hosted, rooms, room };
}

it('uploads documents and attachments once as the owner, each attachment staged in its parts, and the Room and the manifest hold every file', async () => {
  const { hosted, rooms, room } = await copied();
  rooms.authoredFileBytes = 64;
  const plan = room.revision('plan.md');
  const log = 'a'.repeat(65);
  const nul = 'valid UTF-8 \0 with a NUL\n';
  await placed(room, { 'scans/cover.jpg': JPEG, 'scans/report.pdf': PDF, 'notes.txt': nul, 'log.txt': log, 'plan.md': 'one\ntwo\n' });

  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 5 files of /rooms/notes.\n', stderr: '' });

  const sent = [
    part('log.txt', Buffer.from(log), 'text/plain'),
    part('notes.txt', Buffer.from(nul), 'text/plain'),
    { op: 'write', path: '/rooms/notes/plan.md', content: 'one\ntwo\n', base: plan },
    part('scans/cover.jpg', JPEG, 'image/jpeg'),
    part('scans/report.pdf', PDF, 'application/pdf'),
  ];
  expect(batches(hosted).map((batch) => batch.changes)).toEqual([sent, sent]);
  expect(new Set(batches(hosted).map((batch) => batch.operation_id)).size).toBe(1);
  expect(room.batches).toHaveLength(1);
  const held = { 'log.txt': Buffer.from(log), 'notes.txt': Buffer.from(nul), 'scans/cover.jpg': JPEG, 'scans/report.pdf': PDF };
  const { files } = await manifestOf(room);
  for (const [path, bytes] of Object.entries(held)) {
    expect(digest(room.binaries.get(path)!.bytes)).toBe(digest(bytes));
    expect(files[path]).toEqual({ revision: room.binaries.get(path)!.revision, sha256: digest(bytes), bytes: bytes.length });
  }
  expect(puts(hosted).filter(([, status]) => status === 200)).toHaveLength(9 + 4 + 2 + 2);
  expect(await house(hosted, '/', 'download')).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });
  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'Nothing to upload: /rooms/notes matches House.\n', stderr: '' });
  expect(fileCalls(hosted)).toEqual([]);
});

it("uploads a document and an attachment under the Kit credential naming the conversation, finishing each staged upload through upload by its path, and a download there brings the attachment's new bytes", async () => {
  const { hosted, room } = await copied();
  await opened(hosted);
  await placed(room, { 'photo.jpg': JPEG, 'plan.md': 'one\ntwo\n' });

  const uploaded = await ran(hosted, `@sh cd ${room.repository} && house upload`);
  room.upload('photo.jpg', REDRAWN);
  const downloaded = await ran(hosted, '@sh house download');

  expect(uploaded).toMatchObject({ status: 0, stdout: 'House accepted 2 files of /rooms/notes.\n' });
  expect(downloaded).toMatchObject({ status: 0, stdout: '/rooms/notes: 1 file updated from House\n' });
  const credential = 'Bearer ahk_held';
  const labelOf = (received: Received) => (received.body as McpCall).params._meta[CONVERSATION_META_KEY];
  const finishing = { upload: expect.any(String), path: '/rooms/notes/photo.jpg', part_sha256: [JPEG.subarray(0, 8), JPEG.subarray(8)].map(digest) };
  expect(fileCalls(hosted).map(labelOf)).toEqual(Array(5).fill('conversation-1'));
  expect(fileCalls(hosted).map((received) => [received.headers.authorization, called(received).name, called(received).arguments])).toEqual([
    [credential, 'update', { changes: expect.any(Array) }],
    [credential, 'upload', finishing],
    [credential, 'upload', finishing],
    [credential, 'update', { changes: expect.any(Array) }],
    [credential, 'info', { path: '/rooms/notes/photo.jpg', ref: room.binaries.get('photo.jpg')!.revision }],
  ]);
  expect(new Set(hosted.mcp.filter((received) => called(received).name === 'update').map(operationOf)).size).toBe(1);
  expect(
    hosted.mcp
      .filter((received) => called(received).name === 'info' && called(received).arguments?.path === room.root)
      .map((received) => [received.headers.authorization, (received.body as McpCall).params._meta[CONVERSATION_META_KEY]]),
  ).toEqual([
    [credential, undefined],
    [credential, 'conversation-1'],
  ]);
  expect(await readFile(join(room.repository, 'photo.jpg'))).toEqual(REDRAWN);
});

it('sends a changed attachment against its revision whatever its new bytes and deletes a removed one, in one upload', async () => {
  const { hosted, room } = await copied();
  await placed(room, { 'cover.jpg': JPEG, 'report.pdf': PDF, 'data.bin': RECORDING });
  expect((await upload(hosted, room)).status).toBe(0);
  const revisions = Object.fromEntries(['cover.jpg', 'report.pdf', 'data.bin'].map((path) => [path, room.binaries.get(path)!.revision]));
  await placed(room, { 'cover.jpg': REDRAWN, 'data.bin': 'now text\n' });
  await rm(join(room.repository, 'report.pdf'));

  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 3 files of /rooms/notes.\n', stderr: '' });

  expect(batches(hosted).at(-1)!.changes).toEqual([
    part('cover.jpg', REDRAWN, 'image/jpeg', revisions['cover.jpg']),
    part('data.bin', Buffer.from('now text\n'), 'application/octet-stream', revisions['data.bin']),
    { op: 'delete', path: '/rooms/notes/report.pdf', base: revisions['report.pdf'] },
  ]);
  expect(digest(room.binaries.get('cover.jpg')!.bytes)).toBe(digest(REDRAWN));
  expect(room.binaries.has('report.pdf')).toBe(false);
});

it('uploads each .md file as document text and every other file as an attachment whatever its bytes, asking Discovery only when a .md file arrives, and refuses a .md file past the cap or holding no text before any House mutation', async () => {
  const { hosted, rooms, room } = await copied();
  const discovered = () => hosted.house.requests.filter((request) => request.path === '/kit/door/rooms/discover').length;
  const text = { 'data.json': '{"one": 1}\n', 'notes.txt': 'plain words\n', 'src/main.ts': 'export const one = 1;\n' };
  await placed(room, text);
  const before = discovered();
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 3 files of /rooms/notes.\n' });
  expect(discovered()).toBe(before);
  for (const [path, content] of Object.entries(text)) expect(room.binaries.get(path)!.bytes.toString('utf8')).toBe(content);

  rooms.authoredFileBytes = 64;
  await placed(room, { 'log.md': 'ü'.repeat(32), 'README.MD': '# Read me\n' });
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 2 files of /rooms/notes.\n' });
  expect(discovered()).toBe(before + 1);
  expect([room.files.get('log.md')!.content, room.files.get('README.MD')!.content]).toEqual(['ü'.repeat(32), '# Read me\n']);

  const sent = batches(hosted).length;
  await placed(room, { 'log.md': `${'ü'.repeat(32)}!`, 'notes.md': 'valid UTF-8 \0 with a NUL\n', 'photo.jpg': JPEG });
  expect(await upload(hosted, room)).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: log.md, notes.md are Markdown, which holds text only: UTF-8 without NUL, at most 64 bytes; save them as text and run house upload again\n',
  });
  expect(batches(hosted)).toHaveLength(sent);
  expect(room.binaries.has('photo.jpg')).toBe(false);
});

it('stops an upload the Write limit refuses, naming each attachment it has not sent with its reason, and house upload again from a conversation sends only those and lands once', async () => {
  const { hosted, rooms, room } = await copied();
  await opened(hosted);
  rooms.writeUnits = 2;
  await placed(room, { 'a.jpg': JPEG, 'b.pdf': PDF, 'c.bin': RECORDING, 'plan.md': 'one\ntwo\n' });

  const stopped = await upload(hosted, room);
  const stoppedPuts = puts(hosted).length;
  const unchanged = [room.batches.length, room.files.get('plan.md')!.content, room.binaries.size];
  rooms.writeUnits = 2;
  const resumed = await ran(hosted, `@sh cd ${room.repository} && house upload`);

  expect(stopped).toEqual({
    status: 1,
    stdout: '',
    stderr: [
      'house: House holds nothing of this upload yet, so /rooms/notes is unchanged; these attachments are not sent:',
      "c.bin: limit_reached: you reached today's Write limit; try again at 2026-11-17T00:00:00.000Z",
      UNSENT,
      '',
    ].join('\n'),
  });
  expect(unchanged).toEqual([0, 'one\n', 0]);
  expect(resumed).toMatchObject({ status: 0, stdout: 'House accepted 4 files of /rooms/notes.\n' });
  const operations = [...batches(hosted).map((batch) => batch.operation_id), ...rooms.edits().map(operationOf)];
  expect(new Set(operations).size).toBe(1);
  expect(puts(hosted).slice(stoppedPuts)).toEqual([[1, 200]]);
  expect(room.batches).toHaveLength(1);
  for (const [path, bytes] of [['a.jpg', JPEG], ['b.pdf', PDF], ['c.bin', RECORDING]] as const) expect(digest(room.binaries.get(path)!.bytes)).toBe(digest(bytes));
});

it("stops a conversation's upload the open-uploads cap refuses without sending it again, and the next upload lands it under the same operation", async () => {
  const { hosted, rooms, room } = await copied();
  await opened(hosted);
  rooms.openUploads = 0;
  await placed(room, { 'photo.jpg': JPEG });

  const stopped = await ran(hosted, `@sh cd ${room.repository} && house upload`);
  const sent = rooms.edits().length;
  rooms.openUploads = 10;
  const landed = await ran(hosted, `@sh cd ${room.repository} && house upload`);

  expect(stopped).toMatchObject({
    status: 1,
    stderr: [
      'house: House holds nothing of this upload yet, so /rooms/notes is unchanged; these attachments are not sent:',
      'photo.jpg: cap_reached: you hold the most uploads open at once; try again at 2026-11-17T00:00:00.000Z',
      UNSENT,
      '',
    ].join('\n'),
  });
  expect(sent).toBe(1);
  expect(landed).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(new Set(rooms.edits().map(operationOf)).size).toBe(1);
  expect(digest(room.binaries.get('photo.jpg')!.bytes)).toBe(digest(JPEG));
});

it("ends an upload House refuses past the owner's storage as final, keeping no pending batch, so the next upload is a new one", async () => {
  const { hosted, rooms, room } = await copied();
  rooms.refusesBatches = [STORAGE];
  await placed(room, { 'photo.jpg': JPEG });

  const refused = await upload(hosted, room);
  const pending = JSON.parse(await readFile(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`), 'utf8')).pending;
  const uploaded = await upload(hosted, room);

  expect(refused).toEqual({ status: 1, stdout: '', stderr: `house: ${STORED}\n` });
  expect(pending).toBeUndefined();
  expect(uploaded).toEqual({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n', stderr: '' });
  const [first, ...rest] = batches(hosted).map((batch) => batch.operation_id);
  expect(rest).toHaveLength(2);
  expect(new Set(rest).size).toBe(1);
  expect(rest).not.toContain(first);
});

it('lands more attachments than House opens at once in turns under one operation, sending at most ten to the store at once', async () => {
  const { hosted, rooms, room } = await copied();
  rooms.openUploads = 1;
  await placed(room, { 'a.jpg': JPEG, 'b.pdf': PDF, 'c.bin': RECORDING });
  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 3 files of /rooms/notes.\n', stderr: '' });
  expect(batches(hosted)).toHaveLength(4);
  expect(new Set(batches(hosted).map((batch) => batch.operation_id)).size).toBe(1);

  rooms.openUploads = 20;
  await placed(room, Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`scans/${index}.bin`, Buffer.from([0xff, index])])));
  const release = hosted.store.holdWrites();
  const uploading = upload(hosted, room);
  await until(() => hosted.store.writing === 10);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const writing = hosted.store.writing;
  release();

  expect(writing).toBe(10);
  expect(await uploading).toMatchObject({ status: 0, stdout: 'House accepted 12 files of /rooms/notes.\n' });
  expect(room.binaries.size).toBe(15);
});

it('keeps an upload a failed transfer stops and resumes it after the Kit restarts under its operation, sending only the part the store lacks', async () => {
  const { hosted, room } = await copied(undefined, ['--import', FAST_TIMEOUTS]);
  hosted.store.failing.add(2);
  await placed(room, { 'photo.jpg': JPEG });

  const stopped = await upload(hosted, room);
  hosted.store.failing.clear();
  await hosted.restart();
  const resumed = await upload(hosted, room);

  expect(stopped).toEqual({
    status: 1,
    stdout: '',
    stderr: [
      'house: House holds nothing of this upload yet, so /rooms/notes is unchanged; these attachments are not sent:',
      'photo.jpg: its transfer failed: the store answered 500',
      UNSENT,
      '',
    ].join('\n'),
  });
  expect(resumed).toEqual({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n', stderr: '' });
  expect(new Set(batches(hosted).map((batch) => batch.operation_id)).size).toBe(1);
  const sent = puts(hosted);
  expect(sent.filter(([index]) => index === 1)).toEqual([[1, 200]]);
  expect(sent.at(-1)).toEqual([2, 200]);
  expect(digest(room.binaries.get('photo.jpg')!.bytes)).toBe(digest(JPEG));
  expect(room.batches).toHaveLength(1);
});

it('drops an upload whose attachment changed after it read it, before House holds any of it, and the next upload sends the file as it is now', async () => {
  const { hosted, rooms, room } = await copied();
  await placed(room, { 'photo.jpg': JPEG });
  let changed = false;
  rooms.beforeEdit = () => {
    if (changed) return;
    changed = true;
    writeFileSync(join(room.repository, 'photo.jpg'), REDRAWN);
  };

  const stopped = await upload(hosted, room);
  const uploaded = await upload(hosted, room);

  expect(stopped).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: House holds nothing of this upload yet, so /rooms/notes is unchanged: photo.jpg changed since house upload read it; run house upload again to send the copy as it is now\n',
  });
  expect(uploaded).toEqual({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n', stderr: '' });
  expect(batches(hosted).at(-1)!.changes).toEqual([part('photo.jpg', REDRAWN, 'image/jpeg')]);
  expect(digest(room.binaries.get('photo.jpg')!.bytes)).toBe(digest(REDRAWN));
});

it('uploads one removed and one added attachment of equal bytes as a move, and removes and adds attachments when more than one path holds those bytes', async () => {
  const { hosted, room } = await copied();
  await placed(room, { 'a.jpg': JPEG, 'b.jpg': JPEG, 'report.pdf': PDF });
  expect((await upload(hosted, room)).status).toBe(0);
  const revisions = Object.fromEntries(['a.jpg', 'b.jpg', 'report.pdf'].map((path) => [path, room.binaries.get(path)!.revision]));
  await rm(join(room.repository, 'a.jpg'));
  await rm(join(room.repository, 'b.jpg'));
  await placed(room, { 'c.jpg': JPEG, 'd.jpg': JPEG });
  await mkdir(join(room.repository, 'archive'));
  await rename(join(room.repository, 'report.pdf'), join(room.repository, 'archive/report.pdf'));

  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 5 files of /rooms/notes.\n', stderr: '' });

  expect(batches(hosted).at(-1)!.changes).toEqual([
    { op: 'delete', path: '/rooms/notes/a.jpg', base: revisions['a.jpg'] },
    { op: 'delete', path: '/rooms/notes/b.jpg', base: revisions['b.jpg'] },
    part('c.jpg', JPEG, 'image/jpeg'),
    part('d.jpg', JPEG, 'image/jpeg'),
    { op: 'move', path: '/rooms/notes/report.pdf', to: '/rooms/notes/archive/report.pdf', base: revisions['report.pdf'] },
  ]);
  expect(room.binaries.get('archive/report.pdf')!.revision).toBe(revisions['report.pdf']);
  expect(await upload(hosted, room)).toMatchObject({ stdout: 'Nothing to upload: /rooms/notes matches House.\n' });
});

it("takes House's current revision as the base of an attachment another writer replaced or stored first, says how to keep House's instead, and the next upload sends it with every other change", async () => {
  const { hosted, room } = await copied();
  await placed(room, { 'photo.jpg': JPEG });
  expect((await upload(hosted, room)).status).toBe(0);
  const theirs = room.upload('photo.jpg', RECORDING);
  const taken = room.upload('cover.jpg', PDF);
  await placed(room, { 'photo.jpg': REDRAWN, 'cover.jpg': JPEG });
  const advice = (path: string, revision: string) =>
    `/rooms/notes/${path}: House holds ${revision}, a version this copy never held; the next house upload replaces it with this file, and house download '${JSON.stringify({ path: `/rooms/notes/${path}`, file: join(room.repository, path) })}' brings House's instead`;

  const refused = await upload(hosted, room);

  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('code: base_revision_stale');
  expect(refused.stderr.endsWith(`${advice('cover.jpg', taken)}\n${advice('photo.jpg', theirs)}\n`)).toBe(true);
  const { files } = await manifestOf(room);
  expect(files['photo.jpg']).toEqual({ revision: theirs, sha256: digest(RECORDING), bytes: RECORDING.length });
  expect(files['cover.jpg']).toEqual({ revision: taken, sha256: digest(PDF), bytes: PDF.length });
  expect(digest(room.binaries.get('photo.jpg')!.bytes)).toBe(digest(RECORDING));
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\n');

  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 3 files of /rooms/notes.\n', stderr: '' });

  expect(batches(hosted).at(-1)!.changes).toEqual([
    part('cover.jpg', JPEG, 'image/jpeg', taken),
    part('photo.jpg', REDRAWN, 'image/jpeg', theirs),
    expect.objectContaining({ op: 'write', path: '/rooms/notes/plan.md', content: 'one\ntwo\n' }),
  ]);
  expect(digest(room.binaries.get('photo.jpg')!.bytes)).toBe(digest(REDRAWN));
  expect(digest(room.binaries.get('cover.jpg')!.bytes)).toBe(digest(JPEG));
  expect(await upload(hosted, room)).toMatchObject({ stdout: 'Nothing to upload: /rooms/notes matches House.\n' });
});

it("needs nothing more uploaded once the advised house download brings House's attachment over the one this copy changed", async () => {
  const { hosted, room } = await copied();
  await placed(room, { 'photo.jpg': JPEG });
  expect((await upload(hosted, room)).status).toBe(0);
  room.upload('photo.jpg', RECORDING);
  await placed(room, { 'photo.jpg': REDRAWN });
  expect((await upload(hosted, room)).status).toBe(1);

  expect((await house(hosted, room.repository, 'download', JSON.stringify({ path: '/rooms/notes/photo.jpg', file: join(room.repository, 'photo.jpg') }))).status).toBe(0);

  expect(await readFile(join(room.repository, 'photo.jpg'))).toEqual(RECORDING);
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'Nothing to upload: /rooms/notes matches House.\n' });
});

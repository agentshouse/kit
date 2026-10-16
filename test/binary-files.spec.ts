import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { until, type Received } from './double.ts';
import { conversationCredential, hostKit, lastInput, opened, uploadDouble, type Hosted, type McpCall } from './environment.ts';
import { commitAll, git, house, serveRooms, type Room, type Rooms } from './rooms.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const REDRAWN = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66]);

interface Shelled {
  status: number;
  stdout: string;
  stderr: string;
}

async function ran(hosted: Hosted, line: string): Promise<Shelled> {
  const before = (await hosted.adapterLog()).filter((entry) => 'house' in entry || 'sh' in entry).length;
  hosted.input({ kind: 'message', text: line, files: [], first: false });
  return until(
    async () => (await hosted.adapterLog()).filter((entry) => 'house' in entry || 'sh' in entry)[before] as unknown as Shelled | undefined,
  );
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function called(received: Received): McpCall['params'] {
  return (received.body as McpCall).params;
}

async function copied(): Promise<{ hosted: Hosted; rooms: Rooms; room: Room }> {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('ROOM.md', 'The notes Room\n');
  room.put('plan.md', 'one\n');
  room.upload('photo.jpg', JPEG);
  await rooms.fetch([room]);
  return { hosted, rooms, room };
}

function copyState(hosted: Hosted, room: Room): Promise<string[]> {
  return Promise.all([
    readFile(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`), 'utf8'),
    Promise.resolve(git(room.repository, 'for-each-ref', '--format=%(refname) %(objectname)')),
    Promise.resolve(git(room.repository, 'status', '--porcelain', '--ignored')),
  ]);
}

function batches(hosted: Hosted): unknown[] {
  return hosted.house.requests.filter((request) => request.path === '/kit/door/batch').map((request) => request.body);
}

it("uploads a local file in one call naming the Room and destination, and answers House's refusal with the current revision for an occupied Path it names no base for", async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.workingDirectory, 'photo.jpg'), JPEG);
  const transfers = uploadDouble(hosted);
  const placed = hosted.tools.upload!;
  const refusal = [
    'edit_conflict: nothing was written; fix each conflict listed, then send the edit again',
    stringify({ conflicts: [{ path: '/rooms/notes/cover.jpg', code: 'base_required', state: 'current', revision: 'fr_9' }] }).trimEnd(),
  ].join('\n');
  hosted.tools.upload = (args, request) =>
    args.path === 'cover.jpg' && args.base === undefined
      ? { isError: true, content: [{ type: 'text', text: `${refusal}\n` }] }
      : placed(args, request);
  await opened(hosted);

  const first = await ran(hosted, '@house upload {"file":"photo.jpg","room_ref":"r_notes","path":"photo.jpg"}');
  const occupied = await ran(hosted, '@house upload {"file":"photo.jpg","room_ref":"r_notes","path":"cover.jpg"}');
  const based = await ran(hosted, '@house upload {"file":"photo.jpg","room_ref":"r_notes","path":"cover.jpg","base":"fr_9"}');

  expect(first).toMatchObject({ status: 0, stdout: 'path: photo.jpg\nrevision: fr_1\n', stderr: '' });
  expect(occupied).toMatchObject({ status: 1, stdout: '', stderr: `house: ${refusal}\n` });
  expect(based).toMatchObject({ status: 0, stdout: 'path: cover.jpg\nrevision: fr_2\n' });
  expect(hosted.mcp.map((received) => [received.headers.authorization, called(received).name, called(received).arguments])).toEqual([
    [`Bearer ${conversationCredential('conversation-1')}`, 'upload', { room_ref: 'r_notes', path: 'photo.jpg', bytes: JPEG.length, sha256: digest(JPEG), media_type: 'image/jpeg' }],
    [`Bearer ${conversationCredential('conversation-1')}`, 'upload', { room_ref: 'r_notes', path: 'cover.jpg', bytes: JPEG.length, sha256: digest(JPEG), media_type: 'image/jpeg' }],
    [`Bearer ${conversationCredential('conversation-1')}`, 'upload', { room_ref: 'r_notes', path: 'cover.jpg', base: 'fr_9', bytes: JPEG.length, sha256: digest(JPEG), media_type: 'image/jpeg' }],
  ]);
  expect(transfers.map((transfer) => transfer.bytes)).toEqual([JPEG, JPEG]);
});

it('downloads the head or a named revision of a binary Path to the file the caller names, checking its SHA-256, and changes no Local copy', async () => {
  const { hosted, rooms, room } = await copied();
  const first = room.binaries.get('photo.jpg')!.revision;
  room.upload('photo.jpg', REDRAWN);
  await opened(hosted);
  const before = await copyState(hosted, room);
  const head = join(hosted.workingDirectory, 'out', 'photo.jpg');
  const earlier = join(hosted.workingDirectory, 'photo-first.jpg');

  const current = await ran(hosted, '@house download {"path":"/rooms/notes/photo.jpg","file":"out/photo.jpg"}');
  const revision = await ran(hosted, `@house download {"path":"/rooms/notes/photo.jpg","ref":"${first}","file":"${earlier}"}`);

  expect(current).toMatchObject({ status: 0, stdout: `${head}\n`, stderr: '' });
  expect(revision).toMatchObject({ status: 0, stdout: `${earlier}\n`, stderr: '' });
  expect(await readFile(head)).toEqual(REDRAWN);
  expect(await readFile(earlier)).toEqual(JPEG);
  expect(hosted.mcp.map((received) => [received.headers.authorization, called(received).name, called(received).arguments])).toEqual([
    [`Bearer ${conversationCredential('conversation-1')}`, 'inspect', { path: '/rooms/notes/photo.jpg' }],
    [`Bearer ${conversationCredential('conversation-1')}`, 'inspect', { path: '/rooms/notes/photo.jpg', ref: first }],
  ]);
  expect(rooms.byteReads.map((read) => read.headers.authorization)).toEqual([undefined, undefined]);
  expect(await copyState(hosted, room)).toEqual(before);
});

it("refuses a download whose bytes do not match House's SHA-256 and one of a text file, and writes nothing", async () => {
  const { hosted, rooms } = await copied();
  await writeFile(join(hosted.home, 'own-agent.json'), JSON.stringify({ house: hosted.house.origin, user: 'user-one', credential: 'ahp_own' }));
  rooms.damages = true;
  const target = join(hosted.workingDirectory, 'photo.jpg');

  const damaged = await house(hosted, hosted.workingDirectory, 'download', JSON.stringify({ path: '/rooms/notes/photo.jpg', file: target }));
  const text = await house(hosted, hosted.workingDirectory, 'download', JSON.stringify({ path: '/rooms/notes/plan.md', file: target }));

  expect(damaged).toEqual({ status: 1, stdout: '', stderr: 'house: /rooms/notes/photo.jpg did not arrive whole; download it again\n' });
  expect(text).toEqual({ status: 1, stdout: '', stderr: 'house: /rooms/notes/plan.md holds no binary file; shell reads its text\n' });
  expect(existsSync(target)).toBe(false);
  expect(hosted.mcp.map((received) => received.headers.authorization)).toEqual(['Bearer ahp_own', 'Bearer ahp_own']);
});

it('copies and fetches a Room holding binary files with no binary entry or byte and no byte read, and so does a second Local copy', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('plan.md', 'one\n');
  room.upload('photo.jpg', JPEG);
  const own = rooms.room('private');
  own.put('diary.md', 'Private\n');
  own.upload('scans/receipt.pdf', REDRAWN);

  await rooms.fetch([room, own]);
  room.upload('photo.jpg', REDRAWN);
  room.upload('images/cover.jpg', JPEG);
  room.put('plan.md', 'one\ntwo\n');
  own.upload('scans/second.pdf', JPEG);
  const fetched = await house(hosted, '/', 'fetch');

  expect(fetched.status).toBe(0);
  expect(git(room.repository, 'show', 'refs/house/received:plan.md')).toBe('one\ntwo\n');
  for (const [copy, documents] of [
    [room, 'plan.md'],
    [own, 'diary.md'],
  ] as const) {
    expect(git(copy.repository, 'ls-tree', '-r', '--name-only', 'refs/house/received')).not.toMatch(/\.(jpg|pdf)$/m);
    expect(git(copy.repository, 'ls-files')).toContain(documents);
    const local = (await readdir(copy.repository, { recursive: true })).filter((path) => !path.startsWith('.git'));
    expect(local.filter((path) => /\.(jpg|pdf)$/.test(path))).toEqual([]);
    const manifest = await readFile(join(hosted.home, 'local-copies/rooms', `${copy.ref}.json`), 'utf8');
    expect(manifest).not.toMatch(/\.(jpg|pdf)/);
  }
  expect(rooms.byteReads).toEqual([]);
  expect(hosted.mcp).toEqual([]);
});

it("refuses a push of a commit holding a JPEG, a NUL or text above House's authored-file cap before any House submission, naming each non-text Path and house upload, and sends none of its text", async () => {
  const { hosted, rooms, room } = await copied();
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\n');
  await mkdir(join(room.repository, 'images'));
  await writeFile(join(room.repository, 'images', 'cover.jpg'), JPEG);
  await writeFile(join(room.repository, 'notes.txt'), 'valid UTF-8 \0 with a NUL\n');
  await writeFile(join(room.repository, 'log.txt'), 'a'.repeat(rooms.authoredFileBytes + 1));
  commitAll(room.repository, 'text and a picture');

  const owner = await house(hosted, room.repository, 'push', '--owner');
  await opened(hosted);
  const conversation = await ran(hosted, `@sh cd ${room.repository} && house push`);

  const refusal = 'images/cover.jpg, log.txt, notes.txt are not text, and house push sends text only; remove them from the commit and place them with house upload';
  expect(owner).toEqual({ status: 1, stdout: '', stderr: `house: ${refusal}\n` });
  expect(conversation).toMatchObject({ status: 1, stderr: `house: ${refusal}\n` });
  expect(batches(hosted)).toEqual([]);
  expect(hosted.mcp).toEqual([]);
  expect(room.files.get('plan.md')!.content).toBe('one\n');
});

it("pushes a text of exactly the authored-file cap House's discovery answers, and refuses one byte more before any submission, naming its Path and house upload", async () => {
  const { hosted, rooms, room } = await copied();
  rooms.authoredFileBytes = 64;
  await writeFile(join(room.repository, 'log.txt'), 'ü'.repeat(32));
  commitAll(room.repository, 'at the cap');

  const at = await house(hosted, room.repository, 'push', '--owner');
  await writeFile(join(room.repository, 'log.txt'), `${'ü'.repeat(32)}!`);
  commitAll(room.repository, 'one byte above the cap');
  const above = await house(hosted, room.repository, 'push', '--owner');

  expect(at).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}/) });
  expect(above).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: log.txt is not text, and house push sends text only; remove it from the commit and place it with house upload\n',
  });
  expect(batches(hosted).map((batch) => (batch as { changes: unknown }).changes)).toEqual([
    [{ op: 'create', path: '/rooms/notes/log.txt', content: 'ü'.repeat(32) }],
  ]);
  expect(room.files.get('log.txt')!.content).toBe('ü'.repeat(32));
});

it("refuses a push in House's words when its discovery does not answer the cap, and sends nothing", async () => {
  const { hosted, room } = await copied();
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\n');
  commitAll(room.repository, 'text');
  hosted.house.route('POST', '/kit/door/discover', () => ({
    status: 503,
    body: { error: { code: 'house_unavailable', message: 'house_unavailable: House is unavailable; push again shortly', retryable: true } },
  }));

  const pushed = await house(hosted, room.repository, 'push', '--owner');

  expect(pushed).toEqual({ status: 1, stdout: '', stderr: 'house: house_unavailable: House is unavailable; push again shortly\n' });
  expect(batches(hosted)).toEqual([]);
  expect(room.files.get('plan.md')!.content).toBe('one\n');
});

it("still pushes a text-only commit, and passes House's kind refusal of text at a binary Path through without another attempt", async () => {
  const { hosted, room } = await copied();
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\n');
  commitAll(room.repository, 'text');

  const text = await house(hosted, room.repository, 'push', '--owner');
  await writeFile(join(room.repository, 'photo.jpg'), 'a caption where House holds a picture\n');
  commitAll(room.repository, 'text over the picture');
  const kind = await house(hosted, room.repository, 'push', '--owner');

  expect(text).toMatchObject({ status: 0, stdout: expect.stringMatching(/^House accepted [0-9a-f]{12}/) });
  expect(kind.status).toBe(1);
  expect(kind.stderr).toContain('binary_file');
  expect(kind.stderr).toContain(`revision: ${room.binaries.get('photo.jpg')!.revision}`);
  expect(batches(hosted).map((batch) => (batch as { changes: unknown }).changes)).toEqual([
    [{ op: 'replace_preamble', path: '/rooms/notes/plan.md', base: 'one\n', content: 'one\ntwo\n' }],
    [{ op: 'create', path: '/rooms/notes/photo.jpg', content: 'a caption where House holds a picture\n' }],
  ]);
  expect(room.binaries.get('photo.jpg')!.bytes).toEqual(JPEG);
  expect(room.files.has('photo.jpg')).toBe(false);
});

it("downloads an incoming message's direct file into the conversation's fixed folder through that message, and adds nothing to the Private Room or its Local copy", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const own = rooms.room('private');
  own.put('diary.md', 'Private\n');
  await rooms.fetch([own]);
  const before = await copyState(hosted, own);
  hosted.house.route('POST', '/kit/conversation/originals/get', () => ({
    body: { message: 'message-1', download: { method: 'GET', url: `${hosted.house.origin}/message-files/file-1`, expires_at: '2026-10-13T12:00:00Z' } },
  }));
  hosted.house.route('GET', '/message-files/:file', () => ({ bytes: { type: 'application/octet-stream', content: JPEG } }));
  await opened(hosted);

  hosted.input({
    kind: 'message',
    text: 'look',
    files: [{ version: 'file-1', name: 'photo.jpg', media_type: 'image/jpeg', bytes: JPEG.length, sha256: digest(JPEG) }],
    first: false,
  });

  expect(await hosted.ack(lastInput())).toEqual({});
  expect(await readFile(join(hosted.workingDirectory, '.house', 'files', 'message-1', 'file-1', 'photo.jpg'))).toEqual(JPEG);
  expect(
    hosted.house.requests.filter((request) => request.path === '/kit/conversation/originals/get').map((request) => request.body),
  ).toEqual([{ version: 'file-1', download: true }]);
  expect(hosted.mcp).toEqual([]);
  expect(batches(hosted)).toEqual([]);
  expect(own.files.size).toBe(1);
  expect(await copyState(hosted, own)).toEqual(before);
});

it("attaches local files to a record: describes each to House, sends the bytes of every file House asks for, and appends again", async () => {
  const hosted = await hostKit();
  const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
  await writeFile(join(hosted.workingDirectory, 'photo.jpg'), JPEG);
  await mkdir(join(hosted.workingDirectory, 'mail'));
  await writeFile(join(hosted.workingDirectory, 'mail', 'invoice.pdf'), PDF);
  const transfers: Received[] = [];
  const staged = new Set<string>([digest(JPEG)]);
  hosted.tools.append_record = (args) => {
    const missing = (args.attachments as Array<{ sha256: string }>).filter((file) => !staged.has(file.sha256));
    return {
      content: [
        {
          type: 'text',
          text: stringify(
            missing.length === 0
              ? { record: 'rec_1' }
              : {
                  upload: missing.map((file, index) => ({
                    sha256: file.sha256,
                    method: 'POST',
                    operation: `operation-${index + 1}`,
                    url: `${hosted.house.origin}/bytes/stage-${index + 1}`,
                    expires_at: '2026-10-13T12:00:00Z',
                  })),
                },
          ).trimEnd(),
        },
      ],
    };
  };
  hosted.house.route('POST', '/bytes/:grant', (received) => {
    transfers.push(received);
    staged.add(digest(received.body as Buffer));
    return { body: { file: 'bf_1' } };
  });
  await opened(hosted);

  const appended = await ran(
    hosted,
    '@house append_record {"room_ref":"r_notes","source_ref":"s_mail","body":"scan","attachments":["photo.jpg","mail/invoice.pdf"]}',
  );

  const described = {
    room_ref: 'r_notes',
    source_ref: 's_mail',
    body: 'scan',
    attachments: [
      { name: 'photo.jpg', bytes: JPEG.length, sha256: digest(JPEG), media_type: 'image/jpeg' },
      { name: 'invoice.pdf', bytes: PDF.length, sha256: digest(PDF), media_type: 'application/pdf' },
    ],
  };
  expect(appended).toMatchObject({ status: 0, stdout: 'record: rec_1\n', stderr: '' });
  expect(hosted.mcp.map((received) => [called(received).name, called(received).arguments])).toEqual([
    ['append_record', described],
    ['append_record', described],
  ]);
  expect(transfers.map((transfer) => [transfer.headers['x-house-byte-operation'], transfer.body])).toEqual([['operation-1', PDF]]);
});

it('sends the bytes again when House asks for them again, and answers only the appended record', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.workingDirectory, 'photo.jpg'), JPEG);
  const transfers: Received[] = [];
  const staged = new Set<string>();
  hosted.tools.append_record = () => ({
    content: [
      {
        type: 'text',
        text: stringify(
          staged.has(digest(JPEG))
            ? { record: 'rec_1' }
            : {
                upload: [
                  {
                    sha256: digest(JPEG),
                    method: 'POST',
                    operation: `operation-${transfers.length + 1}`,
                    url: `${hosted.house.origin}/bytes/stage-${transfers.length + 1}`,
                    expires_at: '2026-10-13T12:00:00Z',
                  },
                ],
              },
        ).trimEnd(),
      },
    ],
  });
  hosted.house.route('POST', '/bytes/:grant', (received) => {
    transfers.push(received);
    if (transfers.length > 1) staged.add(digest(received.body as Buffer));
    return { body: { file: 'bf_1' } };
  });
  await opened(hosted);

  const appended = await ran(hosted, '@house append_record {"room_ref":"r_notes","source_ref":"s_mail","attachments":["photo.jpg"]}');

  expect(appended).toMatchObject({ status: 0, stdout: 'record: rec_1\n', stderr: '' });
  expect(hosted.mcp.map((received) => called(received).name)).toEqual(['append_record', 'append_record', 'append_record']);
  expect(transfers.map((transfer) => [transfer.headers['x-house-byte-operation'], transfer.body])).toEqual([
    ['operation-1', JPEG],
    ['operation-2', JPEG],
  ]);
});

it('refuses a record attachment that is no readable local file before calling House', async () => {
  const hosted = await hostKit();
  await opened(hosted);

  const appended = await ran(hosted, '@house append_record {"room_ref":"r_notes","source_ref":"s_mail","attachments":["missing.pdf"]}');

  expect(appended).toMatchObject({ status: 1, stdout: '', stderr: 'house: missing.pdf is not a readable file\n' });
  expect(hosted.mcp).toEqual([]);
});

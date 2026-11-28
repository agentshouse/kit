import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastCall, type Hosted } from './environment.ts';
import { accountOf, runKit, stop, temporaryHome } from './kit.ts';
import { digest, house, manifestOf, serveRooms, upload, type Room, type Rooms } from './rooms.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

function zeroEnumerations(hosted: Hosted): string[][] {
  return hosted.house.requests
    .filter((request) => request.path === '/kit/door/changes/enumerate')
    .map((request) => request.body as { prefixes: string[]; positions: { position: string }[] })
    .filter((body) => body.positions.every(({ position }) => position === '0'))
    .map((body) => body.prefixes);
}

function enumerations(hosted: Hosted): unknown[] {
  return hosted.house.requests
    .filter((request) => request.path === '/kit/door/changes/enumerate')
    .map((request) => request.body as { positions: { position: string }[] })
    .filter((body) => body.positions.every(({ position }) => position !== '0'));
}

function chunkLists(hosted: Hosted): unknown[] {
  return hosted.house.requests.filter((request) => request.path === '/kit/door/room-chunks/list').map((request) => request.body);
}

function discovered(hosted: Hosted): string[][] {
  return hosted.house.requests
    .filter((request) => request.path === '/kit/door/rooms/discover')
    .map((request) => (request.body as { prefixes: string[] }).prefixes);
}

function at(room: Room, position = room.position): { authority: string; position: string; log_epoch: string } {
  return { authority: room.ref, position: String(position), log_epoch: room.logEpoch };
}

function pairs<T>(items: readonly T[]): T[][] {
  return items.flatMap((_, index) => (index % 2 === 0 ? [items.slice(index, index + 2)] : []));
}

function stores(hosted: Hosted): number {
  return hosted.store.requests.filter((request) => request.method === 'GET' && request.key.startsWith('binary/')).length;
}

async function text(room: Room, path: string): Promise<string> {
  return readFile(join(room.repository, path), 'utf8');
}

function updated(...rooms: Room[]): string {
  return rooms.map((room) => `${room.root}: 1 file updated from House\n`).join('');
}

it('changes no Local copy on the agents One-way call or a Kit call, and still takes both', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  await rooms.download([room]);
  const asked = hosted.house.requests.length;

  room.put('a.md', 'a, from House\n');
  hosted.connection.send({ type: 'work_available', subject: 'agents' });
  hosted.call({ kind: 'open' });

  expect(await hosted.result(lastCall())).toHaveProperty('provider_session_id');
  expect(hosted.house.requests.slice(asked).some((request) => request.path === '/kit/agents/desired/list')).toBe(true);
  expect(
    hosted.house.requests.slice(asked).filter((request) => request.path === '/kit/local-copies/selection/read' || request.path.startsWith('/kit/door/')),
  ).toEqual([]);
  expect(await text(room, 'a.md')).toBe('a\n');
});

it('copies every Room it may sync as a plain folder as soon as it connects, and a reconnect copies none again and leaves the work in them', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notebook');
  notes.put('a.md', 'a\n');
  const design = rooms.room('design');
  design.put('brief.md', 'Brief\n');
  rooms.answered = [notes, design];

  await hosted.restart();

  await until(() => [notes, design].every((room) => existsSync(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`))));
  expect((await readdir(notes.repository)).sort()).toEqual(['.house', 'a.md']);
  expect(await manifestOf(design)).toEqual({ room_ref: design.ref, files: { 'brief.md': { revision: design.revision('brief.md'), sha256: digest('Brief\n'), bytes: 6 } } });
  expect(enumerations(hosted)).toEqual([]);
  await writeFile(join(notes.repository, 'a.md'), 'a, local\n');
  await writeFile(join(notes.repository, 'draft.md'), 'draft\n');
  const copied = zeroEnumerations(hosted).length;

  await hosted.restart();

  expect(await house(hosted, '/', 'download')).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });
  expect(zeroEnumerations(hosted)).toHaveLength(copied);
  expect(await text(notes, 'a.md')).toBe('a, local\n');
  expect(await text(notes, 'draft.md')).toBe('draft\n');
});

it("keeps a copied Room's documents at its root beside capture/ and collaboration/, marks what it may not write read-only, and makes no Git state", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.write = ['ROOM.md', 'plans'];
  room.put('ROOM.md', 'The notes Room\n');
  room.put('plans/q4.md', 'Ship it\n');
  room.put('archive/old.md', 'Read only for this grant\n');
  room.put('capture/mail/inbox/one.md', 'Hello from mail\n', 'source: s_mail\n');

  expect(await rooms.download([room])).toMatchObject({ status: 0, stdout: `${room.root}: copied to ${room.repository}\n` });

  expect((await readdir(room.repository)).sort()).toEqual(['.house', 'ROOM.md', 'archive', 'capture', 'plans']);
  expect(await text(room, 'capture/mail/inbox/_provenance/one.md')).toBe('source: s_mail\n');
  const { files } = await manifestOf(room);
  expect(Object.entries(files).filter(([, entry]) => entry.read_only === true).map(([path]) => path).sort()).toEqual([
    'archive/old.md',
    'capture/mail/inbox/_provenance/one.md',
    'capture/mail/inbox/one.md',
  ]);
  await writeFile(join(room.repository, 'archive/old.md'), 'changed here\n');
  await writeFile(join(room.repository, 'plans/q4.md'), 'Ship it, edited\n');

  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of rooms/notebook.\n' });
  expect(room.batches.flat().map((change) => change.path)).toEqual(['rooms/notebook/plans/q4.md']);

  room.put('archive/old.md', 'Read only, from House\n');
  expect(await house(hosted, '/', 'download')).toMatchObject({ status: 0, stdout: updated(room) });
  expect(await text(room, 'archive/old.md')).toBe('Read only, from House\n');
});

it('overwrites a file House changed only while it is unchanged here, keeps one changed here and a path House added that the copy holds, names each, and the next upload merges it', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  room.put('b.md', 'one\ntwo\nthree\n');
  room.put('gone.md', 'gone\n');
  await rooms.download([room]);
  const b = room.revision('b.md');
  await writeFile(join(room.repository, 'b.md'), 'one\ntwo\nTHREE\n');
  await writeFile(join(room.repository, 'c.md'), 'c, mine\n');

  room.put('a.md', 'a, from House\n');
  room.put('b.md', 'ONE\ntwo\nthree\n');
  room.put('c.md', 'c, theirs\n');
  room.put('d.md', 'd\n');
  room.remove('gone.md');
  const downloaded = await house(hosted, '/', 'download');

  expect(downloaded).toEqual({
    status: 0,
    stdout: [
      'rooms/notebook: 3 files updated from House',
      "rooms/notebook/b.md: changed here, so House's change was not brought; the next save merges it",
      "rooms/notebook/c.md: changed here, so House's change was not brought; the next save merges it",
      '',
    ].join('\n'),
    stderr: '',
  });
  expect(await text(room, 'a.md')).toBe('a, from House\n');
  expect(await text(room, 'b.md')).toBe('one\ntwo\nTHREE\n');
  expect(await text(room, 'c.md')).toBe('c, mine\n');
  expect(await text(room, 'd.md')).toBe('d\n');
  expect(existsSync(join(room.repository, 'gone.md'))).toBe(false);
  const { files } = await manifestOf(room);
  expect(files['b.md']!.revision).toBe(b);
  expect(files['c.md']).toBeUndefined();
  expect(files['gone.md']).toBeUndefined();

  const refused = await upload(hosted, room);
  expect(refused).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: House accepted 1 file of rooms/notebook.\nrooms/notebook/c.md: conflict markers written; the next save sends it once its markers go\n',
  });
  expect(room.files.get('b.md')!.content).toBe('ONE\ntwo\nTHREE\n');
  expect(await text(room, 'c.md')).toBe('<<<<<<< current\nc, theirs\n=======\nc, mine\n>>>>>>> yours\n');
  await writeFile(join(room.repository, 'c.md'), 'c, theirs and mine\n');

  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of rooms/notebook.\n' });
  expect(room.files.get('b.md')!.content).toBe('ONE\ntwo\nTHREE\n');
  expect(room.files.get('c.md')!.content).toBe('c, theirs and mine\n');
  expect(await text(room, 'b.md')).toBe('ONE\ntwo\nTHREE\n');
  expect(await house(hosted, '/', 'download')).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });
});

it("says nothing came from House when a download reads back only the copy's own upload", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('Meeting notes.md', 'notes\n');
  room.put('a.md', 'a\n');
  await rooms.download([room]);
  await writeFile(join(room.repository, 'Meeting notes.md'), 'notes, edited\n');
  await writeFile(join(room.repository, 'a.md'), 'a, edited\n');

  expect(await upload(hosted, room)).toMatchObject({ status: 0 });

  expect(await house(hosted, '/', 'download')).toEqual({ status: 0, stdout: 'Nothing new from House.\n', stderr: '' });
});

it('moves or removes each attachment the copy holds as the Room does, records every skipped one, and brings skipped ones up to --max-size with --with-attachments', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('ROOM.md', 'The notes Room\n');
  room.upload('photos/small.jpg', JPEG);
  room.upload('photos/large.jpg', Buffer.alloc(2_000_001, 1));
  await rooms.download([room]);
  expect(existsSync(join(room.repository, 'photos'))).toBe(false);
  expect((await manifestOf(room)).files['photos/small.jpg']).toEqual({ revision: room.revision('photos/small.jpg'), sha256: digest(JPEG), bytes: JPEG.length, skipped: true });

  expect(await house(hosted, '/', 'download', '--with-attachments', '--max-size', '2')).toMatchObject({ status: 0, stdout: updated(room) });

  expect(await readFile(join(room.repository, 'photos/small.jpg'))).toEqual(JPEG);
  expect(existsSync(join(room.repository, 'photos/large.jpg'))).toBe(false);
  expect((await manifestOf(room)).files['photos/large.jpg']).toMatchObject({ bytes: 2_000_001, skipped: true });
  expect((await manifestOf(room)).files['photos/small.jpg']).toEqual({ revision: room.revision('photos/small.jpg'), sha256: digest(JPEG), bytes: JPEG.length });

  const fetchedBytes = stores(hosted);
  room.move('photos/small.jpg', 'archive/small.jpg');
  expect(await house(hosted, '/', 'download')).toMatchObject({ status: 0, stdout: updated(room) });
  expect(await readFile(join(room.repository, 'archive/small.jpg'))).toEqual(JPEG);
  expect(existsSync(join(room.repository, 'photos'))).toBe(false);
  expect(stores(hosted)).toBe(fetchedBytes);

  room.remove('archive/small.jpg');
  room.remove('photos/large.jpg');
  expect(await house(hosted, '/', 'download')).toMatchObject({ status: 0, stdout: updated(room) });
  expect(existsSync(join(room.repository, 'archive'))).toBe(false);
  expect(Object.keys((await manifestOf(room)).files)).toEqual(['ROOM.md']);

  room.upload('photos/new.jpg', JPEG);
  expect(await house(hosted, '/', 'download', '--with-attachments')).toMatchObject({ status: 0, stdout: updated(room) });
  expect(await readFile(join(room.repository, 'photos/new.jpg'))).toEqual(JPEG);
  expect(await upload(hosted, room)).toMatchObject({ stdout: 'Nothing to upload: rooms/notebook matches House.\n' });
});

it("leaves a held attachment's file and entry as they were where the bytes of its new revision fail their SHA-256 check, and the next download brings that revision", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('ROOM.md', 'The notes Room\n');
  room.upload('photo.jpg', JPEG);
  await rooms.download([room], '--with-attachments');
  const held = (await manifestOf(room)).files['photo.jpg'];
  const redrawn = Buffer.concat([JPEG, Buffer.from('redrawn')]);
  room.upload('photo.jpg', redrawn);
  rooms.damages = true;

  expect(await house(hosted, '/', 'download')).toEqual({ status: 1, stdout: '', stderr: `house: ${room.root}/photo.jpg did not arrive whole; download it again\n` });

  expect(await readFile(join(room.repository, 'photo.jpg'))).toEqual(JPEG);
  expect((await manifestOf(room)).files['photo.jpg']).toEqual(held);
  rooms.damages = false;
  expect(await house(hosted, '/', 'download')).toEqual({ status: 0, stdout: `${updated(room)}${room.root}: attachment brought at its new revision: photo.jpg\n`, stderr: '' });
  expect(await readFile(join(room.repository, 'photo.jpg'))).toEqual(redrawn);
  expect((await manifestOf(room)).files['photo.jpg']).toEqual({ revision: room.revision('photo.jpg'), sha256: digest(redrawn), bytes: redrawn.length });
});

it.each([
  [['--max-size', 'big']],
  [['--with-attachments', '--max-size']],
  [['--max-size', '', '--with-attachments']],
])('refuses house download %j, whose --max-size names no number of megabytes, before it asks for anything', async (flags) => {
  const hosted = await hostKit();
  const asked = hosted.house.requests.length;
  const refused = await house(hosted, '/', 'download', ...flags);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toMatch(/^house: --max-size takes a number of megabytes; usage: house download/);
  expect(hosted.house.requests.slice(asked).filter((request) => request.path === '/kit/local-copies/selection/read')).toEqual([]);
});

it("keeps the copied Rooms beneath the workspace kit.json names and none beneath Kit home", async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], { workspace });
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notebook');
  notes.put('plan.md', 'plan\n');

  await rooms.download([notes]);

  const repository = join(workspace, 'rooms', 'notebook');
  expect(await readFile(join(repository, 'plan.md'), 'utf8')).toBe('plan\n');
  expect(notes.repository).toBe(repository);
  expect(existsSync(join(accountOf(hosted.home), 'house', 'rooms', 'notebook'))).toBe(false);
});

it.each([2, 3, 5])(
  'downloads %i changed Rooms in reads of at most the two prefixes House declares, each enumeration asking its own Rooms from their positions',
  async (count) => {
    const hosted = await hostKit();
    const rooms = serveRooms(hosted);
    rooms.maxPrefixes = 2;
    const copied = Array.from({ length: count }, (_, index) => rooms.room(`room-${index}`));
    for (const room of copied) room.put('a.md', 'a\n');
    await rooms.download(copied);
    const discoveries = discovered(hosted).length;
    const asked = pairs(copied.map((room) => ({ root: room.root, position: at(room) })));
    for (const room of copied) room.put('a.md', `a, from House to ${room.handle}\n`);

    expect(await house(hosted, '/', 'download')).toMatchObject({ status: 0, stdout: updated(...copied) });

    const reads = discovered(hosted).slice(discoveries);
    expect(reads.every((prefixes) => prefixes.length > 0 && prefixes.length <= 2)).toBe(true);
    expect(reads.flat()).toEqual(copied.map((room) => room.root));
    expect(enumerations(hosted)).toEqual(asked.map((group) => ({ prefixes: group.map(({ root }) => root), positions: group.map(({ position }) => position) })));
    for (const room of copied) expect(await text(room, 'a.md')).toBe(`a, from House to ${room.handle}\n`);
  },
);

it('reads a Room whole again when its grant changed or House no longer holds its position, keeping what changed here', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const copied = ['notebook', 'regranted', 'expired'].map((handle) => rooms.room(handle));
  const [notes, regranted, expired] = copied as [Room, Room, Room];
  for (const room of copied) {
    room.put('a.md', 'a\n');
    room.put('mine.md', 'mine\n');
  }
  await rooms.download(copied);
  for (const room of copied) {
    room.put('a.md', `a, from House to ${room.handle}\n`);
    room.put('mine.md', 'theirs\n');
    await writeFile(join(room.repository, 'mine.md'), 'mine, edited\n');
  }
  regranted.protected = [...regranted.protected, 'archive'];
  rooms.expired.add(expired.ref);

  expect((await house(hosted, '/', 'download')).status).toBe(0);

  for (const room of copied) {
    expect(await text(room, 'a.md')).toBe(`a, from House to ${room.handle}\n`);
    expect(await text(room, 'mine.md')).toBe('mine, edited\n');
  }
  expect(chunkLists(hosted)).toEqual([{ prefixes: [regranted.root] }, { prefixes: [expired.root] }]);
  expect(enumerations(hosted)).toContainEqual({ prefixes: [notes.root, expired.root], positions: [at(notes, 3), at(expired, 3)] });
});

it("renames a copy's folder with the handle House names, every file in it, unuploaded and conflicted ones included, and builds its paths with that handle", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('a.md', 'a\n');
  room.put('c.md', 'c\n');
  await rooms.download([room]);
  const earlier = room.repository;
  await writeFile(join(earlier, 'c.md'), 'c, mine\n');
  room.put('c.md', 'c, from House\n');
  expect(await upload(hosted, room)).toMatchObject({ status: 1 });
  await writeFile(join(earlier, 'draft.md'), 'draft, not uploaded\n');
  const conflicted = await text(room, 'c.md');

  room.rehandle('renamed-notes');
  room.put('a.md', 'a, from House\n');
  expect(await rooms.download([room])).toMatchObject({ status: 0, stdout: 'rooms/renamed-notes: 1 file updated from House\n' });

  expect(room.repository).toBe(join(hosted.workspace, 'rooms', 'renamed-notes'));
  expect(existsSync(earlier)).toBe(false);
  expect(JSON.parse(await readFile(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`), 'utf8'))).toMatchObject({ room_handle: 'renamed-notes', repository: room.repository });
  expect(await text(room, 'a.md')).toBe('a, from House\n');
  expect(await text(room, 'draft.md')).toBe('draft, not uploaded\n');
  expect(await text(room, 'c.md')).toBe(conflicted);
  expect((await manifestOf(room)).files['c.md']).toMatchObject({ conflicted: true });
  await writeFile(join(room.repository, 'c.md'), 'c, resolved\n');
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 2 files of rooms/renamed-notes.\n' });
});

it("sets aside the folder of a Room it no longer follows as ' (kept)' where another Room's folder takes its name, every file kept, and leaves the folder of a Room it stopped following under its name", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const [notes, design, lowered] = ['notebook', 'design', 'lowered'].map((handle) => rooms.room(handle)) as [Room, Room, Room];
  for (const room of [notes, design, lowered]) room.put('a.md', `a of ${room.handle}\n`);
  await rooms.download([notes, design, lowered]);
  await writeFile(join(notes.repository, 'draft.md'), 'draft, not uploaded\n');
  const taken = join(hosted.workspace, 'rooms', 'notebook (kept)');
  await mkdir(taken);
  await writeFile(join(taken, 'mine.md'), 'mine\n');
  const left = notes.repository;
  await rooms.download([design]);
  notes.rehandle('old-notes');

  design.rehandle('notebook');
  expect((await rooms.download([design])).status).toBe(0);

  expect(design.repository).toBe(left);
  expect(await text(design, 'a.md')).toBe('a of design\n');
  const kept = join(hosted.workspace, 'rooms', 'notebook (kept) 2');
  expect(await readFile(join(kept, 'a.md'), 'utf8')).toBe('a of notebook\n');
  expect(await readFile(join(kept, 'draft.md'), 'utf8')).toBe('draft, not uploaded\n');
  expect(await readFile(join(taken, 'mine.md'), 'utf8')).toBe('mine\n');
  expect(JSON.parse(await readFile(join(hosted.home, 'local-copies/rooms', `${notes.ref}.json`), 'utf8'))).toMatchObject({ repository: kept });
  expect(await text(lowered, 'a.md')).toBe('a of lowered\n');
  expect((await readdir(join(hosted.workspace, 'rooms'))).filter((name) => !name.startsWith('.')).sort()).toEqual(['lowered', 'notebook', 'notebook (kept)', 'notebook (kept) 2']);
});

it("keeps a Room's folder an Agent's owner chose as its launch directory through a handle change, and leaves it where another Room's folder is to take its name, saying so", async () => {
  const home = await temporaryHome();
  const chosen = join(accountOf(home), 'house', 'rooms', 'notebook');
  const hosted = await hostKit([{ working_directory: chosen }], { home });
  const rooms = serveRooms(hosted);
  const [notes, design] = ['notebook', 'design'].map((handle) => rooms.room(handle)) as [Room, Room];
  notes.put('a.md', 'a\n');
  design.put('brief.md', 'Brief\n');
  await rooms.download([notes, design]);
  await writeFile(join(chosen, 'draft.md'), 'draft\n');

  notes.rehandle('renamed-notes');
  expect((await rooms.download([notes, design])).status).toBe(0);

  expect(await readFile(join(chosen, 'draft.md'), 'utf8')).toBe('draft\n');
  expect(JSON.parse(await readFile(join(hosted.home, 'local-copies/rooms', `${notes.ref}.json`), 'utf8'))).toMatchObject({ room_handle: 'renamed-notes', repository: chosen });
  design.rehandle('notebook');
  expect(await rooms.download([notes, design])).toMatchObject({
    status: 1,
    stderr: `house: rooms/notebook: ${chosen} holds a folder an Agent works in, so Kit leaves it as it is\n`,
  });
  expect(await readFile(join(chosen, 'a.md'), 'utf8')).toBe('a\n');
  expect(await readFile(join(hosted.workspace, 'rooms', 'design', 'brief.md'), 'utf8')).toBe('Brief\n');
});

it("reads which folders its Agents' owners chose from House for a download before its first read of the Agents, so the chosen folder keeps its path", async () => {
  const home = await temporaryHome();
  const chosen = join(accountOf(home), 'house', 'rooms', 'notebook');
  const hosted = await hostKit([{ working_directory: chosen }], { home });
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notebook');
  notes.put('a.md', 'a\n');
  await rooms.download([notes]);
  stop(hosted.kit.pid);
  await hosted.kit.exited;
  hosted.house.route('POST', '/kit/kits/report-restart', () => new Promise<never>(() => undefined));
  const restarts = hosted.house.requests.filter((request) => request.path === '/kit/kits/report-restart').length;
  hosted.kit = runKit(['resident'], hosted.environment);
  await until(() => hosted.house.requests.filter((request) => request.path === '/kit/kits/report-restart').length > restarts || undefined);

  notes.rehandle('renamed-notes');
  expect((await rooms.download([notes])).status).toBe(0);

  expect(await readFile(join(chosen, 'a.md'), 'utf8')).toBe('a\n');
  expect(JSON.parse(await readFile(join(hosted.home, 'local-copies/rooms', `${notes.ref}.json`), 'utf8'))).toMatchObject({ room_handle: 'renamed-notes', repository: chosen });
});

const DENIED = 'operation_denied: you may not write here; the Room owner grants Room access, your User widens an Agent at /agents';

async function unfollowed(rooms: Rooms): Promise<{ notes: Room; design: Room }> {
  const notes = rooms.room('notebook');
  notes.put('a.md', 'a\n');
  notes.put('capture/mail/one.md', 'one\n');
  const design = rooms.room('design');
  design.put('brief.md', 'Brief\n');
  await rooms.download([notes, design]);
  await writeFile(join(notes.repository, 'a.md'), 'a, local\n');
  await writeFile(join(notes.repository, 'draft.md'), 'draft\n');
  expect(await rooms.download([design])).toMatchObject({ status: 0, stdout: `${notes.root}: no longer followed; kept as it is\n` });
  return { notes, design };
}

it('keeps a Room House no longer answers with its files and record, says once that it no longer follows it, and refreshes the other Rooms', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const { notes, design } = await unfollowed(rooms);
  design.put('brief.md', 'Brief, from House\n');
  notes.put('a.md', 'a, from House\n');
  const asked = hosted.house.requests.length;

  expect(await rooms.download([design])).toMatchObject({ status: 0, stdout: updated(design) });

  expect(JSON.stringify(hosted.house.requests.slice(asked).filter((request) => request.path.startsWith('/kit/door/')))).not.toContain(notes.ref);
  expect(await text(notes, 'a.md')).toBe('a, local\n');
  expect(await text(notes, 'draft.md')).toBe('draft\n');
  expect(existsSync(join(hosted.home, 'local-copies/rooms', `${notes.ref}.json`))).toBe(true);
});

it("sends an upload from a Room it no longer follows to House and prints House's refusal, changing nothing here", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const { notes } = await unfollowed(rooms);
  const manifest = await manifestOf(notes);
  rooms.refusesBatches = [{ status: 403, body: { error: { code: 'operation_denied', message: DENIED, retryable: false } } }];

  expect(await upload(hosted, notes)).toMatchObject({ status: 1, stderr: `house: ${DENIED}\n` });

  expect(await manifestOf(notes)).toEqual(manifest);
  expect(await text(notes, 'a.md')).toBe('a, local\n');
  expect(notes.files.get('a.md')!.content).toBe('a\n');
});

it('catches a Room House answers again up from the position it kept, reading no chunk, and keeps what changed here', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const { notes, design } = await unfollowed(rooms);
  const position = at(notes);
  notes.put('b.md', 'b, from House\n');
  const enumerated = enumerations(hosted).length;

  expect(await rooms.download([notes, design])).toMatchObject({ status: 0, stdout: updated(notes) });

  expect(chunkLists(hosted)).toEqual([]);
  expect(enumerations(hosted).slice(enumerated)).toEqual([{ prefixes: [notes.root, design.root], positions: [position, at(design)] }]);
  expect(await text(notes, 'b.md')).toBe('b, from House\n');
  expect(await text(notes, 'a.md')).toBe('a, local\n');
  expect(await upload(hosted, notes)).toMatchObject({ status: 0, stdout: 'House accepted 2 files of rooms/notebook.\n' });
  expect(notes.files.get('a.md')!.content).toBe('a, local\n');
});

it('keeps a file holding the conflict markers an upload wrote through a download that brings a newer change of it, and the resolution merges with that change', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notebook');
  room.put('plan.md', 'one\ntwo\nthree\nfour\nfive\n');
  await rooms.download([room]);
  room.put('plan.md', 'one\nTWO, theirs\nthree\nfour\nfive\n');
  const conflicted = room.revision('plan.md');
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo, mine\nthree\nfour\nfive\n');
  expect((await upload(hosted, room)).status).toBe(1);
  const marked = await text(room, 'plan.md');
  room.put('plan.md', 'one\nTWO, theirs\nthree\nfour\nFIVE\n');

  expect(await house(hosted, '/', 'download')).toEqual({
    status: 0,
    stdout: "rooms/notebook/plan.md: changed here, so House's change was not brought; the next save merges it\n",
    stderr: '',
  });
  expect(await text(room, 'plan.md')).toBe(marked);
  expect((await manifestOf(room)).files['plan.md']).toMatchObject({ revision: conflicted, conflicted: true });

  await writeFile(join(room.repository, 'plan.md'), 'one\nTWO, both\nthree\nfour\nfive\n');
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of rooms/notebook.\n' });
  expect(room.files.get('plan.md')!.content).toBe('one\nTWO, both\nthree\nfour\nFIVE\n');
  expect(await text(room, 'plan.md')).toBe('one\nTWO, both\nthree\nfour\nFIVE\n');
});

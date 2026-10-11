import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastInput, type Hosted } from './environment.ts';
import { temporaryHome } from './kit.ts';
import { commitAll, git, house, serveRooms, tryGit, type Room } from './rooms.ts';

function received(room: Room): string {
  return git(room.repository, 'rev-parse', 'refs/house/received').trim();
}

function tracked(room: Room): string[] {
  return git(room.repository, 'ls-files').trim().split('\n');
}

function enumerations(hosted: Hosted): unknown[] {
  return hosted.house.requests.filter((request) => request.path === '/kit/door/enumerate').map((request) => request.body);
}

it('changes no Local copy on a stream frame, and still takes the agents signal and inputs', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  await rooms.select([room]);
  const before = received(room);
  const asked = hosted.house.requests.length;

  room.put('a.md', 'a, from House\n');
  hosted.socket.send({ type: 'entries', authority: room.ref, position: String(room.position), log_epoch: room.logEpoch, entries: [] });
  hosted.socket.send({ type: 'work_available', subject: 'local_copy' });
  hosted.socket.send({ type: 'work_available', subject: 'agents' });
  hosted.input({ kind: 'open' });

  expect(await hosted.ack(lastInput())).toHaveProperty('provider_session_id');
  expect(hosted.house.requests.slice(asked).some((request) => request.path === '/kit/agents/desired')).toBe(true);
  expect(
    hosted.house.requests
      .slice(asked)
      .filter((request) => request.path === '/kit/local-copy/selection' || request.path.startsWith('/kit/door/')),
  ).toEqual([]);
  expect(received(room)).toBe(before);
});

it('copies a Room it may sync as soon as it connects and leaves a copy it holds for house fetch', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const held = rooms.room('held');
  held.put('a.md', 'a\n');
  await rooms.select([held]);
  const before = received(held);
  const added = rooms.room('added');
  added.put('b.md', 'b\n');
  held.put('a.md', 'a, from House\n');
  rooms.selection = { rooms: [held, added].map((room) => ({ room_ref: room.ref, room_handle: room.handle })) };

  await hosted.restart();

  await until(() => existsSync(join(added.repository, 'b.md')));
  expect(tracked(added)).toEqual(['b.md']);
  expect(received(held)).toBe(before);
  expect(enumerations(hosted)).toEqual([]);
});

it("keeps a selected Room's documents at the copy's root beside capture/ and collaboration/, and Git tracks only the documents", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('notes.md', 'Notes\n');
  room.put('plans/q4.md', 'Ship it\n');
  room.put('capture/mail/one.md', 'one\n');
  room.put('collaboration/requests/r1.md', 'A request\n');

  await rooms.select([room]);

  expect((await readdir(room.repository)).sort()).toEqual([
    '.git',
    '.gitignore',
    '.ignore',
    'capture',
    'collaboration',
    'notes.md',
    'plans',
  ]);
  expect(tracked(room)).toEqual(['notes.md', 'plans/q4.md']);
});

it('never lets a change under capture/ into a local commit, and pushes the root document the commit changes', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('notes.md', 'Notes\n');
  room.put('capture/mail/one.md', 'one\n');
  await rooms.select([room]);

  await writeFile(join(room.repository, 'capture/mail/one.md'), 'one, changed here\n');
  await writeFile(join(room.repository, 'capture/mail/two.md'), 'two, added here\n');
  await writeFile(join(room.repository, 'notes.md'), 'Notes, edited\n');
  const commit = commitAll(room.repository, 'everything');

  expect(git(room.repository, 'show', '--name-only', '--format=', commit).trim()).toBe('notes.md');
  expect(await house(hosted, room.repository, 'push', '--owner')).toMatchObject({ status: 0 });
  expect(room.batches.flat().map((change) => change.path)).toEqual(['/rooms/notes/notes.md']);
  expect(room.files.get('notes.md')!.content).toBe('Notes, edited\n');
  expect(room.files.get('capture/mail/one.md')!.content).toBe('one\n');
  expect(room.files.has('capture/mail/two.md')).toBe(false);
});

it('keeps each selected Room as its own Git repository with its readable tree, tracking only what House lets it write', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.write = ['ROOM.md', 'plans'];
  notes.put('ROOM.md', 'The notes Room\n');
  notes.put('plans/q4.md', 'Ship it\n');
  notes.put('archive/old.md', 'Read only for this grant\n');
  notes.put('capture/mail/inbox/one.md', 'Hello from mail\n', 'source: s_mail\n');
  notes.put('collaboration/requests/r1.md', 'A request\n');
  const design = rooms.room('design');
  design.put('brief.md', 'Brief\n');

  await rooms.select([notes, design]);

  expect(tracked(notes)).toEqual(['ROOM.md', 'plans/q4.md']);
  expect(tracked(design)).toEqual(['brief.md']);
  expect(git(notes.repository, 'rev-parse', 'main')).toBe(git(notes.repository, 'rev-parse', 'refs/house/received'));
  expect(git(notes.repository, 'status', '--porcelain')).toBe('');
  expect(await readFile(join(notes.repository, 'capture/mail/inbox/one.md'), 'utf8')).toBe('Hello from mail\n');
  expect(await readFile(join(notes.repository, 'capture/mail/inbox/_provenance/one.md'), 'utf8')).toBe('source: s_mail\n');
  expect(await readFile(join(notes.repository, 'archive/old.md'), 'utf8')).toBe('Read only for this grant\n');
  for (const path of ['capture/mail/inbox/one.md', 'archive/old.md', 'collaboration/requests/r1.md']) {
    expect(git(notes.repository, 'check-ignore', path).trim()).toBe(path);
  }
  const ignored = (await readFile(join(notes.repository, '.gitignore'), 'utf8')).split('\n');
  const searched = (await readFile(join(notes.repository, '.ignore'), 'utf8')).split('\n');
  expect(ignored).toEqual(expect.arrayContaining(['/capture', '/collaboration', '/archive/old.md']));
  expect(searched).toEqual(expect.arrayContaining(['!/capture', '!/collaboration', '!/archive/old.md', '!_provenance']));
});

it('keeps the selected Rooms beneath the native workspace root and nothing under /agents/house', async () => {
  const workspace = await temporaryHome();
  const hosted = await hostKit([{}], { environment: { HOUSE_KIT_WORKSPACE: workspace } });
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('plan.md', 'plan\n');

  await rooms.select([notes]);

  const repository = join(workspace, 'local-copies', 'rooms', notes.ref);
  await until(() => existsSync(join(repository, 'plan.md')));
  expect(git(repository, 'ls-files').trim()).toBe('plan.md');
  expect(existsSync(notes.repository)).toBe(false);
});

it('copies the Private Room at /rooms/private like any selected Room', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const shared = rooms.room('shared');
  shared.put('a.md', 'a\n');
  const own = rooms.room('private');
  own.put('diary.md', 'Private\n');

  await rooms.select([shared]);
  expect(existsSync(own.repository)).toBe(false);

  await rooms.select([shared, own]);
  expect(tracked(own)).toEqual(['diary.md']);
  expect(hosted.house.requests.filter((request) => request.path === '/kit/door/bootstrap').map((request) => request.body)).toEqual([
    { prefixes: ['/rooms/shared'] },
    { prefixes: ['/rooms/private'] },
  ]);
});

it('fetches every changed Room in one enumeration onto its House ref and read-only content, and leaves the branch, the index and working files alone', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  room.put('b.md', 'b\n');
  room.put('capture/mail/one.md', 'one\n');
  const other = rooms.room('design');
  other.put('brief.md', 'Brief\n');
  await rooms.select([room, other]);
  await writeFile(join(room.repository, 'a.md'), 'a, committed locally\n');
  const local = commitAll(room.repository, 'local work');
  await writeFile(join(room.repository, 'b.md'), 'b, staged\n');
  git(room.repository, 'add', 'b.md');
  await writeFile(join(room.repository, 'b.md'), 'b, unstaged\n');
  await writeFile(join(room.repository, 'draft.md'), 'draft\n');
  const status = git(room.repository, 'status', '--porcelain');
  const houseRefs = [received(room), received(other)];
  const positions = [room, other].map((copied) => ({ authority: copied.ref, position: String(copied.position), log_epoch: copied.logEpoch }));

  room.put('a.md', 'a, from House\n');
  room.put('c.md', 'c, new in House\n');
  room.put('capture/mail/two.md', 'two\n');
  room.remove('capture/mail/one.md');
  other.put('brief.md', 'Brief, from House\n');
  const fetched = await house(hosted, '/', 'fetch');

  expect(fetched).toMatchObject({
    status: 0,
    stdout: expect.stringMatching(/^\/rooms\/notes: refs\/house\/received is at [0-9a-f]{12}\n\/rooms\/design: refs\/house\/received is at [0-9a-f]{12}\n$/),
  });
  expect(enumerations(hosted)).toEqual([{ prefixes: ['/rooms/notes', '/rooms/design'], positions }]);
  expect(git(room.repository, 'rev-parse', 'refs/house/received^').trim()).toBe(houseRefs[0]);
  expect(git(other.repository, 'rev-parse', 'refs/house/received^').trim()).toBe(houseRefs[1]);
  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a, from House\n');
  expect(git(room.repository, 'show', 'refs/house/received:c.md')).toBe('c, new in House\n');
  expect(git(other.repository, 'show', 'refs/house/received:brief.md')).toBe('Brief, from House\n');
  expect(git(room.repository, 'rev-parse', 'main').trim()).toBe(local);
  expect(git(room.repository, 'status', '--porcelain')).toBe(status);
  expect(await readFile(join(room.repository, 'a.md'), 'utf8')).toBe('a, committed locally\n');
  expect(git(room.repository, 'show', ':b.md')).toBe('b, staged\n');
  expect(await readFile(join(room.repository, 'b.md'), 'utf8')).toBe('b, unstaged\n');
  expect(await readFile(join(room.repository, 'draft.md'), 'utf8')).toBe('draft\n');
  expect(existsSync(join(room.repository, 'c.md'))).toBe(false);
  expect(await readFile(join(room.repository, 'capture/mail/two.md'), 'utf8')).toBe('two\n');
  expect(existsSync(join(room.repository, 'capture/mail/one.md'))).toBe(false);

  const fetchedHouseRefs = [received(room), received(other)];
  expect(await house(hosted, '/', 'fetch')).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });
  expect([received(room), received(other)]).toEqual(fetchedHouseRefs);
  expect(git(room.repository, 'status', '--porcelain')).toBe(status);
});

it('fetches one pass House bounds and the next fetch continues from it, and says when only read-only files changed', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  await rooms.select([room]);
  rooms.pass = 1;
  room.put('a.md', 'a, first\n');
  room.put('b.md', 'b\n');

  expect((await house(hosted, '/', 'fetch')).stdout).toMatch(/^\/rooms\/notes: refs\/house\/received is at [0-9a-f]{12}\n$/);
  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a, first\n');
  expect(tryGit(room.repository, 'cat-file', '-e', 'refs/house/received:b.md').status).not.toBe(0);
  expect(enumerations(hosted)).toHaveLength(1);

  await house(hosted, '/', 'fetch');
  expect(git(room.repository, 'show', 'refs/house/received:b.md')).toBe('b\n');
  expect(enumerations(hosted)).toHaveLength(2);

  const ref = received(room);
  room.put('capture/mail/one.md', 'one\n');
  expect(await house(hosted, '/', 'fetch')).toMatchObject({ status: 0, stdout: '/rooms/notes: read-only files refreshed\n' });
  expect(received(room)).toBe(ref);
  expect(await readFile(join(room.repository, 'capture/mail/one.md'), 'utf8')).toBe('one\n');
});

it('keeps a copy where it is through a handle change, stops it on deselection and refreshes only received state on reselection', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  room.put('capture/mail/one.md', 'one\n');
  await rooms.select([room]);

  room.handle = 'renamed-notes';
  await rooms.select([room]);
  expect(await readFile(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`), 'utf8')).toContain('renamed-notes');
  expect(existsSync(room.repository)).toBe(true);

  await writeFile(join(room.repository, 'a.md'), 'a, local\n');
  const local = commitAll(room.repository, 'local');
  await writeFile(join(room.repository, 'draft.md'), 'draft\n');
  expect(await rooms.select([])).toMatchObject({
    status: 0,
    stdout: '/rooms/renamed-notes: no longer synced to this Environment; its files stay\n',
  });
  const deselected = hosted.house.requests.length;
  room.put('a.md', 'a, from House\n');
  expect(await house(hosted, '/', 'fetch')).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });
  expect(hosted.house.requests.slice(deselected).filter((request) => request.path.startsWith('/kit/door/'))).toEqual([]);
  expect(git(room.repository, 'rev-parse', 'HEAD').trim()).toBe(local);
  expect(await readFile(join(room.repository, 'draft.md'), 'utf8')).toBe('draft\n');
  expect(await house(hosted, room.repository, 'push', '--owner')).toMatchObject({
    status: 1,
    stderr: 'house: /rooms/renamed-notes is no longer synced to this Environment, so House takes no push from it\n',
  });

  await rooms.select([room]);
  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a, from House\n');
  expect(git(room.repository, 'rev-parse', 'HEAD').trim()).toBe(local);
  expect(await readFile(join(room.repository, 'a.md'), 'utf8')).toBe('a, local\n');
  expect(await readFile(join(room.repository, 'draft.md'), 'utf8')).toBe('draft\n');
});

it('reads the Room whole again when House no longer holds the copy position, and fetches the other Rooms beside it', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  const other = rooms.room('design');
  other.put('brief.md', 'Brief\n');
  await rooms.select([room, other]);

  room.put('a.md', 'a, much later\n');
  other.put('brief.md', 'Brief, later\n');
  rooms.expired.add(room.ref);
  expect((await house(hosted, '/', 'fetch')).status).toBe(0);

  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a, much later\n');
  expect(git(other.repository, 'show', 'refs/house/received:brief.md')).toBe('Brief, later\n');
  expect(hosted.house.requests.filter((request) => request.path === '/kit/door/bootstrap')).toHaveLength(3);
  expect(enumerations(hosted)).toHaveLength(2);
});

it('reads a bundle House hands over through a transfer address', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  hosted.house.route('POST', '/kit/door/bootstrap', () => ({
    body: { transfer: { act: 'local_copy_bundle', method: 'GET', url: `${hosted.house.origin}/files/bundle-1` } },
  }));
  hosted.house.route('GET', '/files/:grant', () => ({ body: { scopes: [room.bundle()] } }));

  await rooms.select([room]);

  expect(tracked(room)).toEqual(['a.md']);
});

import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, type Hosted } from './environment.ts';
import { COPIES, commitAll, git, house, serveRooms, type Room } from './rooms.ts';

const PRIVATE = join(COPIES, 'private');

function received(room: Room): string {
  return git(room.repository, 'rev-parse', 'refs/house/received').trim();
}

function tracked(room: Room): string[] {
  return git(room.repository, 'ls-files').trim().split('\n');
}

async function deliveredTo(hosted: Hosted, room: Room): Promise<void> {
  const before = received(room);
  hosted.socket.send({
    type: 'entries',
    authority: room.ref,
    position: String(room.position),
    log_epoch: room.logEpoch,
    entries: [],
  });
  await until(() => received(room) !== before);
}

it('copies nothing while the Environment keeps no saved choice', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('library/plan.md', 'plan\n');

  hosted.socket.send({ type: 'work_available', subject: 'working_copy' });

  await until(() => hosted.house.requests.filter((request) => request.path === '/kit/working-copy/selection').length >= 2);
  expect(hosted.house.requests.filter((request) => request.path.startsWith('/kit/door/'))).toEqual([]);
  expect(existsSync(room.repository)).toBe(false);
});

it('keeps each selected Room as its own Git repository with its readable tree, tracking only what House lets it write', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.write = ['ROOM.md', 'library/plans'];
  notes.put('ROOM.md', 'The notes Room\n');
  notes.put('library/plans/q4.md', 'Ship it\n');
  notes.put('library/archive/old.md', 'Read only for this grant\n');
  notes.put('capture/mail/inbox/one.md', 'Hello from mail\n', 'source: s_mail\n');
  notes.put('collaboration/requests/r1.md', 'A request\n');
  const design = rooms.room('design');
  design.put('library/brief.md', 'Brief\n');

  await rooms.select([notes, design]);

  expect(tracked(notes)).toEqual(['ROOM.md', 'library/plans/q4.md']);
  expect(tracked(design)).toEqual(['library/brief.md']);
  expect(git(notes.repository, 'rev-parse', 'main')).toBe(git(notes.repository, 'rev-parse', 'refs/house/received'));
  expect(git(notes.repository, 'status', '--porcelain')).toBe('');
  expect(await readFile(join(notes.repository, 'capture/mail/inbox/one.md'), 'utf8')).toBe('Hello from mail\n');
  expect(await readFile(join(notes.repository, 'capture/mail/inbox/_provenance/one.md'), 'utf8')).toBe('source: s_mail\n');
  expect(await readFile(join(notes.repository, 'library/archive/old.md'), 'utf8')).toBe('Read only for this grant\n');
  for (const path of ['capture/mail/inbox/one.md', 'library/archive/old.md', 'collaboration/requests/r1.md']) {
    expect(git(notes.repository, 'check-ignore', path).trim()).toBe(path);
  }
  const ignored = (await readFile(join(notes.repository, '.gitignore'), 'utf8')).split('\n');
  const searched = (await readFile(join(notes.repository, '.ignore'), 'utf8')).split('\n');
  expect(ignored).toEqual(expect.arrayContaining(['/capture', '/collaboration', '/library/archive/old.md']));
  expect(searched).toEqual(expect.arrayContaining(['!/capture', '!/collaboration', '!/library/archive/old.md', '!_provenance']));
  expect(existsSync(PRIVATE)).toBe(false);
});

it('copies /private only through its own choice', async () => {
  await rm(PRIVATE, { recursive: true, force: true });
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const shared = rooms.room('shared');
  shared.put('library/a.md', 'a\n');
  const own = rooms.room(null);
  own.put('library/diary.md', 'Private\n');

  await rooms.select([shared]);
  expect(existsSync(PRIVATE)).toBe(false);

  await rooms.select([shared, own]);
  expect(tracked(own)).toEqual(['library/diary.md']);
  expect(hosted.house.requests.filter((request) => request.path === '/kit/door/bootstrap').map((request) => request.body)).toEqual([
    { prefixes: ['/rooms/shared/capture', '/rooms/shared/library', '/rooms/shared/collaboration'] },
    { prefixes: ['/private'] },
  ]);
});

it('delivers House changes to the House ref and read-only content and leaves the branch, the index and working files alone', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('library/a.md', 'a\n');
  room.put('library/b.md', 'b\n');
  room.put('capture/mail/one.md', 'one\n');
  await rooms.select([room]);
  await writeFile(join(room.repository, 'library/a.md'), 'a, committed locally\n');
  const local = commitAll(room.repository, 'local work');
  await writeFile(join(room.repository, 'library/b.md'), 'b, staged\n');
  git(room.repository, 'add', 'library/b.md');
  await writeFile(join(room.repository, 'library/b.md'), 'b, unstaged\n');
  const status = git(room.repository, 'status', '--porcelain');

  room.put('library/a.md', 'a, from House\n');
  room.put('library/c.md', 'c, new in House\n');
  room.put('capture/mail/two.md', 'two\n');
  room.remove('capture/mail/one.md');
  await deliveredTo(hosted, room);

  expect(git(room.repository, 'show', 'refs/house/received:library/a.md')).toBe('a, from House\n');
  expect(git(room.repository, 'show', 'refs/house/received:library/c.md')).toBe('c, new in House\n');
  expect(git(room.repository, 'rev-parse', 'main').trim()).toBe(local);
  expect(git(room.repository, 'status', '--porcelain')).toBe(status);
  expect(await readFile(join(room.repository, 'library/a.md'), 'utf8')).toBe('a, committed locally\n');
  expect(git(room.repository, 'show', ':library/b.md')).toBe('b, staged\n');
  expect(existsSync(join(room.repository, 'library/c.md'))).toBe(false);
  expect(await readFile(join(room.repository, 'capture/mail/two.md'), 'utf8')).toBe('two\n');
  expect(existsSync(join(room.repository, 'capture/mail/one.md'))).toBe(false);
});

it('keeps a copy where it is through a handle change, stops it on deselection and refreshes only received state on reselection', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('library/a.md', 'a\n');
  room.put('capture/mail/one.md', 'one\n');
  await rooms.select([room]);

  room.handle = 'renamed-notes';
  await rooms.select([room]);
  await until(async () => (await readFile(join(hosted.home, 'working-copies/rooms', `${room.ref}.json`), 'utf8')).includes('renamed-notes'));
  expect(existsSync(room.repository)).toBe(true);

  await writeFile(join(room.repository, 'library/a.md'), 'a, local\n');
  const local = commitAll(room.repository, 'local');
  await writeFile(join(room.repository, 'library/draft.md'), 'draft\n');
  const deselected = hosted.house.requests.length;
  rooms.selection = { rooms: [], private: false };
  hosted.socket.send({ type: 'work_available', subject: 'working_copy' });
  await until(async () => (await readFile(join(hosted.home, 'working-copies/rooms', `${room.ref}.json`), 'utf8')).includes('"active":false'));
  room.put('library/a.md', 'a, from House\n');
  hosted.socket.send({ type: 'entries', authority: room.ref, position: String(room.position), log_epoch: room.logEpoch, entries: [] });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(hosted.house.requests.slice(deselected).filter((request) => request.path.startsWith('/kit/door/'))).toEqual([]);
  expect(git(room.repository, 'rev-parse', 'HEAD').trim()).toBe(local);
  expect(await readFile(join(room.repository, 'library/draft.md'), 'utf8')).toBe('draft\n');
  expect(await house(hosted, room.repository, 'git', 'push', '--owner')).toMatchObject({
    status: 1,
    stderr: 'house: /rooms/renamed-notes is no longer synced to this Environment, so House takes no push from it\n',
  });

  const before = received(room);
  await rooms.select([room]);
  await until(() => received(room) !== before);
  expect(git(room.repository, 'show', 'refs/house/received:library/a.md')).toBe('a, from House\n');
  expect(git(room.repository, 'rev-parse', 'HEAD').trim()).toBe(local);
  expect(await readFile(join(room.repository, 'library/a.md'), 'utf8')).toBe('a, local\n');
  expect(await readFile(join(room.repository, 'library/draft.md'), 'utf8')).toBe('draft\n');
});

it('reads the Room whole again when House no longer holds the copy position', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('library/a.md', 'a\n');
  await rooms.select([room]);

  room.put('library/a.md', 'a, much later\n');
  rooms.expired.add(room.ref);
  await deliveredTo(hosted, room);

  expect(git(room.repository, 'show', 'refs/house/received:library/a.md')).toBe('a, much later\n');
  expect(hosted.house.requests.filter((request) => request.path === '/kit/door/bootstrap')).toHaveLength(2);
});

it('reads a bundle House hands over through a transfer address', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('library/a.md', 'a\n');
  hosted.house.route('POST', '/kit/door/bootstrap', () => ({
    body: { transfer: { act: 'working_copy_bundle', method: 'GET', url: `${hosted.house.origin}/files/bundle-1` } },
  }));
  hosted.house.route('GET', '/files/:grant', () => ({ body: { scopes: [room.bundle()] } }));

  await rooms.select([room]);

  expect(tracked(room)).toEqual(['library/a.md']);
});

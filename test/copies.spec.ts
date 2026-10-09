import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { HouseRefusal, type House } from '../src/api.ts';
import { LocalCopies } from '../src/copies.ts';
import { until } from './double.ts';
import { hostKit, type Hosted } from './environment.ts';
import { temporaryHome } from './kit.ts';
import { commitAll, git, house, serveRooms, type Room } from './rooms.ts';

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
  room.put('plan.md', 'plan\n');

  hosted.socket.send({ type: 'work_available', subject: 'local_copy' });

  await until(() => hosted.house.requests.filter((request) => request.path === '/kit/local-copy/selection').length >= 2);
  expect(hosted.house.requests.filter((request) => request.path.startsWith('/kit/door/'))).toEqual([]);
  expect(existsSync(room.repository)).toBe(false);
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

it('delivers House changes to the House ref and read-only content and leaves the branch, the index and working files alone', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  room.put('b.md', 'b\n');
  room.put('capture/mail/one.md', 'one\n');
  await rooms.select([room]);
  await writeFile(join(room.repository, 'a.md'), 'a, committed locally\n');
  const local = commitAll(room.repository, 'local work');
  await writeFile(join(room.repository, 'b.md'), 'b, staged\n');
  git(room.repository, 'add', 'b.md');
  await writeFile(join(room.repository, 'b.md'), 'b, unstaged\n');
  const status = git(room.repository, 'status', '--porcelain');

  room.put('a.md', 'a, from House\n');
  room.put('c.md', 'c, new in House\n');
  room.put('capture/mail/two.md', 'two\n');
  room.remove('capture/mail/one.md');
  await deliveredTo(hosted, room);

  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a, from House\n');
  expect(git(room.repository, 'show', 'refs/house/received:c.md')).toBe('c, new in House\n');
  expect(git(room.repository, 'rev-parse', 'main').trim()).toBe(local);
  expect(git(room.repository, 'status', '--porcelain')).toBe(status);
  expect(await readFile(join(room.repository, 'a.md'), 'utf8')).toBe('a, committed locally\n');
  expect(git(room.repository, 'show', ':b.md')).toBe('b, staged\n');
  expect(existsSync(join(room.repository, 'c.md'))).toBe(false);
  expect(await readFile(join(room.repository, 'capture/mail/two.md'), 'utf8')).toBe('two\n');
  expect(existsSync(join(room.repository, 'capture/mail/one.md'))).toBe(false);
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
  await until(async () => (await readFile(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`), 'utf8')).includes('renamed-notes'));
  expect(existsSync(room.repository)).toBe(true);

  await writeFile(join(room.repository, 'a.md'), 'a, local\n');
  const local = commitAll(room.repository, 'local');
  await writeFile(join(room.repository, 'draft.md'), 'draft\n');
  const deselected = hosted.house.requests.length;
  rooms.selection = { rooms: [] };
  hosted.socket.send({ type: 'work_available', subject: 'local_copy' });
  await until(async () => (await readFile(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`), 'utf8')).includes('"active":false'));
  room.put('a.md', 'a, from House\n');
  hosted.socket.send({ type: 'entries', authority: room.ref, position: String(room.position), log_epoch: room.logEpoch, entries: [] });
  // Three tenths of a second outlast the Kit taking an entries frame, so a read it has not made by then is not coming.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(hosted.house.requests.slice(deselected).filter((request) => request.path.startsWith('/kit/door/'))).toEqual([]);
  expect(git(room.repository, 'rev-parse', 'HEAD').trim()).toBe(local);
  expect(await readFile(join(room.repository, 'draft.md'), 'utf8')).toBe('draft\n');
  expect(await house(hosted, room.repository, 'push', '--owner')).toMatchObject({
    status: 1,
    stderr: 'house: /rooms/renamed-notes is no longer synced to this Environment, so House takes no push from it\n',
  });

  const before = received(room);
  await rooms.select([room]);
  await until(() => received(room) !== before);
  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a, from House\n');
  expect(git(room.repository, 'rev-parse', 'HEAD').trim()).toBe(local);
  expect(await readFile(join(room.repository, 'a.md'), 'utf8')).toBe('a, local\n');
  expect(await readFile(join(room.repository, 'draft.md'), 'utf8')).toBe('draft\n');
});

it('reads the Room whole again when House no longer holds the copy position', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  await rooms.select([room]);

  room.put('a.md', 'a, much later\n');
  rooms.expired.add(room.ref);
  await deliveredTo(hosted, room);

  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a, much later\n');
  expect(hosted.house.requests.filter((request) => request.path === '/kit/door/bootstrap')).toHaveLength(2);
});

it('does not ask House again on a timer after its replica is behind the copy position', async () => {
  const home = await temporaryHome();
  const previousHome = process.env.HOUSE_KIT_HOME;
  process.env.HOUSE_KIT_HOME = home;
  vi.useFakeTimers();
  try {
    const key = 'rooms/r_replica.x';
    const roomRef = 'r_replica.x';
    const logEpoch = '0192f0e4-1c2d-7000-8000-000000000001';
    await mkdir(join(home, 'local-copies', 'rooms'), { recursive: true });
    await writeFile(
      join(home, 'local-copies', 'rooms', `${roomRef}.json`),
      JSON.stringify({
        key,
        room_ref: roomRef,
        room_handle: 'notes',
        repository: '/unused',
        active: true,
        house: 'commit',
        position: '1',
        log_epoch: logEpoch,
        write: [''],
        protected: [],
        read_only: [],
        manifests: { commit: { parent: null, files: {} } },
        moves: [],
      }),
    );
    let enumerations = 0;
    const house: House = {
      post: async () => {
        enumerations++;
        throw new HouseRefusal('/kit/door/enumerate', 409, '{"error":{"code":"replica_behind"}}');
      },
      deliver: async () => {
        throw new Error('unexpected delivery');
      },
    };
    const copies = new LocalCopies(house);
    await copies.load();

    copies.entries({ authority: roomRef, position: '2', log_epoch: logEpoch });
    const queues = (copies as unknown as { queues: Map<string, Promise<unknown>> }).queues;
    const first = queues.get(key);
    expect(first).toBeDefined();
    await first;
    expect(enumerations).toBe(1);

    // Thirty seconds is the removed replica-behind retry deadline, so advancing through it proves the 409 schedules no retry.
    await vi.advanceTimersByTimeAsync(30_000);
    await queues.get(key);
    expect(enumerations).toBe(1);
  } finally {
    vi.useRealTimers();
    if (previousHome === undefined) delete process.env.HOUSE_KIT_HOME;
    else process.env.HOUSE_KIT_HOME = previousHome;
  }
});

it('asks a replica behind the copy position once and catches the copy up at the next entries frame', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('a.md', 'a\n');
  await rooms.select([room]);
  const enumerations = () => hosted.house.requests.filter((request) => request.path === '/kit/door/enumerate');
  const before = received(room);

  room.put('a.md', 'a, from House\n');
  rooms.behind.add(room.ref);
  hosted.socket.send({ type: 'entries', authority: room.ref, position: String(room.position), log_epoch: room.logEpoch, entries: [] });
  await until(() => enumerations()[0]);
  expect(enumerations()).toHaveLength(1);
  expect(received(room)).toBe(before);

  rooms.behind.delete(room.ref);
  await deliveredTo(hosted, room);
  expect(git(room.repository, 'show', 'refs/house/received:a.md')).toBe('a, from House\n');
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

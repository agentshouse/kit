import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hostKit, type Hosted } from './environment.ts';
import { digest, house, manifestOf, serveRooms, upload, type Room, type Rooms } from './rooms.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

function batches(hosted: Hosted): { operation_id: string; changes: Record<string, unknown>[] }[] {
  return hosted.house.requests
    .filter((request) => request.path === '/kit/door/update')
    .map((request) => request.body as { operation_id: string; changes: Record<string, unknown>[] });
}

async function copied(setup: (room: Room) => void = () => {}): Promise<{ hosted: Hosted; rooms: Rooms; room: Room }> {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('plan.md', 'one\ntwo\nthree\n');
  room.put('old.md', 'old\n');
  setup(room);
  expect(await rooms.download([room])).toMatchObject({ status: 0 });
  return { hosted, rooms, room };
}

it('uploads an edit, a new file and a deletion found by hash with the revisions the manifest holds, and an absent skipped attachment uploads nothing', async () => {
  const { hosted, room } = await copied((room) => room.upload('cover.jpg', JPEG));
  const [plan, old] = [room.revision('plan.md'), room.revision('old.md')];
  expect((await readdir(room.repository)).sort()).toEqual(['.house', 'old.md', 'plan.md']);
  expect((await manifestOf(room)).files['cover.jpg']).toEqual({ revision: room.revision('cover.jpg'), sha256: digest(JPEG), bytes: JPEG.length, skipped: true });
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\nthree\nfour\n');
  await writeFile(join(room.repository, 'new.md'), 'new\n');
  await rm(join(room.repository, 'old.md'));

  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 3 files of /rooms/notes.\n', stderr: '' });

  expect(batches(hosted).map((batch) => batch.changes)).toEqual([
    [
      { op: 'write', path: '/rooms/notes/new.md', content: 'new\n' },
      { op: 'delete', path: '/rooms/notes/old.md', base: old },
      { op: 'write', path: '/rooms/notes/plan.md', content: 'one\ntwo\nthree\nfour\n', base: plan },
    ],
  ]);
  expect([...room.files.keys()].sort()).toEqual(['new.md', 'plan.md']);
  expect(room.binaries.has('cover.jpg')).toBe(true);
  const { files } = await manifestOf(room);
  expect(files['plan.md']).toEqual({ revision: room.revision('plan.md'), sha256: digest('one\ntwo\nthree\nfour\n'), bytes: 19 });
  expect(files['new.md']).toEqual({ revision: room.revision('new.md'), sha256: digest('new\n'), bytes: 4 });
  expect(files['old.md']).toBeUndefined();
  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'Nothing to upload: /rooms/notes matches House.\n', stderr: '' });
  expect(batches(hosted)).toHaveLength(1);
});

it("sends nothing of an AGENTS.md or a claude.md at the copy's top, whatever their case, and uploads the rest of the copy", async () => {
  const { hosted, room } = await copied();
  const plan = room.revision('plan.md');
  await writeFile(join(room.repository, 'AGENTS.md'), 'what an Agent follows here\n');
  await writeFile(join(room.repository, 'claude.md'), '@AGENTS.md\n');
  await mkdir(join(room.repository, 'docs'));
  await writeFile(join(room.repository, 'docs', 'AGENTS.md'), 'a document\n');
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\nthree\nfour\n');

  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 2 files of /rooms/notes.\n', stderr: '' });

  expect(batches(hosted).map((batch) => batch.changes)).toEqual([
    [
      { op: 'write', path: '/rooms/notes/docs/AGENTS.md', content: 'a document\n' },
      { op: 'write', path: '/rooms/notes/plan.md', content: 'one\ntwo\nthree\nfour\n', base: plan },
    ],
  ]);
  expect([...room.files.keys()].sort()).toEqual(['docs/AGENTS.md', 'old.md', 'plan.md']);
  expect(Object.keys((await manifestOf(room)).files).sort()).toEqual(['docs/AGENTS.md', 'old.md', 'plan.md']);
  await rm(join(room.repository, 'claude.md'));
  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'Nothing to upload: /rooms/notes matches House.\n', stderr: '' });
  expect(await readFile(join(room.repository, 'AGENTS.md'), 'utf8')).toBe('what an Agent follows here\n');
});

it('writes the text House merged with a newer change into the working file and its manifest entry', async () => {
  const { hosted, room } = await copied();
  const base = room.revision('plan.md');
  room.put('plan.md', 'ONE\ntwo\nthree\n');
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\nTHREE\n');

  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });

  expect(batches(hosted)[0]!.changes).toEqual([{ op: 'write', path: '/rooms/notes/plan.md', content: 'one\ntwo\nTHREE\n', base }]);
  expect(room.files.get('plan.md')!.content).toBe('ONE\ntwo\nTHREE\n');
  expect(await readFile(join(room.repository, 'plan.md'), 'utf8')).toBe('ONE\ntwo\nTHREE\n');
  expect((await manifestOf(room)).files['plan.md']).toEqual({ revision: room.revision('plan.md'), sha256: digest('ONE\ntwo\nTHREE\n'), bytes: 14 });
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'Nothing to upload: /rooms/notes matches House.\n' });
});

it('writes a merged text that ends like the cut notice House no longer writes as House answered it, reading no revision of it', async () => {
  const notice = '\noutput_cut 1 of 2 bytes';
  const { hosted, room } = await copied((held) => held.put('plan.md', `one\ntwo\nthree\nfour${notice}`));
  room.put('plan.md', `ONE\ntwo\nthree\nfour${notice}`);
  await writeFile(join(room.repository, 'plan.md'), `one\ntwo\nthree\nFOUR${notice}`);
  const before = hosted.house.requests.length;

  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });

  expect(await readFile(join(room.repository, 'plan.md'), 'utf8')).toBe(`ONE\ntwo\nthree\nFOUR${notice}`);
  expect(hosted.house.requests.slice(before).map((received) => received.path)).not.toContain('/kit/door/files/revisions/list');
});

it('writes the conflict markers House answers, refuses the next upload naming the file while a marker remains, and uploads the resolution on the current revision', async () => {
  const { hosted, room } = await copied();
  room.put('plan.md', 'one\nTWO, theirs\nthree\n');
  const current = room.revision('plan.md');
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo, mine\nthree\n');
  await writeFile(join(room.repository, 'other.md'), 'other\n');
  const marked = 'one\n<<<<<<< current\nTWO, theirs\n=======\ntwo, mine\n>>>>>>> yours\nthree\n';

  const refused = await upload(hosted, room);

  expect(refused.status).toBe(1);
  expect(refused.stderr).toMatch(/^house: edit_conflict: nothing was written/);
  expect(refused.stderr).toContain('code: merge_conflict');
  expect(refused.stderr.endsWith('/rooms/notes/plan.md: conflict markers written; resolve them, then run house upload again\n')).toBe(true);
  expect(await readFile(join(room.repository, 'plan.md'), 'utf8')).toBe(marked);
  expect((await manifestOf(room)).files['plan.md']).toEqual({ revision: current, sha256: digest(marked), bytes: Buffer.byteLength(marked), conflicted: true });
  expect(room.files.has('other.md')).toBe(false);

  expect(await upload(hosted, room)).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: /rooms/notes/plan.md still holds conflict markers; resolve it, then run house upload again\n',
  });
  expect(batches(hosted)).toHaveLength(1);

  await writeFile(join(room.repository, 'plan.md'), 'one\nTWO, both\nthree\n');
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 2 files of /rooms/notes.\n' });
  expect(batches(hosted)[1]!.changes).toEqual([
    { op: 'write', path: '/rooms/notes/other.md', content: 'other\n' },
    { op: 'write', path: '/rooms/notes/plan.md', content: 'one\nTWO, both\nthree\n', base: current },
  ]);
  expect(room.files.get('plan.md')!.content).toBe('one\nTWO, both\nthree\n');
  expect((await manifestOf(room)).files['plan.md']!.conflicted).toBeUndefined();
});

it('uploads a renamed file holding the same bytes as one move, and brings the links House rewrote into the working files', async () => {
  const { hosted, room } = await copied((room) => {
    room.put('a.md', 'Alpha\n');
    room.put('index.md', 'See [alpha](a.md).\n');
  });
  const alpha = room.revision('a.md');
  await rename(join(room.repository, 'a.md'), join(room.repository, 'b.md'));

  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });

  expect(batches(hosted)[0]!.changes).toEqual([{ op: 'move', path: '/rooms/notes/a.md', to: '/rooms/notes/b.md', base: alpha }]);
  expect(room.files.get('b.md')!.revision).toBe(alpha);
  expect(await readFile(join(room.repository, 'index.md'), 'utf8')).toBe('See [alpha](b.md).\n');
  expect((await manifestOf(room)).files['index.md']!.revision).toBe(room.revision('index.md'));
  expect(await upload(hosted, room)).toMatchObject({ stdout: 'Nothing to upload: /rooms/notes matches House.\n' });
});

it('uploads a change past one batch as consecutive whole batches in path order and counts them', async () => {
  const { hosted, room } = await copied();
  const names = Array.from({ length: 1001 }, (_, index) => `n${String(index).padStart(4, '0')}.md`);
  await mkdir(join(room.repository, 'many'));
  for (const name of names) await writeFile(join(room.repository, 'many', name), `${name}\n`);

  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1001 files of /rooms/notes in 2 batches.\n' });

  const sent = batches(hosted).map((batch) => batch.changes.map((change) => change.path));
  expect(sent.map((paths) => paths.length)).toEqual([1000, 1]);
  expect(sent.flat()).toEqual(names.map((name) => `/rooms/notes/many/${name}`));
  expect(new Set(batches(hosted).map((batch) => batch.operation_id)).size).toBe(2);
  expect(room.batches).toHaveLength(2);
});

it('keeps a batch whose answer did not arrive and sends it first, unchanged under its operation, on the next upload', async () => {
  const { hosted, rooms, room } = await copied();
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\nthree\nfour\n');
  rooms.dropping = 1;

  expect(await upload(hosted, room)).toEqual({
    status: 1,
    stdout: '',
    stderr: "house: House's answer to this upload did not arrive; run house upload again\n",
  });
  expect(room.batches).toHaveLength(1);
  await writeFile(join(room.repository, 'later.md'), 'later\n');

  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 2 files of /rooms/notes in 2 batches.\n' });

  const [lost, again, newer] = batches(hosted);
  expect(again).toEqual(lost);
  expect(newer!.changes).toEqual([{ op: 'write', path: '/rooms/notes/later.md', content: 'later\n' }]);
  expect(newer!.operation_id).not.toBe(lost!.operation_id);
  expect(room.batches).toHaveLength(2);
  expect((await manifestOf(room)).files['plan.md']!.revision).toBe(room.revision('plan.md'));
});

it('keeps the bytes of a file changed while it uploaded and its former entry, says its local integration is pending, and the next upload merges it', async () => {
  const lines = (...changed: string[]) => Array.from({ length: 9 }, (_, index) => (changed.includes(`l${index + 1}`) ? `L${index + 1}` : `l${index + 1}`)).map((line) => `${line}\n`).join('');
  const { hosted, rooms, room } = await copied((room) => room.put('long.md', lines()));
  const base = room.revision('long.md');
  room.put('long.md', lines('l1'));
  await writeFile(join(room.repository, 'long.md'), lines('l5'));
  rooms.beforeEdit = () => {
    rooms.beforeEdit = null;
    writeFileSync(join(room.repository, 'long.md'), lines('l5', 'l9'));
  };

  expect(await upload(hosted, room)).toMatchObject({
    status: 0,
    stdout:
      'House accepted 1 file of /rooms/notes.\n/rooms/notes/long.md: changed while it uploaded; House accepted it and local integration is pending, so the next house upload merges it\n',
  });

  expect(room.files.get('long.md')!.content).toBe(lines('l1', 'l5'));
  expect(await readFile(join(room.repository, 'long.md'), 'utf8')).toBe(lines('l5', 'l9'));
  expect((await manifestOf(room)).files['long.md']!.revision).toBe(base);
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(batches(hosted)[1]!.changes).toEqual([{ op: 'write', path: '/rooms/notes/long.md', content: lines('l5', 'l9'), base }]);
  expect(room.files.get('long.md')!.content).toBe(lines('l1', 'l5', 'l9'));
  expect(await readFile(join(room.repository, 'long.md'), 'utf8')).toBe(lines('l1', 'l5', 'l9'));
});

it('sends an upload a handle rename met between building and sending once more under the handle House names, and it lands once', async () => {
  const { hosted, rooms, room } = await copied();
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo\nthree\nfour\n');
  rooms.beforeEdit = () => {
    rooms.beforeEdit = null;
    room.rehandle('renamed');
  };

  expect(await upload(hosted, room)).toEqual({ status: 0, stdout: 'House accepted 1 file of /rooms/renamed.\n', stderr: '' });

  const [first, second] = batches(hosted);
  expect(first!.changes.map((change) => change.path)).toEqual(['/rooms/notes/plan.md']);
  expect(second).toEqual({ ...first, changes: [{ ...first!.changes[0], path: '/rooms/renamed/plan.md' }] });
  expect(room.batches).toHaveLength(1);
  expect(room.files.get('plan.md')!.content).toBe('one\ntwo\nthree\nfour\n');
  expect(JSON.parse(await readFile(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`), 'utf8'))).toMatchObject({ room_handle: 'renamed' });
});

it("carries any file name through the copy, reads a decomposed form of a held name as the same file, and passes House's refusal of a second case of a held name", async () => {
  const names = ['Meeting notes.md', 'Отчёт.md', 'a "b".md', '100%.md', ' lead.md', 'Café.md'];
  const { hosted, rooms, room } = await copied((room) => {
    for (const name of names) room.put(`Old notes/${name}`, `${name}\n`);
    room.put('README.md', 'Read me\n');
  });
  expect(await Promise.all(names.map((name) => readFile(join(room.repository, 'Old notes', name), 'utf8')))).toEqual(names.map((name) => `${name}\n`));
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'Nothing to upload: /rooms/notes matches House.\n' });
  await rename(join(room.repository, 'Old notes', 'Café.md'), join(room.repository, 'Old notes', 'Café.md'));
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'Nothing to upload: /rooms/notes matches House.\n' });

  await mkdir(join(room.repository, 'New notes'));
  for (const name of names) {
    await writeFile(join(room.repository, 'Old notes', name === 'Caf\u00e9.md' ? 'Cafe\u0301.md' : name), `${name}\nedited\n`);
    await writeFile(join(room.repository, 'New notes', name), `new ${name}\n`);
  }
  await rm(join(room.repository, 'Old notes', 'Café.md'), { force: true });

  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 12 files of /rooms/notes.\n' });

  expect(names.map((name) => room.files.get(`New notes/${name}`)?.content)).toEqual(names.map((name) => `new ${name}\n`));
  expect(names.map((name) => room.files.get(`Old notes/${name}`)?.content)).toEqual(names.map((name) => `${name}\nedited\n`));
  expect(batches(hosted)[0]!.changes.every((change) => change.op === 'write')).toBe(true);
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'Nothing to upload: /rooms/notes matches House.\n' });
  expect(await rooms.download([room])).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });

  await writeFile(join(room.repository, 'Readme.md'), 'Read me too\n');
  expect(await upload(hosted, room)).toEqual({
    status: 1,
    stdout: '',
    stderr:
      'house: invalid_authored_path: /rooms/notes/Readme.md differs from /rooms/notes/README.md only in letter case, and a folder holds one name in any case; write to /rooms/notes/README.md or choose another name\n',
  });
  expect([...room.files.keys()].filter((path) => path.toLowerCase() === 'readme.md')).toEqual(['README.md']);
  expect(existsSync(join(room.repository, 'Readme.md'))).toBe(true);
});

it("uploads outside a conversation as the Environment's own upload with house upload alone, only inside a Local copy, takes no --owner, and explains itself", async () => {
  const { hosted, room } = await copied();
  await writeFile(join(room.repository, 'plan.md'), 'changed\n');

  expect(await house(hosted, room.repository, 'upload', '--owner')).toMatchObject({
    status: 1,
    stdout: '',
    stderr: expect.stringMatching(/^house: unexpected argument --owner; usage: house upload, /),
  });
  expect(await house(hosted, '/', 'upload')).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: / is not in a House Local copy; run house upload inside one\n',
  });
  for (const verb of ['push', 'fetch']) {
    const old = await house(hosted, room.repository, verb, '--owner');
    expect(old.status).toBe(1);
  }
  expect(batches(hosted)).toEqual([]);
  expect(await house(hosted, join(room.repository), 'upload')).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(hosted.house.requests.filter((received) => received.path === '/kit/door/update').map((received) => received.headers.authorization)).toEqual(['Bearer ahk_held']);
});

it("brings House's newer version back where a stale deletion removed it, says what House holds, and deletes nothing it never read", async () => {
  const { hosted, room } = await copied();
  const theirs = room.put('old.md', 'old, theirs\n');
  await rm(join(room.repository, 'old.md'));

  const refused = await upload(hosted, room);

  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('code: base_revision_stale');
  expect(refused.stderr.endsWith(`/rooms/notes/old.md: House changed it since this copy read it and now holds ${theirs}; that version is back here, so delete it again if you still mean to\n`)).toBe(true);
  expect(await readFile(join(room.repository, 'old.md'), 'utf8')).toBe('old, theirs\n');
  expect((await manifestOf(room)).files['old.md']).toEqual({ revision: theirs, sha256: digest('old, theirs\n'), bytes: 12 });
  expect(room.files.get('old.md')!.content).toBe('old, theirs\n');
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'Nothing to upload: /rooms/notes matches House.\n' });

  await rm(join(room.repository, 'old.md'));
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(batches(hosted).at(-1)!.changes).toEqual([{ op: 'delete', path: '/rooms/notes/old.md', base: theirs }]);
  expect(room.files.has('old.md')).toBe(false);
});

it("puts a file a stale move took away back at its path with House's newer version, says what House holds, and moves nothing it never read", async () => {
  const { hosted, room } = await copied((room) => room.put('a.md', 'Alpha\n'));
  const theirs = room.put('a.md', 'Alpha, theirs\n');
  await rename(join(room.repository, 'a.md'), join(room.repository, 'b.md'));

  const refused = await upload(hosted, room);

  expect(refused.status).toBe(1);
  expect(refused.stderr.endsWith(`/rooms/notes/a.md: House changed it since this copy read it and now holds ${theirs}; it is back at /rooms/notes/a.md with that version, so move it again if you still mean to\n`)).toBe(true);
  expect(await readFile(join(room.repository, 'a.md'), 'utf8')).toBe('Alpha, theirs\n');
  expect(existsSync(join(room.repository, 'b.md'))).toBe(false);
  expect((await manifestOf(room)).files['a.md']).toEqual({ revision: theirs, sha256: digest('Alpha, theirs\n'), bytes: 14 });
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'Nothing to upload: /rooms/notes matches House.\n' });

  await rename(join(room.repository, 'a.md'), join(room.repository, 'b.md'));
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(batches(hosted).at(-1)!.changes).toEqual([{ op: 'move', path: '/rooms/notes/a.md', to: '/rooms/notes/b.md', base: theirs }]);
  expect(room.files.get('b.md')!.content).toBe('Alpha, theirs\n');
});

it.each([
  ['leaving it out', 'omit'],
  ['cutting it with cut beside it', 'cut'],
] as const)("marks the whole text against House's current one when House cuts the merged text of a conflict by %s, and refuses the next upload until it is resolved", async (_way, conflictText) => {
  const { hosted, room } = await copied();
  room.bound = 16;
  room.conflictText = conflictText;
  const current = room.put('plan.md', 'one\nTWO, theirs\nthree\n');
  await writeFile(join(room.repository, 'plan.md'), 'one\ntwo, mine\nthree\n');
  const marked = '<<<<<<< current\none\nTWO, theirs\nthree\n=======\none\ntwo, mine\nthree\n>>>>>>> yours\n';

  const refused = await upload(hosted, room);

  expect(refused.status).toBe(1);
  expect(refused.stderr.endsWith('/rooms/notes/plan.md: conflict markers written; resolve them, then run house upload again\n')).toBe(true);
  expect(await readFile(join(room.repository, 'plan.md'), 'utf8')).toBe(marked);
  expect((await manifestOf(room)).files['plan.md']).toEqual({ revision: current, sha256: digest(marked), bytes: Buffer.byteLength(marked), conflicted: true });
  expect((await upload(hosted, room)).stderr).toBe('house: /rooms/notes/plan.md still holds conflict markers; resolve it, then run house upload again\n');

  await writeFile(join(room.repository, 'plan.md'), 'one\nTWO, both\nthree\n');
  expect(await upload(hosted, room)).toMatchObject({ status: 0, stdout: 'House accepted 1 file of /rooms/notes.\n' });
  expect(batches(hosted).at(-1)!.changes).toEqual([{ op: 'write', path: '/rooms/notes/plan.md', content: 'one\nTWO, both\nthree\n', base: current }]);
  expect(room.files.get('plan.md')!.content).toBe('one\nTWO, both\nthree\n');
});

it('refuses an upload while a file it marked under a decomposed name still holds a marker line, naming it as House does', async () => {
  const { hosted, room } = await copied((room) => room.put('Café.md', 'one\ntwo\nthree\nfour\nfive\n'));
  await rename(join(room.repository, 'Café.md'), join(room.repository, 'Café.md'));
  room.put('Café.md', 'one\nTWO, theirs\nthree\nfour\nfive\n');
  await writeFile(join(room.repository, 'Café.md'), 'one\ntwo, mine\nthree\nfour\nfive\n');

  expect((await upload(hosted, room)).status).toBe(1);
  const marked = await readFile(join(room.repository, 'Café.md'), 'utf8');
  expect(marked).toContain('<<<<<<< current\n');
  await writeFile(join(room.repository, 'Café.md'), marked.replace('five\n', 'FIVE\n'));

  expect(await upload(hosted, room)).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: /rooms/notes/Café.md still holds conflict markers; resolve it, then run house upload again\n',
  });
  expect(batches(hosted)).toHaveLength(1);
  expect(room.files.get('Café.md')!.content).toBe('one\nTWO, theirs\nthree\nfour\nfive\n');
});

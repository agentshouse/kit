import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { GIT_IDENTITY, hostKit, lastCall, type Hosted } from './environment.ts';
import { filesUnder } from './kit.ts';
import { house, manifestOf, serveRooms, upload, type Room, type Rooms } from './rooms.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const OTHER_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 2]);

function git(cwd: string, ...args: string[]): void {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY } });
  if (ran.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${ran.stderr}`);
}

function leftOut(folder: string): string {
  return `/rooms/notes/${folder}: not uploaded, as it holds a Git work tree`;
}

function batches(hosted: Hosted): Record<string, unknown>[][] {
  return hosted.house.requests
    .filter((request) => request.path === '/kit/door/update')
    .map((request) => (request.body as { changes: Record<string, unknown>[] }).changes);
}

async function tree(folder: string): Promise<Record<string, string>> {
  const files = (await filesUnder(folder)).sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [relative(folder, file), (await readFile(file)).toString('base64')] as const)));
}

async function paths(folder: string): Promise<string[]> {
  return Object.keys((JSON.parse(await readFile(join(folder, '.house'), 'utf8')) as { files: Record<string, unknown> }).files).sort();
}

async function staged(): Promise<{ hosted: Hosted; rooms: Rooms; notes: Room }> {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\n');
  notes.put('plan.md', 'Plant beans\n');
  expect(await rooms.download([notes])).toMatchObject({ status: 0 });
  return { hosted, rooms, notes };
}

async function cloned(folder: string): Promise<void> {
  const app = join(folder, 'app');
  await mkdir(app);
  git(app, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(app, 'README.md'), 'the app\n');
  await writeFile(join(app, 'logo.jpg'), JPEG);
  git(app, 'add', '.');
  git(app, 'commit', '--quiet', '-m', 'one');
  git(app, 'worktree', 'add', '--quiet', '-b', 'site', join(folder, 'docs', 'site'));
  await writeFile(join(folder, 'docs', 'site', 'draft.md'), 'not yet\n');
}

async function leavesBoth(hosted: Hosted, notes: Room, folder: string): Promise<void> {
  await cloned(folder);
  const app = await tree(join(folder, 'app'));
  const site = await tree(join(folder, 'docs', 'site'));
  const plan = notes.revision('plan.md');
  await writeFile(join(folder, 'plan.md'), 'Plant beans and corn\n');
  await writeFile(join(folder, 'new.md'), 'new\n');

  expect(await house(hosted, join(folder, 'app'), 'upload')).toEqual({
    status: 0,
    stdout: ['House accepted 2 files of /rooms/notes.', leftOut('app'), leftOut('docs/site'), ''].join('\n'),
    stderr: '',
  });

  expect(batches(hosted)).toEqual([
    [
      { op: 'write', path: '/rooms/notes/new.md', content: 'new\n' },
      { op: 'write', path: '/rooms/notes/plan.md', content: 'Plant beans and corn\n', base: plan },
    ],
  ]);
  expect([...notes.files.keys()].sort()).toEqual(['a.md', 'new.md', 'plan.md']);
  expect(notes.binaries.size).toBe(0);
  expect(await paths(folder)).toEqual(['a.md', 'new.md', 'plan.md']);

  notes.put('a.md', 'one\ntwo\n');
  notes.put('app/README.md', "House's app\n");
  notes.upload('app/logo.jpg', OTHER_JPEG);
  notes.put('docs/site/draft.md', "House's draft\n", 'House wrote this\n');

  expect(await house(hosted, folder, 'download', '--with-attachments')).toMatchObject({ status: 0, stderr: '' });

  expect(await readFile(join(folder, 'a.md'), 'utf8')).toBe('one\ntwo\n');
  expect(await tree(join(folder, 'app'))).toEqual(app);
  expect(await tree(join(folder, 'docs', 'site'))).toEqual(site);
  expect(await paths(folder)).toEqual(['a.md', 'new.md', 'plan.md']);
  expect(await house(hosted, folder, 'upload')).toEqual({
    status: 0,
    stdout: ['Nothing to upload: /rooms/notes matches House.', leftOut('app'), leftOut('docs/site'), ''].join('\n'),
    stderr: '',
  });
  expect(batches(hosted)).toHaveLength(1);
}

it("uploads a conversation's copy holding a clone with a .git folder and its worktree with a .git file without either, naming each, records nothing of them, leaves them as they were at a download and keeps the copy at the conversation's deletion", async () => {
  const { hosted, notes } = await staged();
  hosted.call({ kind: 'open', conversation_id: 'conversation-1', agent_id: 'agent-1', room_ref: notes.ref, name: 'Plan' });
  expect(await hosted.result(lastCall())).toMatchObject({ provider_session_id: expect.any(String) });
  const copy = join(hosted.workspace, 'conversations', 'notes', 'Plan');

  await leavesBoth(hosted, notes, copy);

  hosted.call({ kind: 'kill', conversation_id: 'conversation-1', agent_id: 'agent-1', deleted: true });
  expect(await hosted.result(lastCall())).toEqual({ kept: [{ room_ref: notes.ref, path: copy }] });
  expect(await readFile(join(copy, 'app', 'README.md'), 'utf8')).toBe('the app\n');
});

it("uploads a Room's folder holding a clone with a .git folder and its worktree with a .git file without either, naming each, records nothing of them and leaves them as they were at a download", async () => {
  const { hosted, notes } = await staged();

  await leavesBoth(hosted, notes, notes.repository);
});

it("keeps in the Room the files a folder held before it gained a .git: an upload sends nothing of them, their manifest entries stay, and a download, with its attachments too, and a house update there write and remove nothing in the folder", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('plan.md', 'Plant beans\n');
  for (const name of ['one', 'two', 'three', 'four']) notes.put(`code/${name}.md`, `${name}\n`);
  notes.upload('code/cover.jpg', JPEG);
  expect(await rooms.download([notes])).toMatchObject({ status: 0 });
  const code = join(notes.repository, 'code');
  const held = (await manifestOf(notes)).files;
  const entries = Object.fromEntries(Object.entries(held).filter(([path]) => path.startsWith('code/')));
  expect(Object.keys(entries).sort()).toEqual(['code/cover.jpg', 'code/four.md', 'code/one.md', 'code/three.md', 'code/two.md']);
  git(code, 'init', '--quiet', '--initial-branch=main');
  await rm(join(code, 'one.md'));
  await writeFile(join(code, 'two.md'), 'two, mine\n');
  await writeFile(join(notes.repository, 'plan.md'), 'Plant corn\n');
  const plan = notes.revision('plan.md');

  expect(await upload(hosted, notes)).toEqual({ status: 0, stdout: ['House accepted 1 file of /rooms/notes.', leftOut('code'), ''].join('\n'), stderr: '' });

  expect(batches(hosted)).toEqual([[{ op: 'write', path: '/rooms/notes/plan.md', content: 'Plant corn\n', base: plan }]]);
  expect([...notes.files.keys()].sort()).toEqual(['code/four.md', 'code/one.md', 'code/three.md', 'code/two.md', 'plan.md']);
  expect(notes.binaries.has('code/cover.jpg')).toBe(true);
  const kept = (await manifestOf(notes)).files;
  expect(Object.fromEntries(Object.entries(kept).filter(([path]) => path.startsWith('code/')))).toEqual(entries);

  const before = await tree(code);
  notes.put('code/three.md', 'three, House\n');
  notes.put('code/five.md', 'five\n');
  notes.upload('code/cover.jpg', OTHER_JPEG);
  notes.remove('code/four.md');

  expect(await rooms.download([notes], '--with-attachments')).toMatchObject({ status: 0, stderr: '' });

  expect(await tree(code)).toEqual(before);
  const downloaded = (await manifestOf(notes)).files;
  expect(Object.fromEntries(Object.entries(downloaded).filter(([path]) => path.startsWith('code/')))).toEqual(entries);

  const updated = await house(hosted, notes.repository, 'update', JSON.stringify({ changes: [{ op: 'write', path: '/rooms/notes/code/three.md', content: 'three, updated\n', base: notes.revision('code/three.md') }] }));

  expect(updated).toMatchObject({ status: 0, stderr: '' });
  expect(notes.files.get('code/three.md')!.content).toBe('three, updated\n');
  expect(await tree(code)).toEqual(before);
  expect((await manifestOf(notes)).files['code/three.md']).toEqual(entries['code/three.md']);
  expect(await upload(hosted, notes)).toEqual({ status: 0, stdout: ['Nothing to upload: /rooms/notes matches House.', leftOut('code'), ''].join('\n'), stderr: '' });
});

it("leaves a held attachment under a folder that gained a .git, its file and its entry, as they were when another writer changes it, downloading nothing", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('plan.md', 'Plant beans\n');
  notes.upload('code/logo.jpg', JPEG);
  expect(await rooms.download([notes], '--with-attachments')).toMatchObject({ status: 0 });
  const held = (await manifestOf(notes)).files['code/logo.jpg'];
  git(join(notes.repository, 'code'), 'init', '--quiet', '--initial-branch=main');
  notes.upload('code/logo.jpg', OTHER_JPEG);
  const fetched = hosted.store.requests.length;

  expect(await rooms.download([notes])).toMatchObject({ status: 0, stderr: '' });

  expect(await readFile(join(notes.repository, 'code/logo.jpg'))).toEqual(JPEG);
  expect((await manifestOf(notes)).files['code/logo.jpg']).toEqual(held);
  expect(hosted.store.requests.slice(fetched).filter((request) => request.key.startsWith('binary/'))).toEqual([]);
});

it("leaves the files of a folder that gained a .git as they were when House answers a moved file's links rewritten in them, and uploads around one of them still holding conflict markers", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('plan.md', 'Plant beans\n');
  notes.put('code/links.md', 'See [the plan](../plan.md).\n');
  notes.put('code/clash.md', 'one\n');
  expect(await rooms.download([notes])).toMatchObject({ status: 0 });
  notes.put('code/clash.md', 'one, theirs\n');
  await writeFile(join(notes.repository, 'code', 'clash.md'), 'one, mine\n');
  expect(await upload(hosted, notes)).toMatchObject({ status: 1 });
  const marked = await readFile(join(notes.repository, 'code', 'clash.md'), 'utf8');
  expect(marked).toContain('<<<<<<<');
  const code = join(notes.repository, 'code');
  git(code, 'init', '--quiet', '--initial-branch=main');
  const before = await tree(code);
  const entries = (await manifestOf(notes)).files;
  const plan = notes.revision('plan.md');
  await rm(join(notes.repository, 'plan.md'));
  await writeFile(join(notes.repository, 'plans.md'), 'Plant beans\n');

  expect(await upload(hosted, notes)).toEqual({ status: 0, stdout: ['House accepted 1 file of /rooms/notes.', leftOut('code'), ''].join('\n'), stderr: '' });

  expect(batches(hosted).at(-1)).toEqual([{ op: 'move', path: '/rooms/notes/plan.md', to: '/rooms/notes/plans.md', base: plan }]);
  expect(notes.files.get('code/links.md')!.content).toBe('See [the plan](../plans.md).\n');
  expect(await tree(code)).toEqual(before);
  const after = (await manifestOf(notes)).files;
  expect([after['code/links.md'], after['code/clash.md']]).toEqual([entries['code/links.md'], entries['code/clash.md']]);
});

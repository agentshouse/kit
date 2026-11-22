import { chmod, lstat, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, type Hosted } from './environment.ts';
import { house, manifestOf, ownAgent, roomRootReads, serveRooms, upload, type Room } from './rooms.ts';

const FIRST = 'These instructions come after House’s and your own.\n\nWrite dates as YYYY-MM-DD.\n';
const SECOND = 'These instructions come after House’s and your own.\n\nWrite dates as YYYY-MM-DD.\nPut new tasks on the map.\n';
const IMPORTED = '@AGENTS.md\n';

function folderOf(hosted: Hosted, handle: string): string {
  return join(hosted.workspace, 'rooms', handle);
}

async function held(folder: string): Promise<string[]> {
  return (await readdir(folder)).sort();
}

async function readOnly(path: string): Promise<boolean> {
  return ((await stat(path)).mode & 0o777) === 0o444;
}

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

function chunked(hosted: Hosted, room: Room): unknown[] {
  return hosted.house.requests.filter((request) => request.path.startsWith('/kit/door/') && JSON.stringify(request.body).includes(room.root));
}

it("writes a copied Room's AGENTS.md and CLAUDE.md read-only, rewrites a hand-edited AGENTS.md, uploads neither, and deletes both with their manifest entries once the Environment no longer reaches the Room", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'a\n');
  notes.instructions = FIRST;

  expect(await rooms.download([notes])).toMatchObject({ status: 0, stdout: `${notes.root}: copied to ${notes.repository}\n` });

  expect(await held(notes.repository)).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md']);
  expect(await readFile(join(notes.repository, 'AGENTS.md'), 'utf8')).toBe(FIRST);
  expect(await readFile(join(notes.repository, 'CLAUDE.md'), 'utf8')).toBe(IMPORTED);
  expect(await readOnly(join(notes.repository, 'AGENTS.md'))).toBe(true);
  expect(await readOnly(join(notes.repository, 'CLAUDE.md'))).toBe(true);
  expect(await manifestOf(notes)).toMatchObject({ kit: ['AGENTS.md', 'CLAUDE.md'] });
  expect(Object.keys((await manifestOf(notes)).files)).toEqual(['a.md']);

  await chmod(join(notes.repository, 'AGENTS.md'), 0o644);
  await writeFile(join(notes.repository, 'AGENTS.md'), 'my own words\n');
  await rm(join(notes.repository, 'CLAUDE.md'), { force: true });
  expect(await upload(hosted, notes)).toMatchObject({ status: 0, stdout: `Nothing to upload: ${notes.root} matches House.\n` });
  expect(rooms.edits()).toEqual([]);
  expect(await rooms.download([notes])).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });
  expect(await readFile(join(notes.repository, 'AGENTS.md'), 'utf8')).toBe(FIRST);
  expect(await readOnly(join(notes.repository, 'AGENTS.md'))).toBe(true);
  expect(await readFile(join(notes.repository, 'CLAUDE.md'), 'utf8')).toBe(IMPORTED);

  expect(await rooms.download([])).toMatchObject({ status: 0, stdout: `${notes.root}: no longer followed; kept as it is\n` });

  expect(await held(notes.repository)).toEqual(['.house', 'a.md']);
  expect(await manifestOf(notes)).not.toHaveProperty('kit');
});

it("makes the folder of a Room held at the Open level holding the two files alone, renames it with the Room's handle, and keeps the folder and files of a Room lowered from the Keep to the Open level", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const garden = rooms.room('garden');
  garden.put('plan.md', 'Plant beans\n');
  garden.instructions = FIRST;
  const notes = rooms.room('notes');
  notes.put('a.md', 'a\n');
  notes.instructions = SECOND;
  rooms.open = [garden];

  expect(await rooms.download([notes])).toMatchObject({ status: 0, stdout: `${notes.root}: copied to ${notes.repository}\n` });

  expect(await held(folderOf(hosted, 'garden'))).toEqual(['AGENTS.md', 'CLAUDE.md']);
  expect(await readFile(join(folderOf(hosted, 'garden'), 'AGENTS.md'), 'utf8')).toBe(FIRST);
  expect(await readOnly(join(folderOf(hosted, 'garden'), 'AGENTS.md'))).toBe(true);
  expect(chunked(hosted, garden)).toEqual([]);
  expect(await house(hosted, folderOf(hosted, 'garden'), 'upload', '--owner')).toMatchObject({
    status: 1,
    stderr: `house: ${folderOf(hosted, 'garden')} is not in a House Local copy; run house upload inside one\n`,
  });

  garden.rehandle('garden-club');
  rooms.open = [garden, notes];
  expect(await rooms.download([])).toMatchObject({ status: 0, stdout: `${notes.root}: no longer followed; kept as it is\n` });

  await absent(folderOf(hosted, 'garden'));
  expect(await held(folderOf(hosted, 'garden-club'))).toEqual(['AGENTS.md', 'CLAUDE.md']);
  expect(await held(notes.repository)).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md']);
  expect(await readFile(join(notes.repository, 'AGENTS.md'), 'utf8')).toBe(SECOND);
  expect(chunked(hosted, garden)).toEqual([]);

  rooms.open = [notes];
  expect(await rooms.download([])).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });

  expect(await held(folderOf(hosted, 'garden-club'))).toEqual([]);
  expect(await held(notes.repository)).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md']);
});

it('copies a Room raised from the Open to the Keep level into its folder, setting nothing aside', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const garden = rooms.room('garden');
  garden.put('plan.md', 'Plant beans\n');
  garden.instructions = FIRST;
  rooms.open = [garden];
  await rooms.download([]);
  rooms.open = [];

  expect(await rooms.download([garden])).toMatchObject({ status: 0, stdout: `${garden.root}: copied to ${garden.repository}\n` });

  expect(await held(garden.repository)).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'plan.md']);
  expect(await manifestOf(garden)).toMatchObject({ kit: ['AGENTS.md', 'CLAUDE.md'] });
  expect((await readdir(join(hosted.workspace, 'rooms'))).filter((name) => !name.startsWith('.'))).toEqual(['garden']);
});

it('changes AGENTS.md at the next download after an approval or a new version, and not at a reconnect before it', async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'a\n');
  notes.instructions = FIRST;
  const garden = rooms.room('garden');
  garden.instructions = FIRST;
  rooms.open = [garden];
  await rooms.download([notes]);
  notes.instructions = SECOND;
  garden.instructions = SECOND;
  const selections = hosted.house.requests.filter((request) => request.path === '/kit/local-copies/selection/read').length;
  const reads = roomRootReads(hosted).length;

  await hosted.restart();
  await until(() => hosted.house.requests.filter((request) => request.path === '/kit/local-copies/selection/read').length > selections || undefined);

  expect(roomRootReads(hosted).slice(reads)).toEqual([]);
  expect(await readFile(join(notes.repository, 'AGENTS.md'), 'utf8')).toBe(FIRST);
  expect(await readFile(join(folderOf(hosted, 'garden'), 'AGENTS.md'), 'utf8')).toBe(FIRST);

  expect(await rooms.download([notes])).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });

  expect(roomRootReads(hosted).slice(reads).sort()).toEqual([garden.root, notes.root]);
  expect(await readFile(join(notes.repository, 'AGENTS.md'), 'utf8')).toBe(SECOND);
  expect(await readFile(join(folderOf(hosted, 'garden'), 'AGENTS.md'), 'utf8')).toBe(SECOND);
});

it("deletes the two files once House answers a Room's instructions empty, and keeps the last text where it cannot read them, saying so", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'a\n');
  notes.instructions = FIRST;
  const garden = rooms.room('garden');
  garden.instructions = FIRST;
  rooms.open = [garden];
  await rooms.download([notes]);

  await rm(join(hosted.home, 'own-agent.json'));
  notes.instructions = SECOND;
  expect(await rooms.download([notes])).toMatchObject({
    status: 0,
    stdout: `${garden.root}, ${notes.root}: AGENTS.md kept as it was: this computer's own agent has no House connection; run kit login\n`,
  });
  expect(await readFile(join(notes.repository, 'AGENTS.md'), 'utf8')).toBe(FIRST);

  await ownAgent(hosted);
  notes.instructions = '';
  garden.instructions = '';
  expect(await rooms.download([notes])).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });

  expect(await held(notes.repository)).toEqual(['.house', 'a.md']);
  expect(await manifestOf(notes)).not.toHaveProperty('kit');
  expect(await held(folderOf(hosted, 'garden'))).toEqual([]);
});

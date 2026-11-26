import { chmod, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, ProtocolRefusal, type Hosted } from './environment.ts';
import { accountOf, temporaryHome } from './kit.ts';
import { house, manifestOf, roomRootReads, serveRooms, upload, type Room } from './rooms.ts';

const FIRST = 'These instructions come after House’s and your own.\n\nWrite dates as YYYY-MM-DD.\n';
const SECOND = 'These instructions come after House’s and your own.\n\nWrite dates as YYYY-MM-DD.\nPut new tasks on the map.\n';
const IMPORTED = '@AGENTS.md\n';
const LONG = 'Write dates as YYYY-MM-DD.\n'.repeat(1500);

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

it("writes a copied Room's AGENTS.md and CLAUDE.md read-only, rewrites a hand-edited AGENTS.md, uploads neither, deletes both with their manifest entries once the Environment no longer reaches the Room, and reads that copy no more once it holds no .house", async () => {
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

  await rm(join(notes.repository, '.house'));
  expect(await rooms.download([])).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });
  expect(await held(notes.repository)).toEqual(['a.md']);
});

it("makes the folder of a Room held at the Open level holding the two files alone, renames it with the Room's handle, keeps the folder and files of a Room lowered from the Keep to the Open level, and takes a lost Room's folder back once the Room is reached again", async () => {
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
  expect(await house(hosted, folderOf(hosted, 'garden'), 'upload')).toMatchObject({
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

  await writeFile(join(folderOf(hosted, 'garden-club'), 'AGENTS.md'), 'my own words\n');
  expect(await rooms.download([])).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });
  expect(await readFile(join(folderOf(hosted, 'garden-club'), 'AGENTS.md'), 'utf8')).toBe('my own words\n');

  rooms.open = [garden, notes];
  expect(await rooms.download([])).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });

  expect(await held(folderOf(hosted, 'garden-club'))).toEqual(['AGENTS.md', 'CLAUDE.md']);
  expect(await readFile(join(folderOf(hosted, 'garden-club'), 'AGENTS.md'), 'utf8')).toBe(FIRST);
  expect((await readdir(join(hosted.workspace, 'rooms'))).filter((name) => !name.startsWith('.')).sort()).toEqual(['garden-club', 'notes']);
});

it("copies a Room raised from the Open to the Keep level into its folder beside what else the folder holds, an Agent's chosen launch directory, setting aside only what a document of the Room takes the name of", async () => {
  const home = await temporaryHome();
  const chosen = join(accountOf(home), 'house', 'rooms', 'garden');
  const hosted = await hostKit([{ working_directory: chosen }], { home });
  const rooms = serveRooms(hosted);
  const garden = rooms.room('garden');
  garden.put('plan.md', 'Plant beans\n');
  garden.instructions = FIRST;
  rooms.open = [garden];
  await rooms.download([]);
  await mkdir(join(chosen, '.claude'));
  await writeFile(join(chosen, '.claude', 'settings.local.json'), '{}\n');
  await writeFile(join(chosen, 'plan.md'), 'my plan\n');
  rooms.open = [];

  expect(await rooms.download([garden])).toMatchObject({ status: 0, stdout: `${garden.root}: copied to ${chosen}\n` });

  expect(await held(chosen)).toEqual(['.claude', '.house', 'AGENTS.md', 'CLAUDE.md', 'plan.md', 'plan.md (kept)']);
  expect(await readFile(join(chosen, 'plan.md'), 'utf8')).toBe('Plant beans\n');
  expect(await readFile(join(chosen, 'plan.md (kept)'), 'utf8')).toBe('my plan\n');
  expect(await readFile(join(chosen, '.claude', 'settings.local.json'), 'utf8')).toBe('{}\n');
  expect(await readFile(join(chosen, 'AGENTS.md'), 'utf8')).toBe(FIRST);
  expect(await manifestOf(garden)).toMatchObject({ kit: ['AGENTS.md', 'CLAUDE.md'] });
  expect((await readdir(join(hosted.workspace, 'rooms'))).filter((name) => !name.startsWith('.'))).toEqual(['garden']);
});

it("leaves a raised Room's folder as it was where a document of the Room takes the name of an entry holding an Agent's chosen launch directory, saying so at each download", async () => {
  const home = await temporaryHome();
  const chosen = join(accountOf(home), 'house', 'rooms', 'garden', 'docs', 'work');
  const hosted = await hostKit([{ working_directory: chosen }], { home });
  const rooms = serveRooms(hosted);
  const garden = rooms.room('garden');
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) garden.put(`${name}.md`, `${name}\n`);
  garden.put('docs/x.md', 'x\n');
  garden.instructions = FIRST;
  rooms.open = [garden];
  await rooms.download([]);
  await mkdir(chosen, { recursive: true });
  rooms.open = [];
  const refused = { status: 1, stderr: `house: ${garden.root}: ${join(folderOf(hosted, 'garden'), 'docs')} holds a folder an Agent works in, so Kit leaves it as it is\n` };

  expect(await rooms.download([garden])).toMatchObject(refused);
  expect(await rooms.download([garden])).toMatchObject(refused);

  expect(await held(folderOf(hosted, 'garden'))).toEqual(['AGENTS.md', 'CLAUDE.md', 'docs']);
  expect(await held(join(folderOf(hosted, 'garden'), 'docs'))).toEqual(['work']);
});

it('changes AGENTS.md at the next connection after an approval or a new version, and leaves it at the download after it', async () => {
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
  await until(async () => ((await readFile(join(folderOf(hosted, 'garden'), 'AGENTS.md'), 'utf8')) === SECOND ? true : undefined));

  expect(roomRootReads(hosted).slice(reads).sort()).toEqual([garden.root, notes.root]);
  expect(await readFile(join(notes.repository, 'AGENTS.md'), 'utf8')).toBe(SECOND);

  expect(await rooms.download([notes])).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });

  expect(await readFile(join(notes.repository, 'AGENTS.md'), 'utf8')).toBe(SECOND);
  expect(await readFile(join(folderOf(hosted, 'garden'), 'AGENTS.md'), 'utf8')).toBe(SECOND);
});

it("writes AGENTS.md whole from a Room's instructions House cuts in two parts, reading on through next_cursor to the last part", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'a\n');
  notes.instructions = LONG;

  expect(await rooms.download([notes])).toMatchObject({ status: 0, stdout: `${notes.root}: copied to ${notes.repository}\n` });

  expect(await readFile(join(notes.repository, 'AGENTS.md'), 'utf8')).toBe(LONG);
  expect(roomRootReads(hosted)).toEqual([notes.root, notes.root]);
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

  const info = hosted.tools.info!;
  hosted.tools.info = () => {
    throw new ProtocolRefusal(401, { code: -32000, message: 'token_rejected: sign in again', data: { code: 'token_rejected', retryable: false } });
  };
  notes.instructions = SECOND;
  expect(await rooms.download([notes])).toMatchObject({
    status: 0,
    stdout: `${garden.root}, ${notes.root}: AGENTS.md kept as it was: House no longer accepts this computer; run house login\n`,
  });
  expect(await readFile(join(notes.repository, 'AGENTS.md'), 'utf8')).toBe(FIRST);

  hosted.tools.info = info;
  notes.instructions = '';
  garden.instructions = '';
  expect(await rooms.download([notes])).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });

  expect(await held(notes.repository)).toEqual(['.house', 'a.md']);
  expect(await manifestOf(notes)).not.toHaveProperty('kit');
  expect(await held(folderOf(hosted, 'garden'))).toEqual([]);
});

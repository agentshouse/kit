import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills } from '@agentshouse/skills';
import { beforeEach, expect, it } from 'vitest';
import { catalogue, type OwnSkills } from './catalogue.ts';
import { settle, until } from './double.ts';
import { hostKit, lastCall, type Hosted, type Hosting } from './environment.ts';
import { accountOf, runKit } from './kit.ts';
import { house, manifestOf, serveRooms, upload, type Room, type RoomSkill, type Rooms } from './rooms.ts';

const SKILL_SET = fileURLToPath(new URL('../node_modules/@agentshouse/skills/set/', import.meta.url));
const [FIRST, SECOND] = listSkills().map((skill) => skill.name) as [string, string];
const UPSTREAM = listSkills().map((skill) => skill.name);
const FOLDERS = [join('.agents', 'skills'), join('.claude', 'skills')];
const INSTRUCTIONS = 'Write dates as YYYY-MM-DD.\n';
const OWNED = 'weekly-review';
const OWNED_FILES = {
  'SKILL.md': `---\nname: ${OWNED}\ndescription: Reviews the week.\n---\n# Weekly review\n\nReviews the week.\n`,
  'steps/first.md': 'Read the week.\n',
};
const EDITED_FILES = { ...OWNED_FILES, 'steps/first.md': 'Read the week twice.\n' };
const MINE = { 'SKILL.md': `---\nname: ${OWNED}\ndescription: My own weekly review.\n---\n# My weekly review\n` };
const NEWER = 'newer-house-skill';

let own: OwnSkills = {};

beforeEach(() => {
  own = {};
});

interface Staged {
  hosted: Hosted;
  rooms: Rooms;
  notes: Room;
}

async function staged(hosting: Hosting = {}, skills: RoomSkill[] = [], routes = 1): Promise<Staged> {
  const hosted = await hostKit(
    Array.from({ length: routes }, () => ({})),
    { skills: [], ...hosting, tools: { guide: catalogue(UPSTREAM, () => own), ...hosting.tools } },
  );
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'a\n');
  notes.instructions = INSTRUCTIONS;
  notes.skills = skills;
  return { hosted, rooms, notes };
}

function owned(files: Readonly<Record<string, string>> = OWNED_FILES): RoomSkill {
  return { name: OWNED, own: true, files };
}

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

async function folderTree(folder: string): Promise<string[]> {
  const trees = await Promise.all(FOLDERS.map((skills) => tree(join(folder, skills))));
  expect(trees[1], 'the .claude/skills of the folder').toEqual(trees[0]);
  return trees[0]!;
}

async function written(folder: string, name: string): Promise<Record<string, string>> {
  const files: Record<string, string>[] = [];
  for (const skills of FOLDERS) {
    const root = join(folder, skills, name);
    files.push(Object.fromEntries(await Promise.all((await tree(root)).map(async (path) => [path, await readFile(join(root, path), 'utf8')] as const))));
  }
  expect(files[1], `.claude/skills/${name}`).toEqual(files[0]);
  return files[0]!;
}

async function packaged(name: string): Promise<Record<string, string>> {
  const root = join(SKILL_SET, name);
  return Object.fromEntries(await Promise.all((await tree(root)).map(async (path) => [path, await readFile(join(root, path), 'utf8')] as const)));
}

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

function roomAsks(hosted: Hosted): Record<string, unknown>[] {
  return hosted.mcp
    .map((request) => (request.body as { params: { name?: string; arguments?: Record<string, unknown> } }).params)
    .filter(({ name, arguments: args }) => name === 'guide' && args?.room !== undefined)
    .map(({ arguments: args }) => args!);
}

function noticed(hosted: Hosted, room: Room): void {
  hosted.house.connections.at(-1)!.send({ type: 'work_available', subject: 'rooms', room_ref: room.ref });
}

async function recorded(room: Room): Promise<unknown> {
  return ((await manifestOf(room)) as { skills?: unknown }).skills;
}

function record(names: readonly string[], listed: readonly string[], approved: number | null = 1): Record<string, unknown> {
  return { approved, listed: [...listed].sort(), sources: expect.any(Object), names: [...names].sort(), digest: names.length === 0 ? expect.any(String) : expect.stringMatching(/^[0-9a-f]{64}$/u) };
}

async function opened(hosted: Hosted, index: number, room: Room, name: string, copy?: { kind: 'none' } | { kind: 'new' }): Promise<void> {
  const run = copy === undefined ? {} : { run: { name, copy, repository: null } };
  hosted.call({ kind: 'open', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, room_ref: room.ref, name, ...run });
  const answer = (await hosted.result(lastCall())) as { provider_session_id?: string; refused?: string };
  if (answer.provider_session_id === undefined) throw new Error(`the open was refused: ${answer.refused}`);
}

function copyOf(hosted: Hosted, handle: string, name: string): string {
  return join(hosted.workspace, 'conversations', handle, name);
}

async function reconnected(hosted: Hosted): Promise<void> {
  const opens = hosted.house.connections.length;
  hosted.connection.close(1012, 'deploy');
  await until(() => hosted.house.connections.length > opens);
}

async function kitSettings(hosted: Hosted, ...operands: string[]): Promise<void> {
  const kit = runKit(['settings', ...operands], { HOME: accountOf(hosted.home) });
  expect(await kit.exited, kit.stderr()).toBe(0);
}

it("writes into a copied Room's folder, in .agents/skills and .claude/skills alike, the Room owner's own skill at the files the member's approved version carries and House's at the package's text whatever House's answer holds, none of a name among the Environment's skills nor of a House skill the package lacks, and marks what it wrote in the manifest", async () => {
  const { hosted, rooms, notes } = await staged({ skills: [FIRST] }, [
    { name: FIRST, files: { 'SKILL.md': 'House answers its first skill\n' } },
    { name: SECOND, files: { 'SKILL.md': 'House answers another text\n' } },
    owned(),
    { name: NEWER, files: { 'SKILL.md': 'a skill of a newer package\n' } },
  ]);

  expect(await rooms.download([notes])).toMatchObject({ status: 0, stdout: `${notes.root}: copied to ${notes.repository}\n` });

  expect((await readdir(join(notes.repository, '.agents', 'skills'))).sort()).toEqual([OWNED, SECOND].sort());
  expect(await written(notes.repository, OWNED)).toEqual(OWNED_FILES);
  expect(await written(notes.repository, SECOND)).toEqual(await packaged(SECOND));
  await absent(join(notes.repository, '.agents', 'skills', FIRST));
  await absent(join(notes.repository, '.claude', 'skills', FIRST));
  await absent(join(notes.repository, '.agents', 'skills', NEWER));
  expect(await recorded(notes)).toEqual(record([OWNED, SECOND], [FIRST, SECOND, OWNED, NEWER]));
  expect(((await recorded(notes)) as { sources: unknown }).sources).toEqual({ [FIRST]: 'environment', [SECOND]: expect.stringMatching(/^house:[0-9a-f]{64}$/u) });
  expect(Object.keys((await manifestOf(notes)).files)).toEqual(['a.md']);
  expect(roomAsks(hosted)).toEqual([{ op: 'skill', room: notes.ref }]);
});

it("writes a member's own skill of a listed name in place of the Room owner's, and leaves a skill folder of a listed name it did not write as it is, writing nothing under that name", async () => {
  own = { [OWNED]: MINE };
  const { rooms, notes } = await staged();
  await rooms.download([notes]);
  await mkdir(join(notes.repository, '.claude', 'skills', SECOND), { recursive: true });
  await writeFile(join(notes.repository, '.claude', 'skills', SECOND, 'SKILL.md'), 'my project skill\n');
  notes.approved = 2;
  notes.skills = [owned(), { name: SECOND, files: {} }];

  await rooms.download([notes]);

  expect(await written(notes.repository, OWNED)).toEqual(MINE);
  expect(await readFile(join(notes.repository, '.claude', 'skills', SECOND, 'SKILL.md'), 'utf8')).toBe('my project skill\n');
  await absent(join(notes.repository, '.agents', 'skills', SECOND));
  expect(await recorded(notes)).toEqual(record([OWNED], [OWNED, SECOND], 2));
});

it("writes none for a member at no version, asking House nothing of the Room's skills, none into the launch directory of a Run whose Agent run names no copy, and the version's skills into a Run's new copy", async () => {
  const { hosted, rooms, notes } = await staged({}, [owned()], 2);
  notes.approved = null;

  await rooms.download([notes]);

  await absent(join(notes.repository, '.agents'));
  await absent(join(notes.repository, '.claude'));
  expect(await recorded(notes)).toEqual(record([], [], null));
  expect(roomAsks(hosted)).toEqual([]);

  notes.approved = 1;
  await opened(hosted, 1, notes, 'Nowhere', { kind: 'none' });
  await opened(hosted, 2, notes, 'Fresh', { kind: 'new' });

  expect(await tree(join(hosted.workingDirectory, '.agents'))).toEqual([]);
  expect(await tree(join(hosted.workingDirectory, '.claude'))).toEqual([]);
  expect(await written(copyOf(hosted, 'notes', 'Fresh'), OWNED)).toEqual(OWNED_FILES);
});

it("writes the skills of an approved version whose text compiles to nothing beside no AGENTS.md, in a Room's folder and a conversation's copy, keeps them once the folder's text goes, and deletes them once the Environment no longer reaches the Room", async () => {
  const { hosted, rooms, notes } = await staged({}, [owned()]);
  const plans = rooms.room('plans');
  plans.put('p.md', 'p\n');
  plans.instructions = '';
  plans.skills = [owned()];
  await rooms.download([notes, plans]);

  expect(await written(plans.repository, OWNED)).toEqual(OWNED_FILES);
  await absent(join(plans.repository, 'AGENTS.md'));
  await absent(join(plans.repository, 'CLAUDE.md'));
  expect(await recorded(plans)).toEqual(record([OWNED], [OWNED]));

  await opened(hosted, 1, plans, 'Chat');
  const chat = copyOf(hosted, 'plans', 'Chat');
  expect(await written(chat, OWNED)).toEqual(OWNED_FILES);
  await absent(join(chat, 'AGENTS.md'));

  notes.instructions = '';
  expect(await rooms.download([notes, plans])).toMatchObject({ status: 0 });

  await absent(join(notes.repository, 'AGENTS.md'));
  expect(await manifestOf(notes)).not.toHaveProperty('kit');
  expect(await written(notes.repository, OWNED)).toEqual(OWNED_FILES);
  expect(await recorded(notes)).toEqual(record([OWNED], [OWNED]));

  expect(await rooms.download([notes])).toMatchObject({ status: 0 });

  await absent(join(plans.repository, '.agents'));
  await absent(join(plans.repository, '.claude'));
  expect(await recorded(plans)).toBeUndefined();
  await absent(join(chat, '.agents'));
  await absent(join(chat, '.claude'));
  expect(await written(notes.repository, OWNED)).toEqual(OWNED_FILES);
});

it("rewrites a conversation's copy's skills at the notice naming the Room once the member follows a new version, a Room's folder's at its next house download, and asks House nothing of them while the approved version stays", async () => {
  const { hosted, rooms, notes } = await staged({}, [owned()]);
  await rooms.download([notes]);
  await opened(hosted, 1, notes, 'Chat');
  const copy = copyOf(hosted, 'notes', 'Chat');
  expect(await written(copy, OWNED)).toEqual(OWNED_FILES);
  const asked = roomAsks(hosted).length;

  notes.put('b.md', 'b\n');
  noticed(hosted, notes);
  await until(async () => (await readFile(join(copy, 'b.md'), 'utf8').catch(() => null)) === 'b\n');
  await settle();
  expect(roomAsks(hosted)).toHaveLength(asked);

  notes.approved = 2;
  notes.skills = [owned(EDITED_FILES)];
  noticed(hosted, notes);
  await until(async () => (await readFile(join(copy, '.agents', 'skills', OWNED, 'steps', 'first.md'), 'utf8').catch(() => null)) === EDITED_FILES['steps/first.md']);

  expect(await written(copy, OWNED)).toEqual(EDITED_FILES);
  expect(await written(notes.repository, OWNED)).toEqual(OWNED_FILES);

  expect(await rooms.download([notes])).toMatchObject({ status: 0 });

  expect(await written(notes.repository, OWNED)).toEqual(EDITED_FILES);
  expect(await recorded(notes)).toEqual(record([OWNED], [OWNED], 2));
});

it("rewrites the skills in every copy, a Run's among them, when house settings changes the Environment's skills, a name the Environment now holds going and one it no longer holds coming back", async () => {
  const { hosted, rooms, notes } = await staged({}, [{ name: SECOND, files: {} }, owned()]);
  await rooms.download([notes]);
  await opened(hosted, 1, notes, 'Fresh', { kind: 'new' });
  const fresh = copyOf(hosted, 'notes', 'Fresh');
  expect(await folderTree(notes.repository)).toContain(join(SECOND, 'SKILL.md'));
  expect(await written(fresh, SECOND)).toEqual(await packaged(SECOND));

  await kitSettings(hosted, 'skills', SECOND);

  for (const folder of [notes.repository, fresh]) {
    await absent(join(folder, '.agents', 'skills', SECOND));
    await absent(join(folder, '.claude', 'skills', SECOND));
    expect(await written(folder, OWNED)).toEqual(OWNED_FILES);
  }
  expect(await recorded(notes)).toEqual(record([OWNED], [SECOND, OWNED]));

  await kitSettings(hosted, 'skills');

  expect(await written(notes.repository, SECOND)).toEqual(await packaged(SECOND));
  expect(await written(fresh, SECOND)).toEqual(await packaged(SECOND));
  expect(await recorded(notes)).toEqual(record([OWNED, SECOND], [SECOND, OWNED]));
});

it("rewrites the skills at the notice naming the Private Room once the member's own skill of a listed name changes, and as a Kit release starts once it changed the package's text of a listed House skill", async () => {
  const { hosted, rooms, notes } = await staged({}, [owned(), { name: SECOND, files: {} }]);
  const privateRoom = rooms.room('private');
  privateRoom.instructions = INSTRUCTIONS;
  rooms.open = [privateRoom];
  await rooms.download([notes]);
  expect(await written(notes.repository, OWNED)).toEqual(OWNED_FILES);

  own = { [OWNED]: MINE };
  noticed(hosted, privateRoom);
  await until(async () => (await readFile(join(notes.repository, '.agents', 'skills', OWNED, 'SKILL.md'), 'utf8').catch(() => null)) === MINE['SKILL.md']);

  expect(await written(notes.repository, OWNED)).toEqual(MINE);

  own = {};
  noticed(hosted, privateRoom);
  await until(async () => (await tree(join(notes.repository, '.agents', 'skills', OWNED))).length === 2);

  expect(await written(notes.repository, OWNED)).toEqual(OWNED_FILES);

  const manifest = JSON.parse(await readFile(join(notes.repository, '.house'), 'utf8')) as { skills: { sources: Record<string, string>; digest: string } };
  const { sources, digest } = manifest.skills;
  expect(sources[SECOND]).toMatch(/^house:[0-9a-f]{64}$/u);
  const earlierRelease = { ...manifest.skills, sources: { ...sources, [SECOND]: 'house:an earlier package' }, digest: 'an earlier package' };
  await writeFile(join(notes.repository, '.house'), JSON.stringify({ ...manifest, skills: earlierRelease }));
  await writeFile(join(notes.repository, '.agents', 'skills', SECOND, 'SKILL.md'), 'edited here\n');

  await hosted.restart();
  await until(async () => ((await recorded(notes)) as { digest: string }).digest === digest);

  expect(await written(notes.repository, SECOND)).toEqual(await packaged(SECOND));
  expect(await written(notes.repository, OWNED)).toEqual(OWNED_FILES);
  expect(await recorded(notes)).toEqual({ ...record([OWNED, SECOND], [OWNED, SECOND]), sources });
});

it("asks House nothing of a Room's skills at a connection's opening or a notice naming the Private Room while nothing they come from changed, and reads again only the Rooms listing a name whose source changed", async () => {
  const { hosted, rooms, notes } = await staged({}, [owned()]);
  const plans = rooms.room('plans');
  plans.put('p.md', 'p\n');
  plans.instructions = INSTRUCTIONS;
  plans.skills = [{ name: SECOND, files: {} }];
  const privateRoom = rooms.room('private');
  privateRoom.instructions = INSTRUCTIONS;
  rooms.open = [privateRoom];
  await rooms.download([notes, plans]);
  await opened(hosted, 1, plans, 'Chat');
  const chat = copyOf(hosted, 'plans', 'Chat');
  expect(await written(chat, SECOND)).toEqual(await packaged(SECOND));
  expect(await written(notes.repository, OWNED)).toEqual(OWNED_FILES);
  const asked = roomAsks(hosted).length;

  await reconnected(hosted);
  noticed(hosted, privateRoom);
  await settle();

  expect(roomAsks(hosted)).toHaveLength(asked);

  own = { [OWNED]: MINE };
  noticed(hosted, privateRoom);
  await until(async () => (await readFile(join(notes.repository, '.agents', 'skills', OWNED, 'SKILL.md'), 'utf8').catch(() => null)) === MINE['SKILL.md']);
  await settle();

  expect(roomAsks(hosted).slice(asked)).toEqual([{ op: 'skill', room: notes.ref }]);
  expect(await written(plans.repository, SECOND)).toEqual(await packaged(SECOND));
  expect(await written(chat, SECOND)).toEqual(await packaged(SECOND));
});

it("uploads nothing .agents/skills or .claude/skills hold in a Room's folder or a conversation's copy, a hand-written skill and a file House holds there included, and deletes only what it wrote, with its manifest record, once the Environment no longer reaches the Room", async () => {
  const { hosted, rooms, notes } = await staged({}, [owned()]);
  notes.put('.agents/skills/served/SKILL.md', 'House holds this\n');
  await rooms.download([notes]);
  await writeFile(join(notes.repository, '.agents', 'skills', OWNED, 'SKILL.md'), 'edited here\n');
  await mkdir(join(notes.repository, '.claude', 'skills', 'mine'), { recursive: true });
  await writeFile(join(notes.repository, '.claude', 'skills', 'mine', 'SKILL.md'), 'my own\n');
  await writeFile(join(notes.repository, '.agents', 'skills', 'served', 'SKILL.md'), 'changed here\n');

  expect(await upload(hosted, notes)).toMatchObject({ status: 0, stdout: `Nothing to upload: ${notes.root} matches House.\n` });
  expect(rooms.edits()).toEqual([]);

  await opened(hosted, 1, notes, 'Chat');
  const copy = copyOf(hosted, 'notes', 'Chat');
  await writeFile(join(copy, '.agents', 'skills', OWNED, 'SKILL.md'), 'edited in the copy\n');
  expect(await house(hosted, copy, 'upload')).toMatchObject({ status: 0, stdout: `Nothing to upload: ${notes.root} matches House.\n` });
  expect(rooms.edits()).toEqual([]);

  expect(await rooms.download([])).toMatchObject({ status: 0 });

  await absent(join(notes.repository, '.agents', 'skills', OWNED));
  await absent(join(notes.repository, '.claude', 'skills', OWNED));
  expect(await readFile(join(notes.repository, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('my own\n');
  expect(await readFile(join(notes.repository, '.agents', 'skills', 'served', 'SKILL.md'), 'utf8')).toBe('changed here\n');
  expect(await recorded(notes)).toBeUndefined();
  await absent(join(copy, '.agents', 'skills', OWNED));
  await absent(join(copy, '.claude'));
  expect(await readFile(join(copy, '.agents', 'skills', 'served', 'SKILL.md'), 'utf8')).toBe('House holds this\n');
});

it("reads the Room's skills whole where House cuts their files across the pages of its answer, each cut value continued by the cut beside it", async () => {
  const long = (line: string) => Array.from({ length: 80 }, (_, index) => `${line} ${index}.\n`).join('');
  const notesText = `---\nname: notes\ndescription: Keeps notes.\n---\n${long('Keep the note')}`;
  const stepText = long('Then the step');
  const { hosted, rooms, notes } = await staged();
  const cut = (text: string, shown: number) => text.slice(0, shown);
  notes.skillPages = [
    {
      skills: [
        { name: 'notes', own: true, files: { 'SKILL.md': cut(notesText, 300), cut: { field: 'SKILL.md', shown: 300, total: notesText.length }, 'step.md': 'Short step.\n' } },
        { name: SECOND, files: { 'SKILL.md': 'House text\n' } },
        { name: OWNED, own: true, files: { 'SKILL.md': OWNED_FILES['SKILL.md'], 'steps/first.md': cut(stepText, 100), cut: { field: 'steps/first.md', shown: 100, total: stepText.length } } },
      ],
      next_cursor: '1',
    },
    { skills: [{ files: { 'SKILL.md': notesText.slice(300, 900), cut: { field: 'SKILL.md', shown: 900, total: notesText.length } } }], next_cursor: '2' },
    { skills: [{ files: { 'SKILL.md': notesText.slice(900) } }], next_cursor: '3' },
    { skills: [{ files: { 'steps/first.md': stepText.slice(100) } }], next_cursor: '4' },
    { skills: [{ name: 'tail', own: true, files: { 'SKILL.md': 'Tail.\n' } }] },
  ];

  await rooms.download([notes]);

  expect(await written(notes.repository, 'notes')).toEqual({ 'SKILL.md': notesText, 'step.md': 'Short step.\n' });
  expect(await written(notes.repository, OWNED)).toEqual({ 'SKILL.md': OWNED_FILES['SKILL.md'], 'steps/first.md': stepText });
  expect(await written(notes.repository, SECOND)).toEqual(await packaged(SECOND));
  expect(await written(notes.repository, 'tail')).toEqual({ 'SKILL.md': 'Tail.\n' });
  expect(roomAsks(hosted)).toEqual([
    { op: 'skill', room: notes.ref },
    ...['1', '2', '3', '4'].map((cursor) => ({ op: 'skill', room: notes.ref, cursor })),
  ]);
});

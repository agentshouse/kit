import { agentInstructions } from '@agentshouse/skills';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { settle, until, type Received } from './double.ts';
import { clocked, hostKit, lastCall, MOVED_CLOCK, shelled, type Hosted, type Hosting, type RouteOverrides } from './environment.ts';
import { alive, filesUnder, temporaryDirectory } from './kit.ts';
import { callUpdate, released, serveRelease } from './release.ts';
import { digest, house, manifestOf, roomRootReads, serveRooms, upload, type ManifestEntry, type Room, type Rooms } from './rooms.ts';

const INSTRUCTIONS = 'These instructions come after House’s and your own.\n\nWrite dates as YYYY-MM-DD.\n';
const OWNER_RULES = 'Keep the work in its Room.\n';
const IMPORTED = '@AGENTS.md\n';
const PLACED = '0.2.1-c000000000002';
const HOUR = 60 * 60_000;
const HALTED_REMOVAL = ['--import', fileURLToPath(new URL('./halted-removal.ts', import.meta.url))];
const REFUSED_LINKS = ['--import', fileURLToPath(new URL('./refused-links.ts', import.meta.url))];
const MEGABYTE_AND_ONE = 1_000_001;

function copyOf(hosted: Hosted, handle: string, name: string): string {
  return join(hosted.workspace, 'conversations', handle, name);
}

async function held(folder: string): Promise<string[]> {
  return (await readdir(folder)).sort();
}

async function manifestAt(copy: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(copy, '.house'), 'utf8')) as Record<string, unknown>;
}

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function opened(hosted: Hosted, room: Room | null, name: string, conversation = 'conversation-1', agent = 'agent-1'): Promise<string> {
  hosted.call({ kind: 'open', conversation_id: conversation, agent_id: agent, room_ref: room?.ref ?? null, name });
  const answer = (await hosted.result(lastCall())) as { provider_session_id?: string; refused?: string };
  if (answer.provider_session_id === undefined) throw new Error(`the open was refused: ${answer.refused}`);
  return answer.provider_session_id;
}

function said(hosted: Hosted, text: string, fields: Record<string, unknown> = {}): void {
  hosted.call({ kind: 'message', conversation_id: 'conversation-1', agent_id: 'agent-1', text, first: false, ...fields });
}

async function logged(hosted: Hosted, method: string): Promise<Record<string, unknown>[]> {
  return (await hosted.adapterLog()).filter((entry) => entry.method === method);
}

async function prompt(hosted: Hosted, index: number): Promise<string> {
  const prompts = await until(async () => {
    const written = await logged(hosted, 'session/prompt');
    return written.length > index ? written : undefined;
  });
  return String(prompts[index]!.text);
}

async function cwdOf(hosted: Hosted, method: 'session/new' | 'session/resume', index: number): Promise<string> {
  const sessions = await until(async () => {
    const written = await logged(hosted, method);
    return written.length > index ? written : undefined;
  });
  return (sessions[index]!.params as { cwd: string }).cwd;
}

function ended(hosted: Hosted): Received[] {
  return hosted.turns.filter((turn) => turn.path === '/kit/turns/end');
}

async function turned(hosted: Hosted, count: number): Promise<void> {
  await until(() => ended(hosted).length >= count);
}

function changesOf(received: Received): unknown {
  return (received.body as { params: { arguments: { changes: unknown } } }).params.arguments.changes;
}

async function edited(rooms: Rooms, count: number): Promise<Received[]> {
  return until(() => (rooms.edits().length >= count ? rooms.edits() : undefined));
}

function told(hosted: Hosted, index: number, text: string, fields: Record<string, unknown> = {}): void {
  hosted.call({ kind: 'message', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, text, first: false, ...fields });
}

async function killed(hosted: Hosted, index: number, deleted?: true): Promise<unknown> {
  hosted.call({ kind: 'kill', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, ...(deleted === undefined ? {} : { deleted }) });
  return hosted.result(lastCall());
}

async function contents(folder: string, skipped = ''): Promise<Record<string, string>> {
  const files = (await filesUnder(folder)).filter((file) => skipped === '' || !file.startsWith(`${skipped}/`)).sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, (await readFile(file)).toString('base64')] as const)));
}

async function conflicted(hosted: Hosted, rooms: Rooms, marked: number, other: number): Promise<void> {
  const copy = copyOf(hosted, 'notes', `Plan ${marked}`);
  const edits = rooms.edits().length;
  told(hosted, marked, "@sh sed -i 's/beans/corn/' plan.md\n@gate other-landed");
  await until(async () => ((await readFile(join(copy, 'plan.md'), 'utf8')) === 'Plant corn\n' ? true : undefined));
  told(hosted, other, "@sh sed -i 's/beans/peas/' plan.md");
  await edited(rooms, edits + 1);
  await writeFile(join(hosted.home, 'other-landed'), '');
  await edited(rooms, edits + 2);
  await until(async () => ((await readFile(join(copy, 'plan.md'), 'utf8')).includes('<<<<<<<') ? true : undefined));
  await settle();
}

async function pending(hosted: Hosted, rooms: Rooms, index: number): Promise<void> {
  const copy = copyOf(hosted, 'notes', `Plan ${index}`);
  const edits = rooms.edits().length;
  rooms.writeUnits = 0;
  told(hosted, index, '@sh echo two >> plan.md');
  await edited(rooms, edits + 1);
  await settle();
  rooms.writeUnits = Infinity;
  await writeFile(join(copy, 'plan.md'), 'Plant beans\n');
}

function lineOf(text: string): string {
  return text.split('\n').at(-1)!;
}

function bytes(text: string): Buffer {
  return Buffer.from(text);
}

async function inode(path: string): Promise<[number, number]> {
  const { dev, ino } = await stat(path);
  return [dev, ino];
}

async function replaced(path: string, content: Buffer): Promise<void> {
  await writeFile(`${path}.new`, content);
  await rename(`${path}.new`, path);
}

async function entriesOf(copy: string): Promise<Record<string, ManifestEntry>> {
  return ((await manifestAt(copy)) as { files: Record<string, ManifestEntry> }).files;
}

function fetchedBytes(hosted: Hosted): number {
  return hosted.store.requests.filter((request) => request.method === 'GET' && request.key.startsWith('binary/')).length;
}

function noticed(hosted: Hosted, room: Room): void {
  hosted.house.connections.at(-1)!.send({ type: 'work_available', subject: 'rooms', room_ref: room.ref });
}

function roomAsks(hosted: Hosted): number {
  return hosted.house.requests.filter((request) => /^\/kit\/(?:door|local-copies)\//.test(request.path)).length + hosted.mcp.length;
}

async function shows(path: string, text: string): Promise<void> {
  await until(async () => ((await readFile(path, 'utf8').catch(() => null)) === text ? true : undefined));
}

function leftOnHouse(...paths: string[]): string {
  return `Left on House, changed since this copy took them: ${paths.join(', ')}. house download --with-attachments brings them, adding --max-size <MB> for one over 10 MB.`;
}

async function staged(routes: RouteOverrides[] = [{}], hosting: Hosting = {}): Promise<{ hosted: Hosted; rooms: Rooms; notes: Room }> {
  const hosted = await hostKit(routes, hosting);
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\ntwo\nthree\n');
  notes.put('plan.md', 'Plant beans\n');
  notes.instructions = INSTRUCTIONS;
  rooms.answered = [notes];
  await rooms.download([notes]);
  return { hosted, rooms, notes };
}

it("makes a conversation's copy from House's state linking each attachment the Room's folder holds unchanged, numbers a second copy of one name, keeps its path through renames and makes it again where a person deleted it", async () => {
  const hosted = await hostKit([{}, { kind: 'claude-agent-acp' }]);
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\n');
  notes.upload('kept.jpg', bytes('kept bytes'));
  notes.upload('changed.jpg', bytes('House bytes'));
  notes.upload('unbrought.jpg', bytes('never downloaded'));
  notes.instructions = INSTRUCTIONS;
  await rooms.download([notes], '--with-attachments');
  await rm(join(notes.repository, 'unbrought.jpg'));
  await writeFile(join(notes.repository, 'changed.jpg'), 'changed here');
  await writeFile(join(notes.repository, 'a.md'), 'changed here\n');
  const copy = copyOf(hosted, 'notes', 'Plan- Q3 - Q4-');

  const session = await opened(hosted, notes, 'Plan: Q3 / Q4.');

  expect(await cwdOf(hosted, 'session/new', 0)).toBe(copy);
  expect(await held(copy)).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md', 'kept.jpg']);
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\n');
  expect(await readFile(join(copy, 'kept.jpg'), 'utf8')).toBe('kept bytes');
  const folders = await inode(join(notes.repository, 'kept.jpg'));
  expect(await inode(join(copy, 'kept.jpg'))).toEqual(folders);
  expect(await readFile(join(copy, 'AGENTS.md'), 'utf8')).toBe(INSTRUCTIONS);
  expect(await readFile(join(copy, 'CLAUDE.md'), 'utf8')).toBe(IMPORTED);
  const manifest = JSON.parse(await readFile(join(copy, '.house'), 'utf8')) as { kit: string[]; files: Record<string, { skipped?: true }> };
  expect(manifest.kit).toEqual(['AGENTS.md', 'CLAUDE.md']);
  expect(Object.keys(manifest.files).sort()).toEqual(['a.md', 'changed.jpg', 'kept.jpg', 'unbrought.jpg']);
  expect([manifest.files['kept.jpg']!.skipped, manifest.files['changed.jpg']!.skipped, manifest.files['unbrought.jpg']!.skipped]).toEqual([undefined, true, true]);
  expect(await readFile(join(notes.repository, 'a.md'), 'utf8')).toBe('changed here\n');

  await opened(hosted, notes, 'Plan: Q3 / Q4.', 'conversation-2', 'agent-2');
  expect(await cwdOf(hosted, 'session/new', 1)).toBe(`${copy} 2`);

  notes.rehandle('notes-2');
  await opened(hosted, notes, 'Renamed');
  expect(await cwdOf(hosted, 'session/new', 2)).toBe(copy);

  hosted.call({ kind: 'kill', conversation_id: 'conversation-1', agent_id: 'agent-1' });
  await hosted.result(lastCall());
  await rm(copy, { recursive: true, force: true });
  said(hosted, '@say again', { provider_session_id: session });

  expect(await cwdOf(hosted, 'session/resume', 0)).toBe(copy);
  expect(await held(copy)).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md', 'kept.jpg']);
  expect(await inode(join(copy, 'kept.jpg'))).toEqual(folders);
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\n');
  expect(await held(join(hosted.workspace, 'conversations'))).toEqual(['notes']);
});

it("asks House nothing before a turn while no notice came, the first turn after the copy's making included, and downloads into a copy no turn runs in at once at a notice that its Room changed, reading the instructions of the copy's Room alone and keeping what the conversation changed", async () => {
  const { hosted, rooms, notes } = await staged();
  const garden = rooms.room('garden');
  garden.put('beds.md', 'Two beds\n');
  rooms.answered = [notes, garden];
  await rooms.download([notes, garden]);
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  await settle();
  let asked = roomAsks(hosted);

  said(hosted, '@gate first-ends');

  expect(await prompt(hosted, 0)).toBe('@gate first-ends');
  expect(roomAsks(hosted)).toBe(asked);
  await writeFile(join(hosted.home, 'first-ends'), '');
  await turned(hosted, 1);
  await settle();
  const read = roomRootReads(hosted).length;

  notes.put('a.md', 'one\ntwo\nthree, from House\n');
  notes.instructions = `${INSTRUCTIONS}Put new tasks on the map.\n`;
  await writeFile(join(copy, 'plan.md'), 'Plant beans and peas\n');
  noticed(hosted, garden);
  await settle();
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\ntwo\nthree\n');
  noticed(hosted, notes);

  await shows(join(copy, 'AGENTS.md'), `${INSTRUCTIONS}Put new tasks on the map.\n`);
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\ntwo\nthree, from House\n');
  expect(await readFile(join(copy, 'plan.md'), 'utf8')).toBe('Plant beans and peas\n');
  expect(roomRootReads(hosted).slice(read)).toEqual(['/rooms/notes']);
  await settle();
  asked = roomAsks(hosted);

  said(hosted, '@gate second-ends');

  expect(await prompt(hosted, 1)).toBe('@gate second-ends');
  expect(roomAsks(hosted)).toBe(asked);
  await writeFile(join(hosted.home, 'second-ends'), '');
});

it("downloads a notice that arrives during a turn into the copy once that turn ends, and runs a turn whose download failed on the copy as it stands, downloading again once that turn ends", async () => {
  const { hosted, rooms, notes } = await staged();
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  said(hosted, '@gate first-ends');
  await prompt(hosted, 0);

  notes.put('a.md', 'one\ntwo\nthree, from House\n');
  noticed(hosted, notes);
  await settle();

  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\ntwo\nthree\n');
  await writeFile(join(hosted.home, 'first-ends'), '');
  await shows(join(copy, 'a.md'), 'one\ntwo\nthree, from House\n');
  await turned(hosted, 1);

  said(hosted, '@gate second-ends');
  await prompt(hosted, 1);
  notes.put('a.md', 'one\n');
  noticed(hosted, notes);
  await settle();
  rooms.reads.push(false);
  said(hosted, '@gate third-ends');
  await writeFile(join(hosted.home, 'second-ends'), '');

  expect(await prompt(hosted, 2)).toBe('@gate third-ends');
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\ntwo\nthree, from House\n');
  await writeFile(join(hosted.home, 'third-ends'), '');
  await shows(join(copy, 'a.md'), 'one\n');
});

it("takes a change of the Environment's rights in the copy's Room at House's notice, and at a notice for the Private Room only rewrites the instructions of every copy", async () => {
  const { hosted, rooms, notes } = await staged();
  const own = rooms.room('private');
  rooms.answered = [notes, own];
  await rooms.download([notes, own]);
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  await settle();
  expect((await entriesOf(copy))['a.md']!.read_only).toBeUndefined();

  notes.write = [];
  noticed(hosted, notes);

  await until(async () => ((await entriesOf(copy))['a.md']!.read_only === true ? true : undefined));
  await settle();
  const asked = roomAsks(hosted);
  const read = roomRootReads(hosted).length;
  notes.instructions = `${INSTRUCTIONS}Your owner rules changed.\n`;
  notes.put('a.md', 'one\n');
  noticed(hosted, own);
  await shows(join(copy, 'AGENTS.md'), `${INSTRUCTIONS}Your owner rules changed.\n`);
  await settle();
  expect(roomRootReads(hosted).slice(read)).toEqual(['/rooms/notes']);
  expect(roomAsks(hosted)).toBe(asked + 1);
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\ntwo\nthree\n');
});

it('downloads into each copy once at a reconnection, which a notice lost to the disconnection leaves owed', async () => {
  const { hosted, notes } = await staged();
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  await settle();

  notes.put('a.md', 'one\ntwo\nthree, from House\n');
  hosted.connection.close(1012, 'deploy');
  await until(() => hosted.house.connections[1]);

  await shows(join(copy, 'a.md'), 'one\ntwo\nthree, from House\n');
});

it("sends a batch left pending in a conversation's copy only by the next upload in that copy, never by another conversation's or the Room folder's", async () => {
  const { hosted, rooms, notes } = await staged([{}, {}]);
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  await opened(hosted, notes, 'Other', 'conversation-2', 'agent-2');
  rooms.writeUnits = 0;

  said(hosted, '@sh echo two >> plan.md');
  await turned(hosted, 1);
  await edited(rooms, 1);
  await settle();
  rooms.writeUnits = Infinity;
  expect(notes.files.get('plan.md')!.content).toBe('Plant beans\n');

  hosted.call({ kind: 'message', conversation_id: 'conversation-2', agent_id: 'agent-2', text: '@say nothing', first: false });
  await turned(hosted, 2);
  expect(await upload(hosted, notes)).toMatchObject({ status: 0, stdout: `Nothing to upload: ${notes.root} matches House.\n` });
  expect(await house(hosted, notes.repository, 'download')).toMatchObject({ status: 0 });
  await settle();
  expect(rooms.edits()).toHaveLength(1);

  said(hosted, '@say again');
  const sent = (await edited(rooms, 2))[1];

  expect(sent!.headers.authorization).toBe('Bearer ahk_held');
  expect(changesOf(sent!)).toEqual([{ op: 'write', path: '/rooms/notes/plan.md', content: 'Plant beans\ntwo\n', base: expect.any(String) }]);
  expect(notes.files.get('plan.md')!.content).toBe('Plant beans\ntwo\n');
  expect(lineOf(await prompt(hosted, 2))).toBe('@say again');
  expect(await readFile(join(copy, 'plan.md'), 'utf8')).toBe('Plant beans\ntwo\n');
});

it("uploads the copy at each turn's end as the conversation's call, brings the merged text back, sends nothing for a turn that changed nothing or a killed one, and holds an update's end and the idle report while it uploads", async () => {
  const { hosted, rooms, notes } = await staged();
  notes.put('old.md', 'old\n');
  await serveRelease(hosted, await released(PLACED));
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');

  said(hosted, "@sh sed -i 's/one/ONE/' a.md && echo new > new.md && rm old.md\n@gate merged");
  await until(async () => ((await readFile(join(copy, 'new.md'), 'utf8').catch(() => '')) === 'new\n' ? true : undefined));
  notes.put('a.md', 'one\ntwo\nTHREE\n');
  await writeFile(join(hosted.home, 'merged'), '');
  const [batch] = await edited(rooms, 1);

  expect(batch!.headers.authorization).toBe('Bearer ahk_held');
  expect(changesOf(batch!)).toEqual([
    { op: 'write', path: '/rooms/notes/a.md', content: 'ONE\ntwo\nthree\n', base: expect.any(String) },
    { op: 'write', path: '/rooms/notes/new.md', content: 'new\n' },
    { op: 'delete', path: '/rooms/notes/old.md', base: expect.any(String) },
  ]);
  expect(notes.files.get('a.md')!.content).toBe('ONE\ntwo\nTHREE\n');
  await until(async () => ((await readFile(join(copy, 'a.md'), 'utf8')) === 'ONE\ntwo\nTHREE\n' ? true : undefined));

  said(hosted, '@say nothing changed');
  await turned(hosted, 2);
  await settle();
  expect(rooms.edits()).toHaveLength(1);

  said(hosted, '@sh echo killed >> plan.md\n@wait');
  await until(async () => ((await readFile(join(copy, 'plan.md'), 'utf8')).includes('killed') ? true : undefined));
  hosted.call({ kind: 'kill', conversation_id: 'conversation-1', agent_id: 'agent-1' });
  await turned(hosted, 3);
  await settle();
  expect(rooms.edits()).toHaveLength(1);

  let release!: () => void;
  const holding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const update = hosted.tools.update!;
  hosted.tools.update = async (args, request) => {
    await holding;
    return update(args, request);
  };
  said(hosted, '@say after the kill');
  await turned(hosted, 4);
  await edited(rooms, 2);
  const idled = hosted.idles.length;
  callUpdate(hosted, 'update-1', PLACED);
  expect(await hosted.result('update-1')).toEqual({});
  await settle();
  expect(hosted.idles).toHaveLength(idled);
  expect(alive(hosted.kit.pid)).toBe(true);

  release();

  expect(await hosted.kit.exited).toBe(1);
  expect(changesOf(rooms.edits()[1]!)).toEqual([{ op: 'write', path: '/rooms/notes/plan.md', content: 'Plant beans\nkilled\n', base: expect.any(String) }]);
});

it("brings back the whole text House merged where its update answer cuts that text with cut beside it", async () => {
  const { hosted, rooms, notes } = await staged();
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  notes.bound = 8;

  said(hosted, "@sh sed -i 's/one/ONE/' a.md\n@gate merged");
  await until(async () => ((await readFile(join(copy, 'a.md'), 'utf8')) === 'ONE\ntwo\nthree\n' ? true : undefined));
  notes.put('a.md', 'one\ntwo\nTHREE\n');
  await writeFile(join(hosted.home, 'merged'), '');
  await edited(rooms, 1);
  const merged = notes.revision('a.md');
  const files = await until(async () => {
    const { files } = (await manifestAt(copy)) as { files: Record<string, { revision: string }> };
    return files['a.md']!.revision === merged ? files : undefined;
  });

  expect(notes.files.get('a.md')!.content).toBe('ONE\ntwo\nTHREE\n');
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('ONE\ntwo\nTHREE\n');
  expect(files['a.md']).toMatchObject({ bytes: 14 });
});

it("ends the next prompt with the Kit's line after a refused upload, naming each file still holding conflict markers or giving the upload's answer, and skips a /command and a prompt after an upload that landed", async () => {
  const { hosted, rooms, notes } = await staged([{}, {}]);
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  await opened(hosted, notes, 'Other', 'conversation-2', 'agent-2');
  const conflict = "Kit: plan.md still holds conflict markers from the upload at your last turn's end; resolve them, and this turn's end uploads again.";

  said(hosted, "@sh sed -i 's/beans/corn/' plan.md\n@gate other-landed");
  await until(async () => ((await readFile(join(copy, 'plan.md'), 'utf8')) === 'Plant corn\n' ? true : undefined));
  hosted.call({ kind: 'message', conversation_id: 'conversation-2', agent_id: 'agent-2', text: "@sh sed -i 's/beans/peas/' plan.md", first: false });
  await edited(rooms, 1);
  await writeFile(join(hosted.home, 'other-landed'), '');
  await edited(rooms, 2);
  await until(async () => ((await readFile(join(copy, 'plan.md'), 'utf8')).includes('<<<<<<<') ? true : undefined));
  await turned(hosted, 2);
  expect(notes.files.get('plan.md')!.content).toBe('Plant peas\n');

  said(hosted, 'carry on', { recent: 'Earlier: the plan' });
  const second = await prompt(hosted, 2);
  expect(second.split('\n').slice(-3)).toEqual(['Earlier: the plan', 'carry on', conflict]);
  await turned(hosted, 3);

  said(hosted, '/compact');
  expect(await prompt(hosted, 3)).toBe('/compact');
  await turned(hosted, 4);
  said(hosted, 'still there');
  expect(lineOf(await prompt(hosted, 4))).toBe(conflict);
  await turned(hosted, 5);

  said(hosted, "@sh printf 'Plant peas and corn\\n' > plan.md");
  await edited(rooms, 3);
  await turned(hosted, 6);
  said(hosted, 'landed');
  expect(await prompt(hosted, 6)).toBe('landed');
  expect(notes.files.get('plan.md')!.content).toBe('Plant peas and corn\n');
  await turned(hosted, 7);

  said(hosted, '@sh mkdir -p capture && echo held > capture/x.md');
  await edited(rooms, 4);
  await turned(hosted, 8);
  said(hosted, 'refused');
  expect(lineOf(await prompt(hosted, 8))).toBe("Kit: the upload at your last turn's end was refused: protected_path: /rooms/notes/capture/x.md is not writable");
});

it("resumes a warm conversation moved since its session opened in the old Room's copy after a Kit restart, and runs the next open in the new Room's copy", async () => {
  const { hosted, rooms, notes } = await staged();
  const garden = rooms.room('garden');
  garden.put('beds.md', 'Two beds\n');
  rooms.answered = [notes, garden];
  const session = await opened(hosted, notes, 'Plan');
  said(hosted, '@say first');
  await turned(hosted, 1);

  await hosted.restart();
  said(hosted, '@say resumed', { provider_session_id: session });

  expect(await cwdOf(hosted, 'session/resume', 0)).toBe(copyOf(hosted, 'notes', 'Plan'));
  await turned(hosted, 2);
  await opened(hosted, garden, 'Plan');
  expect(await cwdOf(hosted, 'session/new', 1)).toBe(copyOf(hosted, 'garden', 'Plan'));
  expect(await readFile(join(copyOf(hosted, 'garden', 'Plan'), 'beds.md'), 'utf8')).toBe('Two beds\n');
});

it("takes the Room's parts from the copy's file for a CLI that reads one and from the block for one that reads neither", async () => {
  const routes = [{}, { kind: 'claude-agent-acp' }, { kind: 'grok-build' }];
  const { hosted, notes } = await staged(routes);
  hosted.tools.shell = () => shelled(OWNER_RULES);
  const house = agentInstructions().join('\n');

  for (const [index] of routes.entries()) {
    const conversation = `conversation-${index + 1}`;
    await opened(hosted, notes, `Plan ${index + 1}`, conversation, `agent-${index + 1}`);
    hosted.call({ kind: 'message', conversation_id: conversation, agent_id: `agent-${index + 1}`, text: '@say hello', first: true });
    await turned(hosted, index + 1);
  }

  expect(await prompt(hosted, 0)).toBe(`${house}\n\nBe useful.\n@say hello`);
  expect(await prompt(hosted, 1)).toBe(`${house}\n\nBe useful.\n@say hello`);
  expect(await prompt(hosted, 2)).toBe(`${house}\n\nBe useful.\n\n${INSTRUCTIONS.trimEnd()}\n@say hello`);
});

it("runs a conversation in a Room held at the Open level in a copy holding the two files alone, one with no Room or in a Room no longer reached in its launch directory with the Owner rules, and drops the two files from a copy whose Room is no longer reached", async () => {
  const { hosted, rooms, notes } = await staged([{}, {}, {}, {}]);
  hosted.tools.shell = () => shelled(OWNER_RULES);
  const garden = rooms.room('garden');
  garden.put('beds.md', 'Two beds\n');
  garden.instructions = INSTRUCTIONS;
  const elsewhere = rooms.room('elsewhere');
  rooms.open = [garden];
  const house = agentInstructions().join('\n');
  const first = (conversation: string, agent: string) =>
    hosted.call({ kind: 'message', conversation_id: conversation, agent_id: agent, text: '@say hello', first: true });

  await opened(hosted, garden, 'Beds', 'conversation-2', 'agent-2');
  expect(await cwdOf(hosted, 'session/new', 0)).toBe(copyOf(hosted, 'garden', 'Beds'));
  expect(await held(copyOf(hosted, 'garden', 'Beds'))).toEqual(['AGENTS.md', 'CLAUDE.md']);

  await opened(hosted, null, 'Loose', 'conversation-3', 'agent-3');
  await opened(hosted, elsewhere, 'Far', 'conversation-4', 'agent-4');
  expect(await cwdOf(hosted, 'session/new', 1)).toBe(hosted.workingDirectory);
  expect(await cwdOf(hosted, 'session/new', 2)).toBe(hosted.workingDirectory);
  first('conversation-3', 'agent-3');
  expect(await prompt(hosted, 0)).toBe(`${house}\n\nBe useful.\n\n${OWNER_RULES.trimEnd()}\n@say hello`);
  await turned(hosted, 1);

  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  expect(await manifestAt(copy)).toMatchObject({ kit: ['AGENTS.md', 'CLAUDE.md'] });
  rooms.answered = [];
  rooms.open = [];
  noticed(hosted, notes);
  said(hosted, '@say unreached');
  await turned(hosted, 2);

  expect(await held(copy)).toEqual(['.house', 'a.md', 'plan.md']);
  expect(await manifestAt(copy)).not.toHaveProperty('kit');
  await rooms.download([]);
  expect(await held(copyOf(hosted, 'garden', 'Beds'))).toEqual([]);
});

it('moves the conversations folder with the workspace and its records, so the next turn runs in the copy at its new path, and refuses a root holding a conversations folder', async () => {
  const { hosted, notes } = await staged();
  const session = await opened(hosted, notes, 'Plan');
  said(hosted, '@say first');
  await turned(hosted, 1);
  const taken = join(await temporaryDirectory(), 'taken');
  await mkdir(join(taken, 'conversations'), { recursive: true });
  const refusal = 'settings-refused';
  hosted.call({ input_id: refusal, conversation_id: null, agent_id: null, provider_session_id: null, kind: 'settings', workspace: taken });
  expect(await hosted.result(refusal)).toEqual({ refused: `${taken} already holds ${join(taken, 'conversations')}` });
  expect(await held(taken)).toEqual(['conversations']);
  const workspace = join(await temporaryDirectory(), 'workspace');
  onTestFinished(() => rm(workspace, { recursive: true, force: true }));

  hosted.call({ input_id: 'settings-move', conversation_id: null, agent_id: null, provider_session_id: null, kind: 'settings', workspace });
  expect(await hosted.kit.exited).toBe(1);
  await hosted.restart();
  said(hosted, '@say moved', { provider_session_id: session });

  const moved = join(workspace, 'conversations', 'notes', 'Plan');
  expect(await cwdOf(hosted, 'session/resume', 0)).toBe(moved);
  expect((await stat(moved)).isDirectory()).toBe(true);
  await absent(join(hosted.workspace, 'conversations'));
  expect(await readFile(join(moved, 'plan.md'), 'utf8')).toBe('Plant beans\n');
  await turned(hosted, 2);
});

it("removes on a deletion's kill a copy whose every file matches its manifest and keeps, naming them, copies holding a changed, a new, a deleted or a conflicted file, each as its download leaves it, while a Conversation kill removes and names nothing", async () => {
  const { hosted, rooms, notes } = await staged([{}, {}, {}, {}, {}, {}]);
  for (const index of [1, 2, 3, 4, 5, 6]) await opened(hosted, notes, `Plan ${index}`, `conversation-${index}`, `agent-${index}`);
  const copy = (index: number) => copyOf(hosted, 'notes', `Plan ${index}`);
  await writeFile(join(copy(2), 'a.md'), 'one\ntwo\nchanged\n');
  await writeFile(join(copy(3), 'new.md'), 'new\n');
  await rm(join(copy(4), 'plan.md'));
  await conflicted(hosted, rooms, 5, 6);
  for (const index of [2, 3, 4, 5]) await house(hosted, copy(index), 'download');
  const kept = await Promise.all([2, 3, 4, 5].map((index) => contents(copy(index))));

  expect(await killed(hosted, 1)).toEqual({});
  expect(await held(copy(1))).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md', 'plan.md']);

  expect(await killed(hosted, 1, true)).toEqual({});
  await absent(copy(1));
  for (const [at, index] of [2, 3, 4, 5].entries()) {
    expect(await killed(hosted, index, true)).toEqual({ kept: [{ room_ref: notes.ref, path: copy(index) }] });
    expect(await contents(copy(index))).toEqual(kept[at]);
  }
});

it('removes or keeps each copy of a conversation in two Rooms by its own state on its deletion, changing nothing outside conversations', async () => {
  const { hosted, rooms, notes } = await staged();
  const garden = rooms.room('garden');
  garden.put('beds.md', 'Two beds\n');
  rooms.answered = [notes, garden];
  await rooms.download([notes, garden]);
  await opened(hosted, notes, 'Plan');
  await opened(hosted, garden, 'Plan');
  await writeFile(join(copyOf(hosted, 'garden', 'Plan'), 'beds.md'), 'Three beds\n');
  const outside = await contents(hosted.workspace, join(hosted.workspace, 'conversations'));

  expect(await killed(hosted, 1, true)).toEqual({ kept: [{ room_ref: garden.ref, path: copyOf(hosted, 'garden', 'Plan') }] });
  await absent(copyOf(hosted, 'notes', 'Plan'));
  expect(await readFile(join(copyOf(hosted, 'garden', 'Plan'), 'beds.md'), 'utf8')).toBe('Three beds\n');
  expect(await contents(hosted.workspace, join(hosted.workspace, 'conversations'))).toEqual(outside);
});

it("removes on a deletion's kill a clean copy of a Room no longer reached and one differing only in a read-only or Kit-marked path, and keeps one whose files match but which holds a pending batch", async () => {
  const { hosted, rooms, notes } = await staged([{}, {}, {}]);
  notes.put('capture/log.md', 'House wrote this\n');
  await rooms.download([notes]);
  for (const index of [1, 2, 3]) await opened(hosted, notes, `Plan ${index}`, `conversation-${index}`, `agent-${index}`);
  const copy = (index: number) => copyOf(hosted, 'notes', `Plan ${index}`);
  await writeFile(join(copy(2), 'capture', 'log.md'), 'changed here\n');
  await rm(join(copy(2), 'AGENTS.md'));
  await pending(hosted, rooms, 3);
  rooms.answered = [];
  await rooms.download([]);

  expect(await killed(hosted, 1, true)).toEqual({});
  await absent(copy(1));
  expect(await killed(hosted, 2, true)).toEqual({});
  await absent(copy(2));
  expect(await killed(hosted, 3, true)).toEqual({ kept: [{ room_ref: notes.ref, path: copy(3) }] });
  expect(await readFile(join(copy(3), 'plan.md'), 'utf8')).toBe('Plant beans\n');
});

it("removes a clean copy idle for 24 hours at the next turn's end, even one ending while another turn runs, and nothing while nothing happens, keeps one used within them and one holding a changed or conflicted file or a pending batch however long idle, notifying nobody, then makes the removed copy again at its path for the next turn, which resumes its session there, while a new conversation of its name takes another path", async () => {
  const clock = await clocked();
  const { hosted, rooms, notes } = await staged([{}, {}, {}, {}, {}, {}, {}], clock.hosting);
  const sessions: string[] = [];
  for (const index of [1, 2, 3, 4, 5, 6]) sessions.push(await opened(hosted, notes, `Plan ${index}`, `conversation-${index}`, `agent-${index}`));
  const copy = (index: number) => copyOf(hosted, 'notes', `Plan ${index}`);
  told(hosted, 1, '@say first');
  await turned(hosted, 1);
  told(hosted, 2, '@say first');
  await turned(hosted, 2);
  await writeFile(join(copy(3), 'a.md'), 'one\ntwo\nchanged\n');
  await pending(hosted, rooms, 4);
  await conflicted(hosted, rooms, 5, 6);
  for (const index of [1, 2, 3, 4, 5, 6]) expect(await killed(hosted, index)).toEqual({});

  await clock.shift(20 * HOUR);
  const turns = ended(hosted).length;
  told(hosted, 2, '@say later', { provider_session_id: sessions[1] });
  expect(await hosted.result(lastCall())).toEqual({});
  await turned(hosted, turns + 1);
  expect(await killed(hosted, 2)).toEqual({});
  await settle();
  expect(await held(copy(1))).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md', 'plan.md']);
  const results = hosted.results.length;
  for (const index of [3, 4, 5]) await house(hosted, copy(index), 'download');
  const kept = await Promise.all([3, 4, 5].map((index) => contents(copy(index))));

  await clock.shift(25 * HOUR);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(await held(copy(1))).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md', 'plan.md']);

  const before = ended(hosted).length;
  const prompts = (await logged(hosted, 'session/prompt')).length;
  told(hosted, 2, '@gate held', { provider_session_id: sessions[1] });
  await prompt(hosted, prompts);
  expect(await held(copy(1))).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md', 'plan.md']);
  told(hosted, 6, '@say again', { provider_session_id: sessions[5] });
  await turned(hosted, before + 1);
  await until(async () => !existsSync(copy(1)));
  expect(ended(hosted)).toHaveLength(before + 1);
  await writeFile(join(hosted.home, 'held'), '');
  await turned(hosted, before + 2);
  await settle();

  expect(await held(copy(2))).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md', 'plan.md']);
  for (const [at, index] of [3, 4, 5].entries()) expect(await contents(copy(index))).toEqual(kept[at]);
  expect(hosted.results.slice(results).filter((one) => JSON.stringify(one.body).includes('"kept"'))).toEqual([]);

  await opened(hosted, notes, 'Plan 1', 'conversation-7', 'agent-7');
  expect(await cwdOf(hosted, 'session/new', 6)).toBe(`${copy(1)} 2`);
  told(hosted, 1, '@say again', { provider_session_id: sessions[0] });

  expect(await cwdOf(hosted, 'session/resume', 3)).toBe(copy(1));
  expect(await held(copy(1))).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md', 'plan.md']);
  expect(await readFile(join(copy(1), 'plan.md'), 'utf8')).toBe('Plant peas\n');
});

it("removes an idle copy at the Kit's start, reporting a Sandbox idle only once that removal has ended, and nothing while the idle report stands and nothing happens", async () => {
  const clock = await clocked();
  const { hosted, rooms, notes } = await staged([{}], { ...clock.hosting, environment: { ...clock.hosting.environment, HOUSE_KIT_SANDBOX: '1' } });
  for (let index = 0; index < 400; index++) notes.put(`notes/${index}.md`, `note ${index}\n`);
  await rooms.download([notes]);
  await opened(hosted, notes, 'Plan');
  const copy = copyOf(hosted, 'notes', 'Plan');
  said(hosted, '@say first');
  await turned(hosted, 1);
  const idled = hosted.idles.length;
  expect(await killed(hosted, 1)).toEqual({});
  await until(() => hosted.idles.length > idled);

  await clock.shift(25 * HOUR);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(existsSync(join(copy, 'notes', '399.md'))).toBe(true);

  const seen: boolean[] = [];
  hosted.house.route('POST', '/kit/kits/report-idle', (request) => {
    seen.push(existsSync(copy));
    hosted.idles.push(request);
    return { body: {} };
  });
  await hosted.restart();

  expect(seen[0]).toBe(false);
});

it('removes an idle copy once the Kit goes idle after a call, and runs the next turn of a conversation whose Kit ended halfway through that removal in a whole copy made again from House, whose turn-end upload deletes nothing', async () => {
  const clock = await clocked();
  const halted = join(await temporaryDirectory(), 'halted-removal');
  const { hosted, rooms, notes } = await staged([{}], { environment: { ...clock.hosting.environment, KIT_HALTED_REMOVAL: halted }, node: [...MOVED_CLOCK, ...HALTED_REMOVAL] });
  const session = await opened(hosted, notes, 'Plan');
  const copy = copyOf(hosted, 'notes', 'Plan');
  said(hosted, '@say first');
  await turned(hosted, 1);
  expect(await killed(hosted, 1)).toEqual({});
  await writeFile(halted, join(copy, 'a.md'));

  await clock.shift(25 * HOUR);
  hosted.call({ kind: 'kill', conversation_id: 'conversation-1', agent_id: 'agent-1' });
  await hosted.kit.exited;
  await absent(join(copy, 'a.md'));
  expect(await readFile(join(copy, 'plan.md'), 'utf8')).toBe('Plant beans\n');
  await hosted.restart();

  said(hosted, '@sh echo again >> plan.md', { provider_session_id: session });
  const [batch] = await edited(rooms, 1);

  expect(await cwdOf(hosted, 'session/resume', 0)).toBe(copy);
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\ntwo\nthree\n');
  expect(changesOf(batch!)).toEqual([{ op: 'write', path: '/rooms/notes/plan.md', content: 'Plant beans\nagain\n', base: expect.any(String) }]);
  expect(notes.files.get('a.md')!.content).toBe('one\ntwo\nthree\n');
});

it("links into a conversation's copy at its making an attachment only another conversation's copy holds unchanged, downloading nothing, and leaves one a folder holds changed or at an older revision, and one no folder holds, its manifest entry with no file", async () => {
  const hosted = await hostKit([{}, {}]);
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\n');
  notes.upload('kept.jpg', bytes('kept bytes'));
  notes.upload('changed.jpg', bytes('House bytes'));
  notes.upload('older.jpg', bytes('older bytes'));
  await rooms.download([notes], '--with-attachments');
  notes.upload('older.jpg', bytes('newer bytes'));
  notes.upload('elsewhere.jpg', bytes('elsewhere bytes'));
  notes.upload('unbrought.jpg', bytes('never downloaded'));
  await writeFile(join(notes.repository, 'changed.jpg'), 'changed here');
  await opened(hosted, notes, 'First');
  const first = copyOf(hosted, 'notes', 'First');
  const wanted = { path: '/rooms/notes/elsewhere.jpg', file: join(first, 'elsewhere.jpg') };
  expect(await house(hosted, first, 'download', JSON.stringify(wanted))).toMatchObject({ status: 0 });
  const fetched = fetchedBytes(hosted);

  await opened(hosted, notes, 'Second', 'conversation-2', 'agent-2');

  const second = copyOf(hosted, 'notes', 'Second');
  expect(await held(second)).toEqual(['.house', 'a.md', 'elsewhere.jpg', 'kept.jpg']);
  expect(await inode(join(second, 'kept.jpg'))).toEqual(await inode(join(notes.repository, 'kept.jpg')));
  expect(await inode(join(second, 'elsewhere.jpg'))).toEqual(await inode(join(first, 'elsewhere.jpg')));
  expect(await readFile(join(second, 'elsewhere.jpg'), 'utf8')).toBe('elsewhere bytes');
  const files = await entriesOf(second);
  expect([files['kept.jpg']!.skipped, files['elsewhere.jpg']!.skipped]).toEqual([undefined, undefined]);
  for (const path of ['changed.jpg', 'older.jpg', 'unbrought.jpg']) {
    expect(files[path]).toEqual({ revision: notes.revision(path), sha256: digest(notes.binaries.get(path)!.bytes), bytes: notes.binaries.get(path)!.bytes.length, skipped: true });
  }
  expect(fetchedBytes(hosted)).toBe(fetched);
});

it('leaves an attachment its manifest entry, copying nothing in its place, where the filesystem refuses the link, and --with-attachments then downloads it', async () => {
  const hosted = await hostKit([{}], { node: REFUSED_LINKS });
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\n');
  notes.upload('photo.jpg', bytes('photo bytes'));
  await rooms.download([notes], '--with-attachments');
  const copy = copyOf(hosted, 'notes', 'Plan');

  await opened(hosted, notes, 'Plan');

  expect(await held(copy)).toEqual(['.house', 'a.md']);
  expect((await entriesOf(copy))['photo.jpg']).toMatchObject({ skipped: true });
  const fetched = fetchedBytes(hosted);
  expect(await house(hosted, copy, 'download', '--with-attachments')).toMatchObject({ status: 0, stdout: `${notes.root}: 1 file updated from House\n` });
  expect(await readFile(join(copy, 'photo.jpg'), 'utf8')).toBe('photo bytes');
  expect(await inode(join(copy, 'photo.jpg'))).not.toEqual(await inode(join(notes.repository, 'photo.jpg')));
  expect(fetchedBytes(hosted)).toBe(fetched + 1);
  expect((await entriesOf(copy))['photo.jpg']).not.toHaveProperty('skipped');
});

it("removes an idle copy holding only linked attachments and manifest entries as one with nothing left to upload, and leaves the Room's folder's file and every other copy's link whole", async () => {
  const clock = await clocked();
  const hosted = await hostKit([{}, {}], clock.hosting);
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\n');
  notes.upload('photo.jpg', bytes('photo bytes'));
  await rooms.download([notes], '--with-attachments');
  notes.upload('far.jpg', bytes('far bytes'));
  const copy = (index: number) => copyOf(hosted, 'notes', `Plan ${index}`);
  for (const index of [1, 2]) await opened(hosted, notes, `Plan ${index}`, `conversation-${index}`, `agent-${index}`);
  expect((await stat(join(notes.repository, 'photo.jpg'))).nlink).toBe(3);
  expect(await killed(hosted, 1)).toEqual({});
  const results = hosted.results.length;

  await clock.shift(25 * HOUR);
  told(hosted, 2, '@say later');
  await turned(hosted, 1);
  await until(async () => !existsSync(copy(1)));

  expect(await readFile(join(notes.repository, 'photo.jpg'), 'utf8')).toBe('photo bytes');
  expect(await readFile(join(copy(2), 'photo.jpg'), 'utf8')).toBe('photo bytes');
  expect(await inode(join(copy(2), 'photo.jpg'))).toEqual(await inode(join(notes.repository, 'photo.jpg')));
  expect((await stat(join(notes.repository, 'photo.jpg'))).nlink).toBe(2);
  expect(hosted.results.slice(results).filter((one) => JSON.stringify(one.body).includes('"kept"'))).toEqual([]);
});

it("removes a copy whose linked attachment another folder wrote in place and uploaded, on its conversation's deletion and when idle, after its download and notifying nobody, and keeps one holding a change of its own", async () => {
  const clock = await clocked();
  const hosted = await hostKit([{}, {}, {}], clock.hosting);
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\n');
  notes.upload('photo.jpg', bytes('photo bytes'));
  await rooms.download([notes], '--with-attachments');
  const copy = (index: number) => copyOf(hosted, 'notes', `Plan ${index}`);
  for (const index of [1, 2, 3]) await opened(hosted, notes, `Plan ${index}`, `conversation-${index}`, `agent-${index}`);
  await replaced(join(copy(3), 'photo.jpg'), bytes('own bytes'));
  await writeFile(join(notes.repository, 'photo.jpg'), 'written in place');
  expect(await readFile(join(copy(1), 'photo.jpg'), 'utf8')).toBe('written in place');
  expect(await upload(hosted, notes)).toMatchObject({ status: 0, stdout: `House accepted 1 file of ${notes.root}.\n` });
  const results = hosted.results.length;

  expect(await killed(hosted, 1, true)).toEqual({});
  await absent(copy(1));
  expect(await killed(hosted, 3, true)).toEqual({ kept: [{ room_ref: notes.ref, path: copy(3) }] });
  expect(await readFile(join(copy(3), 'photo.jpg'), 'utf8')).toBe('own bytes');
  expect(await killed(hosted, 2)).toEqual({});
  await clock.shift(25 * HOUR);
  await hosted.restart();
  await until(async () => !existsSync(copy(2)));

  expect(hosted.results.slice(results).filter((one) => JSON.stringify(one.body).includes('"kept"'))).toHaveLength(1);
  expect(await readFile(join(notes.repository, 'photo.jpg'), 'utf8')).toBe('written in place');
});

it("keeps House's bytes in every other folder when a copy replaces a linked attachment, by a file renamed over it or by a delete and a write, or a person replaces it in the Room's folder, and when a download in the Room's folder brings a new revision, moves or removes one", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\n');
  for (const name of ['renamed', 'rewritten', 'brought', 'moved', 'removed', 'replaced']) notes.upload(`${name}.jpg`, bytes(`${name} bytes`));
  await rooms.download([notes], '--with-attachments');
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  for (const name of ['renamed', 'rewritten', 'brought', 'moved', 'removed', 'replaced']) {
    expect(await inode(join(copy, `${name}.jpg`))).toEqual(await inode(join(notes.repository, `${name}.jpg`)));
  }
  const revisions = Object.fromEntries(['renamed', 'rewritten', 'brought'].map((name) => [name, notes.revision(`${name}.jpg`)]));
  await replaced(join(copy, 'renamed.jpg'), bytes('renamed here'));
  await rm(join(copy, 'rewritten.jpg'));
  await writeFile(join(copy, 'rewritten.jpg'), 'rewritten here');

  expect(await house(hosted, copy, 'upload')).toMatchObject({ status: 0, stdout: `House accepted 2 files of ${notes.root}.\n` });

  expect(notes.batches.at(-1)).toEqual([
    { op: 'upload', path: '/rooms/notes/renamed.jpg', base: revisions.renamed, bytes: 12, sha256: digest('renamed here'), media_type: 'image/jpeg' },
    { op: 'upload', path: '/rooms/notes/rewritten.jpg', base: revisions.rewritten, bytes: 14, sha256: digest('rewritten here'), media_type: 'image/jpeg' },
  ]);
  expect(await readFile(join(notes.repository, 'renamed.jpg'), 'utf8')).toBe('renamed bytes');
  expect(await readFile(join(notes.repository, 'rewritten.jpg'), 'utf8')).toBe('rewritten bytes');

  await replaced(join(notes.repository, 'replaced.jpg'), bytes('replaced here'));
  notes.upload('brought.jpg', bytes('brought, from House'));
  notes.move('moved.jpg', 'archive/moved.jpg');
  notes.remove('removed.jpg');
  expect((await rooms.download([notes], '--with-attachments')).status).toBe(0);

  expect(await readFile(join(notes.repository, 'brought.jpg'), 'utf8')).toBe('brought, from House');
  expect(await readFile(join(notes.repository, 'archive/moved.jpg'), 'utf8')).toBe('moved bytes');
  expect(existsSync(join(notes.repository, 'removed.jpg'))).toBe(false);
  expect(await readFile(join(notes.repository, 'replaced.jpg'), 'utf8')).toBe('replaced here');
  for (const name of ['brought', 'moved', 'removed', 'replaced']) expect(await readFile(join(copy, `${name}.jpg`), 'utf8')).toBe(`${name} bytes`);
  expect((await entriesOf(copy))['brought.jpg']).toEqual({ revision: revisions.brought, sha256: digest('brought bytes'), bytes: 13 });
});

it("links a held attachment another writer changed at its new revision from a folder holding it, and otherwise removes its unchanged file, records the revision and names it, downloading nothing, keeps one changed here, and does the same with a read-only one whatever its file holds", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\n');
  for (const path of ['photo.jpg', 'cover.jpg', 'mine.jpg', 'capture/linked.jpg', 'capture/left.jpg']) notes.upload(path, bytes(`${path} bytes`));
  await rooms.download([notes], '--with-attachments');
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  await replaced(join(copy, 'photo.jpg'), bytes('photo, drawn here'));
  expect(await house(hosted, copy, 'upload')).toMatchObject({ status: 0, stdout: `House accepted 1 file of ${notes.root}.\n` });
  notes.upload('capture/linked.jpg', bytes('capture/linked.jpg, from House'));
  const wanted = { path: '/rooms/notes/capture/linked.jpg', file: join(copy, 'capture/linked.jpg') };
  expect(await house(hosted, copy, 'download', JSON.stringify(wanted))).toMatchObject({ status: 0 });
  expect(await house(hosted, copy, 'download')).toMatchObject({ status: 0 });
  for (const path of ['cover.jpg', 'mine.jpg', 'capture/left.jpg']) notes.upload(path, bytes(`${path}, from House`));
  await replaced(join(notes.repository, 'mine.jpg'), bytes('mine, drawn here'));
  await replaced(join(notes.repository, 'capture/linked.jpg'), bytes('scribbled here'));
  await replaced(join(notes.repository, 'capture/left.jpg'), bytes('scribbled here too'));
  const fetched = fetchedBytes(hosted);

  expect(await house(hosted, '/', 'download')).toEqual({
    status: 0,
    stdout: [
      `${notes.root}: 2 files updated from House`,
      `${notes.root}/mine.jpg: changed here, so House's change was not brought; the next house upload merges it`,
      leftOnHouse(`${notes.root}/capture/left.jpg`, `${notes.root}/cover.jpg`),
      '',
    ].join('\n'),
    stderr: '',
  });

  expect(await inode(join(notes.repository, 'photo.jpg'))).toEqual(await inode(join(copy, 'photo.jpg')));
  expect(await inode(join(notes.repository, 'capture/linked.jpg'))).toEqual(await inode(join(copy, 'capture/linked.jpg')));
  expect(await readFile(join(notes.repository, 'capture/linked.jpg'), 'utf8')).toBe('capture/linked.jpg, from House');
  expect(existsSync(join(notes.repository, 'cover.jpg'))).toBe(false);
  expect(existsSync(join(notes.repository, 'capture/left.jpg'))).toBe(false);
  expect(await readFile(join(notes.repository, 'mine.jpg'), 'utf8')).toBe('mine, drawn here');
  expect(fetchedBytes(hosted)).toBe(fetched);
  const { files } = await manifestOf(notes);
  expect(files['cover.jpg']).toEqual({ revision: notes.revision('cover.jpg'), sha256: digest('cover.jpg, from House'), bytes: 21, skipped: true });
  expect(files['capture/left.jpg']).toEqual({ revision: notes.revision('capture/left.jpg'), sha256: digest('capture/left.jpg, from House'), bytes: 28, read_only: true, skipped: true });
  expect(files['photo.jpg']).toEqual({ revision: notes.revision('photo.jpg'), sha256: digest('photo, drawn here'), bytes: 17 });
});

it("with --with-attachments links what a folder holds unchanged and downloads the rest up to --max-size, brings a held attachment's new revision within it and leaves one over it an entry though a folder holds it, and a one-file download at a skipped attachment's own path, a read-only one's too, is held after the next download", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\n');
  notes.upload('small.jpg', bytes('small bytes'));
  notes.upload('big.bin', Buffer.alloc(MEGABYTE_AND_ONE, 1));
  await rooms.download([notes], '--with-attachments', '--max-size', '3');
  notes.upload('extra.jpg', bytes('extra bytes'));
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  expect(await held(copy)).toEqual(['.house', 'a.md', 'big.bin', 'small.jpg']);
  notes.upload('small.jpg', bytes('small, from House'));
  notes.upload('big.bin', Buffer.alloc(MEGABYTE_AND_ONE, 2));
  await rooms.download([notes], '--with-attachments', '--max-size', '3');
  notes.upload('far.jpg', bytes('far bytes'));
  const fetched = fetchedBytes(hosted);

  expect(await house(hosted, copy, 'download', '--with-attachments', '--max-size', '1')).toEqual({
    status: 0,
    stdout: `${notes.root}: 3 files updated from House\n${leftOnHouse(`${notes.root}/big.bin`)}\n`,
    stderr: '',
  });

  expect(await held(copy)).toEqual(['.house', 'a.md', 'extra.jpg', 'far.jpg', 'small.jpg']);
  expect(await inode(join(copy, 'small.jpg'))).toEqual(await inode(join(notes.repository, 'small.jpg')));
  expect(await inode(join(copy, 'extra.jpg'))).toEqual(await inode(join(notes.repository, 'extra.jpg')));
  expect(await readFile(join(copy, 'far.jpg'), 'utf8')).toBe('far bytes');
  expect(fetchedBytes(hosted)).toBe(fetched + 1);
  expect((await entriesOf(copy))['big.bin']).toEqual({ revision: notes.revision('big.bin'), sha256: digest(Buffer.alloc(MEGABYTE_AND_ONE, 2)), bytes: MEGABYTE_AND_ONE, skipped: true });

  const wanted = { path: '/rooms/notes/big.bin', file: join(copy, 'big.bin') };
  expect(await house(hosted, copy, 'download', JSON.stringify(wanted))).toMatchObject({ status: 0 });
  expect(await house(hosted, copy, 'download')).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });
  expect((await entriesOf(copy))['big.bin']).not.toHaveProperty('skipped');
  const sent = notes.batches.length;
  expect(await house(hosted, copy, 'upload')).toMatchObject({ status: 0, stdout: `Nothing to upload: ${notes.root} matches House.\n` });
  expect(notes.batches).toHaveLength(sent);

  notes.upload('capture/shot.jpg', bytes('shot bytes'));
  expect(await house(hosted, copy, 'download')).toMatchObject({ status: 0 });
  expect((await entriesOf(copy))['capture/shot.jpg']).toMatchObject({ read_only: true, skipped: true });
  const shot = { path: '/rooms/notes/capture/shot.jpg', file: join(copy, 'capture/shot.jpg') };
  expect(await house(hosted, copy, 'download', JSON.stringify(shot))).toMatchObject({ status: 0 });
  expect(await house(hosted, copy, 'download')).toMatchObject({ status: 0, stdout: 'Nothing new from House.\n' });
  expect((await entriesOf(copy))['capture/shot.jpg']).not.toHaveProperty('skipped');
  notes.upload('capture/shot.jpg', bytes('shot, from House'));

  expect(await house(hosted, copy, 'download')).toEqual({ status: 0, stdout: `${leftOnHouse(`${notes.root}/capture/shot.jpg`)}\n`, stderr: '' });

  expect(existsSync(join(copy, 'capture/shot.jpg'))).toBe(false);
  expect((await entriesOf(copy))['capture/shot.jpg']).toEqual({ revision: notes.revision('capture/shot.jpg'), sha256: digest('shot, from House'), bytes: 16, read_only: true, skipped: true });
});

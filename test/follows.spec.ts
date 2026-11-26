import { CONVERSATION_META_KEY } from '@agentshouse/kit-wire';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { settle, until, type Received } from './double.ts';
import { hostKit, lastCall, type Hosted, type Hosting, type RouteOverrides } from './environment.ts';
import { alive, stop, temporaryDirectory } from './kit.ts';
import { callUpdate, released, serveRelease } from './release.ts';
import { house, serveRooms, upload, type Room, type Rooms } from './rooms.ts';

const PLACED = '0.2.1-c000000000002';
const PROTECTED = 'protected_path: /rooms/notes/capture/x.md is not writable';
const LIMITED = "limit_reached: you reached today's Write limit; try again at 2026-11-17T00:00:00.000Z";
const MARKDOWN = 'it is Markdown, which holds text only: UTF-8 without NUL, at most 1000000 bytes';
const LOST_WATCH = ['--import', fileURLToPath(new URL('./lost-watch.ts', import.meta.url))];
const QUIET_MS = 3_000;
// Four seconds outlast the three a save waits after the last change, so a save nothing started has not come by then.
const NO_SAVE_MS = 4_000;
// A save of what the first fifteen seconds wrote comes within three more, so twenty seconds see it on a loaded runner.
const SAVED_MS = 20_000;

type Copy = { kind: 'new' } | { kind: 'existing'; path: string };

interface Staged {
  hosted: Hosted;
  rooms: Rooms;
  notes: Room;
  arrivals: number[];
}

async function staged(routes: RouteOverrides[] = [{}], hosting: Hosting = {}): Promise<Staged> {
  const hosted = await hostKit(routes, hosting);
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('plan.md', 'Plant beans\n');
  notes.put('a.md', 'one\ntwo\nthree\n');
  rooms.answered = [notes];
  await rooms.download([notes]);
  const arrivals: number[] = [];
  rooms.beforeEdit = () => arrivals.push(Date.now());
  return { hosted, rooms, notes, arrivals };
}

function copyOf(hosted: Hosted, name: string): string {
  return join(hosted.workspace, 'conversations', 'notes', name);
}

async function opened(hosted: Hosted, index: number, room: Room, name: string, copy?: Copy): Promise<void> {
  const run = copy === undefined ? {} : { run: { name, copy, repository: null } };
  hosted.call({ kind: 'open', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, room_ref: room.ref, name, ...run });
  const answer = (await hosted.result(lastCall())) as { provider_session_id?: string; refused?: string };
  if (answer.provider_session_id === undefined) throw new Error(`the open was refused: ${answer.refused}`);
}

function told(hosted: Hosted, index: number, text: string): void {
  hosted.call({ kind: 'message', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, text, first: false });
}

function ended(hosted: Hosted): Received[] {
  return hosted.turns.filter((turn) => turn.path === '/kit/turns/end');
}

function doorSaves(hosted: Hosted): Received[] {
  return hosted.house.requests.filter((request) => request.path === '/kit/door/update');
}

function changesOf(received: Received): unknown {
  const body = received.body as { changes?: unknown; params?: { arguments: { changes: unknown } } };
  return body.changes ?? body.params!.arguments.changes;
}

function labelOf(received: Received): string | undefined {
  return (received.body as { params: { _meta: Record<string, string> } }).params._meta[CONVERSATION_META_KEY];
}

function savedBy(rooms: Rooms, conversation: string): Received[] {
  return rooms.edits().filter((received) => labelOf(received) === conversation);
}

function noticed(hosted: Hosted, room: Room): void {
  hosted.house.connections.at(-1)!.send({ type: 'work_available', subject: 'rooms', room_ref: room.ref });
}

async function shows(path: string, text: string): Promise<void> {
  await until(async () => ((await readFile(path, 'utf8').catch(() => null)) === text ? true : undefined));
}

async function quiet(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function outside(hosted: Hosted): unknown[] {
  return hosted.unsaved.filter((received) => received.path === '/kit/local-copies/not-saved/report').map((received) => received.body);
}

function turnReports(hosted: Hosted): Received[] {
  return hosted.unsaved.filter((received) => received.path === '/kit/turns/not-saved/report');
}

async function recordOf(hosted: Hosted, room: Room): Promise<{ refused?: Record<string, string>; pending?: unknown }> {
  return JSON.parse(await readFile(join(hosted.home, 'local-copies/rooms', `${room.ref}.json`), 'utf8')) as { refused?: Record<string, string>; pending?: unknown };
}

it("saves a write in a Room's folder, in a conversation's copy and in a Run's copy as one batch 3 seconds after the last change, while each turn runs and under each conversation's label", { timeout: 60_000 }, async () => {
  const { hosted, rooms, notes, arrivals } = await staged([{}, {}]);
  await opened(hosted, 1, notes, 'Plan');
  await opened(hosted, 2, notes, 'imp-1', { kind: 'new' });
  await settle();

  await writeFile(join(notes.repository, 'first.md'), 'first\n');
  await quiet(1_500);
  await writeFile(join(notes.repository, 'second.md'), 'second\n');
  const written = Date.now();
  const [room] = await until(() => (doorSaves(hosted).length === 1 ? doorSaves(hosted) : undefined), SAVED_MS);

  expect(arrivals.at(-1)! - written).toBeGreaterThanOrEqual(QUIET_MS);
  expect(changesOf(room!)).toEqual([
    { op: 'write', path: '/rooms/notes/first.md', content: 'first\n' },
    { op: 'write', path: '/rooms/notes/second.md', content: 'second\n' },
  ]);

  told(hosted, 1, '@sh echo one > one.md && sleep 1 && echo two > two.md\n@gate plan-done');
  told(hosted, 2, '@sh echo imp > imp.md\n@gate imp-done');
  const [plan] = await until(() => (savedBy(rooms, 'conversation-1').length === 1 ? savedBy(rooms, 'conversation-1') : undefined), SAVED_MS);
  const [imp] = await until(() => (savedBy(rooms, 'conversation-2').length === 1 ? savedBy(rooms, 'conversation-2') : undefined), SAVED_MS);

  expect(ended(hosted)).toHaveLength(0);
  expect(changesOf(plan!)).toEqual([
    { op: 'write', path: '/rooms/notes/one.md', content: 'one\n' },
    { op: 'write', path: '/rooms/notes/two.md', content: 'two\n' },
  ]);
  expect(changesOf(imp!)).toEqual([{ op: 'write', path: '/rooms/notes/imp.md', content: 'imp\n' }]);
  expect(notes.files.get('imp.md')!.content).toBe('imp\n');
});

it("starts no save at a turn's end, for a file Kit itself wrote, in a skills folder or in a folder below the top holding a .git", { timeout: 60_000 }, async () => {
  const { hosted, rooms, notes } = await staged();
  await opened(hosted, 1, notes, 'Plan');
  const copy = copyOf(hosted, 'Plan');
  await settle();

  told(hosted, 1, '@say nothing written');
  await until(() => ended(hosted)[0]);
  notes.put('plan.md', 'Plant corn\n');
  noticed(hosted, notes);
  await shows(join(notes.repository, 'plan.md'), 'Plant corn\n');
  await shows(join(copy, 'plan.md'), 'Plant corn\n');
  for (const folder of [notes.repository, copy]) {
    await mkdir(join(folder, '.claude', 'skills', 'mine'), { recursive: true });
    await writeFile(join(folder, '.claude', 'skills', 'mine', 'SKILL.md'), 'mine\n');
    await mkdir(join(folder, 'code', '.git'), { recursive: true });
    await writeFile(join(folder, 'code', 'notes.md'), 'code\n');
  }
  await quiet(NO_SAVE_MS);

  expect(doorSaves(hosted)).toEqual([]);
  expect(rooms.edits()).toEqual([]);
});

it('sends a refused file again only with the next change, and the whole set a refusal naming no file kept at the time House named and at the next change', { timeout: 60_000 }, async () => {
  const { hosted, rooms, notes } = await staged();
  await mkdir(join(notes.repository, 'capture'));
  await writeFile(join(notes.repository, 'capture', 'x.md'), 'held\n');
  await writeFile(join(notes.repository, 'plan.md'), 'Plant beans\nand peas\n');
  await until(() => (doorSaves(hosted).length === 2 ? true : undefined), SAVED_MS);
  const held = { op: 'write', path: '/rooms/notes/capture/x.md', content: 'held\n' };
  expect(doorSaves(hosted).map(changesOf)).toEqual([[held, { op: 'write', path: '/rooms/notes/plan.md', content: 'Plant beans\nand peas\n', base: expect.any(String) }], [expect.objectContaining({ path: '/rooms/notes/plan.md' })]]);
  expect(await recordOf(hosted, notes)).toMatchObject({ refused: { 'capture/x.md': PROTECTED } });

  await quiet(NO_SAVE_MS);
  expect(doorSaves(hosted)).toHaveLength(2);

  await writeFile(join(notes.repository, 'a.md'), 'one\n');
  await until(() => (doorSaves(hosted).length === 4 ? true : undefined), SAVED_MS);
  expect(doorSaves(hosted).slice(2).map(changesOf)).toEqual([[expect.objectContaining({ path: '/rooms/notes/a.md' }), held], [expect.objectContaining({ path: '/rooms/notes/a.md' })]]);

  rooms.writeUnits = 0;
  rooms.retryAfter = 3;
  await rm(join(notes.repository, 'capture'), { recursive: true });
  await writeFile(join(notes.repository, 'b.md'), 'b\n');
  await until(async () => ((await recordOf(hosted, notes)).refused?.['b.md'] === LIMITED ? true : undefined), SAVED_MS);
  expect(doorSaves(hosted)).toHaveLength(5);
  rooms.writeUnits = Infinity;

  await until(async () => ((await recordOf(hosted, notes)).refused === undefined ? true : undefined), SAVED_MS);
  expect(notes.files.get('b.md')!.content).toBe('b\n');
  expect(doorSaves(hosted)).toHaveLength(6);
});

it("sends a batch that did not reach House again unchanged before newer changes at the next connection, and a conversation's copy limited at the time House named", { timeout: 60_000 }, async () => {
  const { hosted, rooms, notes } = await staged();
  await opened(hosted, 1, notes, 'Plan');
  const copy = copyOf(hosted, 'Plan');
  await settle();
  rooms.dropping = 1;
  await writeFile(join(notes.repository, 'plan.md'), 'Plant beans\nfirst\n');
  await until(() => (doorSaves(hosted).length === 1 ? true : undefined), SAVED_MS);
  const [lost] = doorSaves(hosted);
  expect(await recordOf(hosted, notes)).toMatchObject({ pending: { operation_id: (lost!.body as { operation_id: string }).operation_id } });

  await hosted.restart();
  const [, again] = await until(() => (doorSaves(hosted).length === 2 ? doorSaves(hosted) : undefined), SAVED_MS);
  expect((again!.body as { operation_id: string }).operation_id).toBe((lost!.body as { operation_id: string }).operation_id);
  expect(changesOf(again!)).toEqual(changesOf(lost!));
  expect(notes.files.get('plan.md')!.content).toBe('Plant beans\nfirst\n');
  await until(async () => ((await recordOf(hosted, notes)).pending === undefined ? true : undefined));

  rooms.writeUnits = 0;
  rooms.retryAfter = 3;
  await writeFile(join(copy, 'a.md'), 'one\ntwo\n');
  await until(() => (savedBy(rooms, 'conversation-1').length === 1 ? true : undefined), SAVED_MS);
  rooms.writeUnits = Infinity;
  await until(() => (notes.files.get('a.md')?.content === 'one\ntwo\n' ? true : undefined), SAVED_MS);
  expect(savedBy(rooms, 'conversation-1')).toHaveLength(2);
});

it("lands a notice at once in a clean file of a copy while its turn runs, leaves a file changed there for the save to merge three ways and a folder holding a .git as it is", { timeout: 60_000 }, async () => {
  const { hosted, rooms, notes } = await staged();
  notes.put('code/notes.md', 'House code\n');
  noticed(hosted, notes);
  await opened(hosted, 1, notes, 'Plan');
  const copy = copyOf(hosted, 'Plan');
  await settle();
  told(hosted, 1, "@sh sed -i 's/one/ONE/' a.md && mkdir -p code/.git && echo mine > code/notes.md\n@gate plan-done");
  await shows(join(copy, 'a.md'), 'ONE\ntwo\nthree\n');

  notes.put('a.md', 'one\ntwo\nTHREE\n');
  notes.put('plan.md', 'Plant corn\n');
  notes.put('code/notes.md', 'House code, changed\n');
  noticed(hosted, notes);
  await shows(join(copy, 'plan.md'), 'Plant corn\n');

  expect(ended(hosted)).toHaveLength(0);
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toMatch(/^ONE\ntwo\n/);
  expect(await readFile(join(copy, 'code', 'notes.md'), 'utf8')).toBe('mine\n');
  await until(() => (notes.files.get('a.md')?.content === 'ONE\ntwo\nTHREE\n' ? true : undefined), SAVED_MS);
  await shows(join(copy, 'a.md'), 'ONE\ntwo\nTHREE\n');
  expect(notes.files.get('code/notes.md')!.content).toBe('House code, changed\n');
});

it('downloads every folder at each connection and then saves what differs, sends nothing from a folder whose manifest is gone and makes it again, and walks a folder whose watch was lost', { timeout: 60_000 }, async () => {
  const signals = await temporaryDirectory();
  const deaf = join(signals, 'deaf');
  const lost = join(signals, 'lost');
  const { hosted, rooms, notes } = await staged([{}], { node: LOST_WATCH, environment: { KIT_DEAF_WATCH: deaf, KIT_LOST_WATCH: lost } });
  const requests = hosted.house.requests;
  stop(hosted.kit.pid);
  await hosted.kit.exited;
  notes.put('plan.md', 'Plant corn\n');
  await writeFile(join(notes.repository, 'a.md'), 'one\ntwo\nthree\nfour\n');
  const from = requests.length;
  await hosted.restart();
  await until(() => notes.files.get('a.md')?.content === 'one\ntwo\nthree\nfour\n', SAVED_MS);
  const read = requests.slice(from).findIndex((request) => request.path === '/kit/door/changes/enumerate');
  const sent = requests.slice(from).findIndex((request) => request.path === '/kit/door/update');
  expect(read).toBeGreaterThanOrEqual(0);
  expect(sent).toBeGreaterThan(read);
  expect(await readFile(join(notes.repository, 'plan.md'), 'utf8')).toBe('Plant corn\n');

  const saves = doorSaves(hosted).length;
  await rm(join(notes.repository, '.house'));
  await writeFile(join(notes.repository, 'plan.md'), 'gone\n');
  await quiet(NO_SAVE_MS);
  expect(doorSaves(hosted)).toHaveLength(saves);
  noticed(hosted, notes);
  await until(async () => ((await readFile(join(notes.repository, '.house'), 'utf8').catch(() => null)) === null ? undefined : true));
  expect(await readFile(join(notes.repository, 'plan.md'), 'utf8')).toBe('Plant corn\n');
  expect(await readFile(join(`${notes.repository} (kept)`, 'plan.md'), 'utf8')).toBe('gone\n');

  await writeFile(deaf, '');
  await writeFile(join(notes.repository, 'plan.md'), 'Plant corn\nunseen\n');
  await quiet(NO_SAVE_MS);
  expect(doorSaves(hosted)).toHaveLength(saves);
  await rm(deaf);
  await writeFile(lost, '');
  await until(() => notes.files.get('plan.md')?.content === 'Plant corn\nunseen\n', SAVED_MS);
  expect(doorSaves(hosted)).toHaveLength(saves + 1);
  expect(rooms.edits()).toEqual([]);
});

it('watches and saves every followed folder after a connection whose downloads House refused', { timeout: 60_000 }, async () => {
  const { hosted, rooms, notes } = await staged();
  stop(hosted.kit.pid);
  await hosted.kit.exited;
  let refusing = true;
  hosted.house.route('POST', '/kit/local-copies/selection/read', () => {
    if (!refusing) return { body: { local_copy: { rooms: rooms.answered.map((room) => ({ room_ref: room.ref, room_handle: room.handle, level: 'keep' })) } } };
    refusing = false;
    return { status: 503, body: { error: { code: 'house_unavailable', message: 'house_unavailable: House is unavailable; call again shortly', retryable: true } } };
  });
  await writeFile(join(notes.repository, 'a.md'), 'one\ntwo\nthree, while the Kit was down\n');
  await hosted.restart();

  await until(() => notes.files.get('a.md')?.content === 'one\ntwo\nthree, while the Kit was down\n', SAVED_MS);
  await writeFile(join(notes.repository, 'b.md'), 'b\n');
  await until(() => notes.files.get('b.md'), SAVED_MS);
  expect(refusing).toBe(false);
});

it("holds an update's end and the Sandbox idle report while a save of the folder a process works in is due or runs, and not for a refused file alone", { timeout: 60_000 }, async () => {
  const { hosted, rooms, notes } = await staged();
  await serveRelease(hosted, await released(PLACED));
  await opened(hosted, 1, notes, 'Plan');
  const copy = copyOf(hosted, 'Plan');
  await settle();
  const before = hosted.idles.length;

  told(hosted, 1, '@sh mkdir -p capture && echo held > capture/x.md');
  await until(() => turnReports(hosted)[0], SAVED_MS);
  await until(() => (hosted.idles.length > before ? true : undefined));
  let release!: () => void;
  const holding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const update = hosted.tools.update!;
  hosted.tools.update = async (args, request) => {
    await holding;
    return update(args, request);
  };
  const idled = hosted.idles.length;
  await writeFile(join(copy, 'plan.md'), 'Plant beans\nagain\n');
  await settle();
  callUpdate(hosted, 'update-1', PLACED);
  expect(await hosted.result('update-1')).toEqual({});
  await until(() => (rooms.edits().length === 2 ? true : undefined), SAVED_MS);
  await settle();
  expect(hosted.idles).toHaveLength(idled);
  expect(alive(hosted.kit.pid)).toBe(true);

  release();

  expect(await hosted.kit.exited).toBe(1);
  expect(notes.files.get('plan.md')!.content).toBe('Plant beans\nagain\n');
});

it("sends a turn's report once the copy's due save ends, and the report outside a turn of a file a save of a Room's folder or a deleted conversation's copy leaves refused once for each reason", { timeout: 60_000 }, async () => {
  const { hosted, rooms, notes } = await staged();
  await opened(hosted, 1, notes, 'Plan');
  const copy = copyOf(hosted, 'Plan');
  await settle();

  told(hosted, 1, '@sh mkdir -p capture && echo held > capture/x.md');
  await until(() => ended(hosted)[0]);
  const [report] = await until(() => (turnReports(hosted).length === 1 ? turnReports(hosted) : undefined), SAVED_MS);
  expect(rooms.edits()).toHaveLength(1);
  expect(report!.body).toMatchObject({ files: [{ path: '/rooms/notes/capture/x.md', refused: PROTECTED }] });

  await mkdir(join(notes.repository, 'capture'));
  await writeFile(join(notes.repository, 'capture', 'x.md'), 'held\n');
  await until(() => outside(hosted)[0], SAVED_MS);
  await writeFile(join(notes.repository, 'plan.md'), 'Plant beans\nmore\n');
  await until(() => notes.files.get('plan.md')?.content === 'Plant beans\nmore\n', SAVED_MS);
  await writeFile(join(notes.repository, 'capture', 'x.md'), Buffer.from([0xff, 0xfe, 0x00]));
  await until(() => outside(hosted)[1], SAVED_MS);

  hosted.call({ kind: 'kill', conversation_id: 'conversation-1', agent_id: 'agent-1', deleted: true });
  expect(await hosted.result(lastCall())).toEqual({ kept: [{ room_ref: notes.ref, path: copy }] });
  await writeFile(join(copy, 'capture', 'x.md'), 'held, again\n');
  await until(() => outside(hosted)[2], SAVED_MS);
  await quiet(NO_SAVE_MS);

  expect(outside(hosted)).toEqual([
    { room_ref: notes.ref, path: '/rooms/notes/capture/x.md', refused: PROTECTED },
    { room_ref: notes.ref, path: '/rooms/notes/capture/x.md', refused: MARKDOWN },
    { room_ref: notes.ref, path: '/rooms/notes/capture/x.md', refused: PROTECTED },
  ]);
  expect(turnReports(hosted)).toHaveLength(1);
});

it("refuses house upload on a marker line, answers house download that the next save merges a file changed here, and names the next save on an update answer, naming no command", { timeout: 60_000 }, async () => {
  const { hosted, rooms, notes } = await staged();
  notes.put('plan.md', 'Plant beans\nTHEIRS\n');
  await writeFile(join(notes.repository, 'plan.md'), 'Plant beans\nmine\n');
  await until(async () => ((await readFile(join(notes.repository, 'plan.md'), 'utf8')).includes('<<<<<<<') ? true : undefined), SAVED_MS);

  expect(await upload(hosted, notes)).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: /rooms/notes/plan.md still holds conflict markers; the next save sends it once its markers go\n',
  });

  const saves = doorSaves(hosted).length;
  rooms.refusesBatches.push({ status: 403, body: { error: { code: 'operation_denied', message: 'operation_denied: you may not write here', retryable: false } } });
  await writeFile(join(notes.repository, 'a.md'), 'one\ntwo\nthree, mine\n');
  await until(() => (doorSaves(hosted).length > saves ? true : undefined), SAVED_MS);
  notes.put('a.md', 'one\ntwo\nTHREE\n');
  const downloaded = await rooms.download([notes]);
  const updated = await house(hosted, notes.repository, 'update', JSON.stringify({ changes: [{ op: 'write', path: '/rooms/notes/a.md', content: 'one\ntwo\nTHREE, too\n', base: notes.revision('a.md') }] }));

  expect(downloaded).toMatchObject({ status: 0, stdout: "/rooms/notes/a.md: changed here, so House's change was not brought; the next save merges it\n" });
  expect(updated.stdout).toContain('/rooms/notes/a.md: changed here, so House accepted the update and local integration is pending; the next save sends this file as it is');
  expect(`${downloaded.stdout}${updated.stdout}`).not.toMatch(/house (upload|download)/);
});

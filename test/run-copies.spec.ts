import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { settle, until, type Received } from './double.ts';
import { clocked, hostKit, lastCall, type Hosted, type Hosting, type RouteOverrides } from './environment.ts';
import { house, manifestOf, serveRooms, type Room, type Rooms } from './rooms.ts';

const INSTRUCTIONS = 'Write dates as YYYY-MM-DD.\n';
const HOUR = 60 * 60_000;
const MADE = ['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md', 'plan.md'];

type Copy = { kind: 'none' } | { kind: 'new' } | { kind: 'existing'; path: string };

function copyOf(hosted: Hosted, handle: string, name: string): string {
  return join(hosted.workspace, 'conversations', handle, name);
}

async function held(folder: string): Promise<string[]> {
  return (await readdir(folder)).sort();
}

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function staged(routes: RouteOverrides[], hosting: Hosting = {}): Promise<{ hosted: Hosted; rooms: Rooms; notes: Room }> {
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

async function opened(hosted: Hosted, index: number, room: Room, name: string, copy?: Copy): Promise<{ provider_session_id?: string; refused?: string }> {
  const run = copy === undefined ? {} : { run: { name, copy, repository: null } };
  hosted.call({ kind: 'open', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, room_ref: room.ref, name, ...run });
  return (await hosted.result(lastCall())) as { provider_session_id?: string; refused?: string };
}

async function session(hosted: Hosted, index: number, room: Room, name: string, copy?: Copy): Promise<string> {
  const answer = await opened(hosted, index, room, name, copy);
  if (answer.provider_session_id === undefined) throw new Error(`the open was refused: ${answer.refused}`);
  return answer.provider_session_id;
}

function told(hosted: Hosted, index: number, text: string, fields: Record<string, unknown> = {}): void {
  hosted.call({ kind: 'message', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, text, first: false, ...fields });
}

async function killed(hosted: Hosted, index: number, deleted?: true): Promise<unknown> {
  hosted.call({ kind: 'kill', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, ...(deleted === undefined ? {} : { deleted }) });
  return hosted.result(lastCall());
}

async function logged(hosted: Hosted, method: string): Promise<Record<string, unknown>[]> {
  return (await hosted.adapterLog()).filter((entry) => entry.method === method);
}

async function opening(hosted: Hosted, method: 'session/new' | 'session/resume', index: number): Promise<{ cwd: string; _meta: Record<string, unknown> }> {
  const sessions = await until(async () => {
    const written = await logged(hosted, method);
    return written.length > index ? written : undefined;
  });
  return sessions[index]!.params as { cwd: string; _meta: Record<string, unknown> };
}

async function prompt(hosted: Hosted, index: number): Promise<string> {
  const prompts = await until(async () => {
    const written = await logged(hosted, 'session/prompt');
    return written.length > index ? written : undefined;
  });
  return String(prompts[index]!.text);
}

function ended(hosted: Hosted): Received[] {
  return hosted.turns.filter((turn) => turn.path === '/kit/turns/end');
}

async function turned(hosted: Hosted, count: number): Promise<void> {
  await until(() => ended(hosted).length >= count);
}

async function turn(hosted: Hosted, index: number, text: string, fields: Record<string, unknown> = {}): Promise<void> {
  const before = ended(hosted).length;
  told(hosted, index, text, fields);
  await turned(hosted, before + 1);
  await settle();
}

function noticed(hosted: Hosted, room: Room): void {
  hosted.house.connections.at(-1)!.send({ type: 'work_available', subject: 'rooms', room_ref: room.ref });
}

function downloads(hosted: Hosted): number {
  return hosted.house.requests.filter((request) => /^\/kit\/door\/(?:changes\/enumerate|room-chunks\/list)$/.test(request.path)).length;
}

async function shows(path: string, text: string): Promise<void> {
  await until(async () => ((await readFile(path, 'utf8').catch(() => null)) === text ? true : undefined));
}

async function emptyFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'kit-folder-'));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

function updating(changes: Record<string, unknown>[]): string {
  return `'${JSON.stringify({ changes })}'`;
}

it("starts a Run with no copy in its Agent's launch directory, one with a new copy in a copy named by the Run made once from House, and one with an existing copy in that folder, another conversation's copy or a Room's folder, and leaves a Run in a folder with no manifest or a copy of another Room not started, naming why", async () => {
  const { hosted, rooms, notes } = await staged([{}, {}, {}, {}, {}, {}]);
  const garden = rooms.room('garden');
  garden.put('beds.md', 'Two beds\n');
  rooms.answered = [notes, garden];
  await rooms.download([notes, garden]);
  const made = copyOf(hosted, 'notes', 'imp-1');
  const bare = await emptyFolder();

  await session(hosted, 1, notes, 'rev-1', { kind: 'none' });
  await session(hosted, 2, notes, 'imp-1', { kind: 'new' });
  await session(hosted, 3, notes, 'rev-2', { kind: 'existing', path: made });
  await session(hosted, 4, notes, 'rev-3', { kind: 'existing', path: notes.repository });

  expect((await opening(hosted, 'session/new', 0)).cwd).toBe(hosted.workingDirectory);
  await absent(copyOf(hosted, 'notes', 'rev-1'));
  expect((await opening(hosted, 'session/new', 1)).cwd).toBe(made);
  expect(await held(made)).toEqual(MADE);
  expect(await readFile(join(made, 'AGENTS.md'), 'utf8')).toBe(INSTRUCTIONS);
  expect((await opening(hosted, 'session/new', 2)).cwd).toBe(made);
  expect((await opening(hosted, 'session/new', 3)).cwd).toBe(notes.repository);
  expect(await readdir(join(hosted.workspace, 'conversations', 'notes'))).toEqual(['imp-1']);
  expect(await opened(hosted, 5, notes, 'rev-4', { kind: 'existing', path: bare })).toEqual({ refused: `${bare} holds no Local copy of a Room` });
  expect(await opened(hosted, 6, notes, 'rev-5', { kind: 'existing', path: garden.repository })).toEqual({
    refused: `${garden.repository} is a Local copy of another Room`,
  });
  expect(await logged(hosted, 'session/new')).toHaveLength(4);
});

it("downloads into a Run's copy only when it makes it and uploads nothing at a Run's turns, writing no line for it, while a conversation opened with no Run, such as one submitted before this release, still downloads at a notice and uploads at its turn's end", async () => {
  const { hosted, rooms, notes } = await staged([{}, {}, {}]);
  const imp = copyOf(hosted, 'notes', 'imp-1');
  const earlier = copyOf(hosted, 'notes', 'rev-9');
  await session(hosted, 1, notes, 'imp-1', { kind: 'new' });
  await session(hosted, 2, notes, 'rev-1', { kind: 'existing', path: notes.repository });
  await session(hosted, 3, notes, 'rev-9');
  await settle();
  const fetched = downloads(hosted);

  notes.put('a.md', 'one\ntwo\nthree, from House\n');
  noticed(hosted, notes);
  await shows(join(earlier, 'a.md'), 'one\ntwo\nthree, from House\n');
  await settle();
  await turn(hosted, 1, '@sh echo mine >> plan.md');
  await turn(hosted, 2, '@sh echo theirs >> plan.md');
  await turn(hosted, 1, '@say again');

  expect(await readFile(join(imp, 'a.md'), 'utf8')).toBe('one\ntwo\nthree\n');
  expect(await readFile(join(imp, 'plan.md'), 'utf8')).toBe('Plant beans\nmine\n');
  expect(await readFile(join(notes.repository, 'plan.md'), 'utf8')).toBe('Plant beans\ntheirs\n');
  expect(rooms.edits()).toEqual([]);
  expect(await prompt(hosted, 2)).toBe('@say again');
  expect(downloads(hosted)).toBe(fetched + 1);

  await turn(hosted, 3, '@sh echo ours >> plan.md');

  await until(() => (rooms.edits().length === 1 ? true : undefined));
  expect(notes.files.get('plan.md')!.content).toBe('Plant beans\nours\n');
  expect(await readFile(join(imp, 'plan.md'), 'utf8')).toBe('Plant beans\nmine\n');
});

it("keeps a copy a Run given it as existing had a turn in within 24 hours, removes it once no turn ran in it for 24 hours and makes it again from a fresh download at that Run's next turn, never removes a Room's folder, and reckons a Run's copy holding work with no download", async () => {
  const clock = await clocked();
  const { hosted, notes } = await staged([{}, {}, {}, {}], clock.hosting);
  const imp = copyOf(hosted, 'notes', 'imp-1');
  const worked = copyOf(hosted, 'notes', 'cha-1');
  const sessions = [
    await session(hosted, 1, notes, 'imp-1', { kind: 'new' }),
    await session(hosted, 2, notes, 'rev-1', { kind: 'existing', path: imp }),
    await session(hosted, 3, notes, 'rev-2', { kind: 'existing', path: notes.repository }),
    await session(hosted, 4, notes, 'cha-1', { kind: 'new' }),
  ];
  const resumed = (index: number) => ({ provider_session_id: sessions[index - 1] });
  for (const index of [1, 2, 3]) await turn(hosted, index, '@say first');
  await turn(hosted, 4, '@sh echo mine >> plan.md');
  for (const index of [1, 2, 3, 4]) expect(await killed(hosted, index)).toEqual({});
  notes.put('a.md', 'one\ntwo\nthree, from House\n');

  await clock.shift(20 * HOUR);
  await turn(hosted, 2, '@say later', resumed(2));
  expect(await killed(hosted, 2)).toEqual({});
  await clock.shift(25 * HOUR);
  const fetched = downloads(hosted);
  await turn(hosted, 3, '@say looking', resumed(3));

  expect(await held(imp)).toEqual(MADE);
  expect(await readFile(join(worked, 'plan.md'), 'utf8')).toBe('Plant beans\nmine\n');
  expect(await readFile(join(worked, 'a.md'), 'utf8')).toBe('one\ntwo\nthree\n');
  expect(downloads(hosted)).toBe(fetched);

  await clock.shift(46 * HOUR);
  await turn(hosted, 3, '@say looking again', resumed(3));
  await until(() => (existsSync(imp) ? undefined : true));

  expect(await readFile(join(notes.repository, 'a.md'), 'utf8')).toBe('one\ntwo\nthree\n');
  expect(await readFile(join(worked, 'plan.md'), 'utf8')).toBe('Plant beans\nmine\n');
  expect(downloads(hosted)).toBe(fetched);

  await turn(hosted, 2, '@say back', resumed(2));

  expect((await opening(hosted, 'session/resume', 2)).cwd).toBe(imp);
  expect(await readFile(join(imp, 'a.md'), 'utf8')).toBe('one\ntwo\nthree, from House\n');
});

it("removes a deleted conversation's copy only once no other living conversation works in it, keeping it while a Run given it as existing lives and naming it at that Run's deletion where it holds work", async () => {
  const { hosted, notes } = await staged([{}, {}, {}, {}]);
  const imp = copyOf(hosted, 'notes', 'imp-1');
  const cha = copyOf(hosted, 'notes', 'cha-1');
  await session(hosted, 1, notes, 'imp-1', { kind: 'new' });
  await session(hosted, 2, notes, 'rev-1', { kind: 'existing', path: imp });
  await session(hosted, 3, notes, 'cha-1', { kind: 'new' });
  await session(hosted, 4, notes, 'rev-2', { kind: 'existing', path: cha });
  await turn(hosted, 3, '@sh echo mine >> plan.md');

  expect(await killed(hosted, 1, true)).toEqual({});
  expect(await killed(hosted, 3, true)).toEqual({});
  expect(await held(imp)).toEqual(MADE);
  expect(await readFile(join(cha, 'plan.md'), 'utf8')).toBe('Plant beans\nmine\n');

  expect(await killed(hosted, 2, true)).toEqual({});
  await absent(imp);
  expect(await killed(hosted, 4, true)).toEqual({ kept: [{ room_ref: notes.ref, path: cha }] });
  expect(await readFile(join(cha, 'plan.md'), 'utf8')).toBe('Plant beans\nmine\n');
  expect(await held(notes.repository)).toEqual(MADE);
});

it("writes each document a house update changed and each attachment write of a file the copy holds, as House accepted it, into the file of the copy the conversation works in, or else of the copy holding the working directory, advancing its manifest entry, and keeps the bytes of a file changed since its entry, saying its local integration is pending", async () => {
  const { hosted, rooms, notes } = await staged([{}, {}]);
  notes.upload('table.csv', Buffer.from('a,b\n'));
  await rooms.download([notes], '--with-attachments');
  const imp = copyOf(hosted, 'notes', 'imp-1');
  await session(hosted, 1, notes, 'imp-1', { kind: 'new' });
  await session(hosted, 2, notes, 'rev-1', { kind: 'none' });
  await writeFile(join(imp, 'plan.md'), 'Plant beans here\n');
  const plan = (await manifestOf(notes)).files['plan.md']!;

  await turn(
    hosted,
    1,
    `@sh cd ${hosted.workingDirectory} && house update ${updating([
      { op: 'write', path: '/rooms/notes/a.md', content: 'one\ntwo\nfour\n', base: notes.revision('a.md') },
      { op: 'write', path: '/rooms/notes/plan.md', content: 'Plant peas\n', base: notes.revision('plan.md') },
      { op: 'write', path: '/rooms/notes/new.md', content: 'new\n' },
      { op: 'write', path: '/rooms/notes/table.csv', content: 'a,b,c\n', base: notes.revision('table.csv') },
      { op: 'write', path: '/rooms/notes/new.csv', content: 'x\n' },
    ])}`,
  );

  expect(await readFile(join(imp, 'a.md'), 'utf8')).toBe('one\ntwo\nfour\n');
  expect(await readFile(join(imp, 'new.md'), 'utf8')).toBe('new\n');
  expect(await readFile(join(imp, 'plan.md'), 'utf8')).toBe('Plant beans here\n');
  expect(await readFile(join(imp, 'table.csv'), 'utf8')).toBe('a,b,c\n');
  await absent(join(imp, 'new.csv'));
  const entries = JSON.parse(await readFile(join(imp, '.house'), 'utf8')) as { files: Record<string, { revision: string }> };
  for (const path of ['a.md', 'new.md', 'table.csv']) expect(entries.files[path]!.revision).toBe(notes.revision(path));
  expect(entries.files['plan.md']!.revision).toBe(plan.revision);
  expect(entries.files).not.toHaveProperty('new.csv');
  expect(await readFile(join(notes.repository, 'a.md'), 'utf8')).toBe('one\ntwo\nthree\n');
  expect(await readFile(join(notes.repository, 'table.csv'), 'utf8')).toBe('a,b\n');

  await turn(hosted, 2, `@sh cd ${notes.repository} && house update ${updating([{ op: 'write', path: '/rooms/notes/a.md', content: 'one\n', base: notes.revision('a.md') }])}`);

  expect(await readFile(join(notes.repository, 'a.md'), 'utf8')).toBe('one\n');
  expect((await manifestOf(notes)).files['a.md']!.revision).toBe(notes.revision('a.md'));
  expect(await readFile(join(imp, 'a.md'), 'utf8')).toBe('one\ntwo\nfour\n');

  await writeFile(join(notes.repository, 'plan.md'), 'Plant beans there\n');
  const pending = await house(hosted, notes.repository, 'update', JSON.stringify({ changes: [{ op: 'write', path: '/rooms/notes/plan.md', content: 'Plant corn\n', base: notes.revision('plan.md') }] }));
  const outside = await house(hosted, '/', 'update', JSON.stringify({ changes: [{ op: 'write', path: '/rooms/notes/a.md', content: 'one, outside\n', base: notes.revision('a.md') }] }));

  expect(pending).toMatchObject({ status: 0, stderr: '' });
  expect(pending.stdout).toContain('/rooms/notes/plan.md: changed here, so House accepted the update and local integration is pending; the next house upload sends this file as it is\n');
  expect(await readFile(join(notes.repository, 'plan.md'), 'utf8')).toBe('Plant beans there\n');
  expect((await manifestOf(notes)).files['plan.md']).toEqual(plan);
  expect(outside).toMatchObject({ status: 0, stderr: '' });
  expect(notes.files.get('a.md')!.content).toBe('one, outside\n');
  expect(await readFile(join(notes.repository, 'a.md'), 'utf8')).toBe('one\n');
});

it("says House accepted a house update whose write into a Run's copy failed and that its local integration is pending, keeping the entries of what it wrote, so a house download there brings House's text", async () => {
  const { hosted, rooms, notes } = await staged([{}]);
  notes.put('c.md', 'one\ntwo\n');
  await rooms.download([notes]);
  const imp = copyOf(hosted, 'notes', 'imp-1');
  await session(hosted, 1, notes, 'imp-1', { kind: 'new' });
  const read = notes.revision('c.md');
  notes.put('c.md', 'zero\none\ntwo\n');
  notes.bound = 8;
  rooms.refusesReads = [
    { status: 503, body: { error: { code: 'house_unavailable', message: 'house_unavailable: House is unavailable; call again shortly', retryable: true } } },
  ];
  const entries = async () => (JSON.parse(await readFile(join(imp, '.house'), 'utf8')) as { files: Record<string, { revision: string }> }).files;

  const updated = await house(
    hosted,
    imp,
    'update',
    JSON.stringify({
      changes: [
        { op: 'write', path: '/rooms/notes/a.md', content: 'one, here\n', base: notes.revision('a.md') },
        { op: 'write', path: '/rooms/notes/c.md', content: 'one\ntwo\nthree\n', base: read },
      ],
    }),
  );

  expect(updated).toMatchObject({ status: 0, stderr: '' });
  expect(updated.stdout).toContain(
    `${imp}: House accepted the update, but Kit could not write it here (house_unavailable: House is unavailable; call again shortly), so local integration is pending; house download here brings House's text\n`,
  );
  expect(notes.files.get('c.md')!.content).toBe('zero\none\ntwo\nthree\n');
  expect(await readFile(join(imp, 'a.md'), 'utf8')).toBe('one, here\n');
  expect((await entries())['a.md']!.revision).toBe(notes.revision('a.md'));
  expect(await readFile(join(imp, 'c.md'), 'utf8')).toBe('one\ntwo\n');
  expect((await entries())['c.md']!.revision).toBe(read);

  expect(await house(hosted, imp, 'download')).toMatchObject({ status: 0, stderr: '' });
  expect(await readFile(join(imp, 'c.md'), 'utf8')).toBe('zero\none\ntwo\nthree\n');
  expect((await entries())['c.md']!.revision).toBe(notes.revision('c.md'));
});

it("gives Claude Code's session the Run's name at its start and its resume, and no other CLI's or conversation's", async () => {
  const { hosted, notes } = await staged([{}, { kind: 'claude-agent-acp' }, { kind: 'claude-agent-acp' }]);
  await session(hosted, 1, notes, 'rev-1', { kind: 'none' });
  const named = await session(hosted, 2, notes, 'rev-2', { kind: 'none' });
  await session(hosted, 3, notes, 'Plan');
  await turn(hosted, 2, '@say first');
  expect(await killed(hosted, 2)).toEqual({});

  await turn(hosted, 2, '@say again', { provider_session_id: named });

  const options = (opened: { _meta: Record<string, unknown> }) => (opened._meta.claudeCode as { options: Record<string, unknown> } | undefined)?.options;
  expect((await opening(hosted, 'session/new', 0))._meta).toEqual({});
  expect(options(await opening(hosted, 'session/new', 1))).toMatchObject({ extraArgs: { name: 'rev-2' } });
  expect(options(await opening(hosted, 'session/new', 2))).not.toHaveProperty('extraArgs');
  expect(options(await opening(hosted, 'session/resume', 0))).toMatchObject({ extraArgs: { name: 'rev-2' } });
});

it("moves and deletes with a house update each file unchanged since its entry, writes the text House merged, keeps a file changed since its entry saying its local integration is pending, and leaves the copy as it was where House refused the update", async () => {
  const { hosted, rooms, notes } = await staged([{}]);
  notes.put('b.md', 'bee\n');
  notes.put('c.md', 'one\ntwo\n');
  await rooms.download([notes]);
  const read = (await manifestOf(notes)).files['c.md']!.revision;
  const bee = (await manifestOf(notes)).files['b.md']!;
  notes.put('c.md', 'zero\none\ntwo\n');
  await writeFile(join(notes.repository, 'b.md'), 'bee, mine\n');
  const changes = [
    { op: 'move', path: '/rooms/notes/plan.md', to: '/rooms/notes/done.md', base: notes.revision('plan.md') },
    { op: 'delete', path: '/rooms/notes/a.md', base: notes.revision('a.md') },
    { op: 'delete', path: '/rooms/notes/b.md', base: notes.revision('b.md') },
    { op: 'write', path: '/rooms/notes/c.md', content: 'one\ntwo\nthree\n', base: read },
  ];
  const refused = await house(hosted, notes.repository, 'update', JSON.stringify({ changes: [{ ...changes[1], base: read }] }));

  expect(refused.status).toBe(1);
  expect(await held(notes.repository)).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'a.md', 'b.md', 'c.md', 'plan.md']);

  const answered = await house(hosted, notes.repository, 'update', JSON.stringify({ changes }));

  expect(answered).toMatchObject({ status: 0, stderr: '' });
  expect(answered.stdout).toContain('/rooms/notes/b.md: changed here, so House accepted the update and local integration is pending; the next house upload sends this file as it is\n');
  expect(await held(notes.repository)).toEqual(['.house', 'AGENTS.md', 'CLAUDE.md', 'b.md', 'c.md', 'done.md']);
  expect(await readFile(join(notes.repository, 'done.md'), 'utf8')).toBe('Plant beans\n');
  expect(await readFile(join(notes.repository, 'b.md'), 'utf8')).toBe('bee, mine\n');
  expect(await readFile(join(notes.repository, 'c.md'), 'utf8')).toBe('zero\none\ntwo\nthree\n');
  const { files } = await manifestOf(notes);
  expect(Object.keys(files).sort()).toEqual(['b.md', 'c.md', 'done.md']);
  expect(files['b.md']).toEqual(bee);
  for (const path of ['c.md', 'done.md']) expect(files[path]!.revision).toBe(notes.revision(path));
});

it("keeps a Room's folder a Run works in through the Room's handle change, so the Run's next session opens where it worked, moves it to the new handle once that Run is deleted, and writes a house update naming the new handle into a Run's copy", async () => {
  const { hosted, rooms, notes } = await staged([{}, {}]);
  const imp = copyOf(hosted, 'notes', 'imp-1');
  const folder = notes.repository;
  await session(hosted, 1, notes, 'imp-1', { kind: 'new' });
  const worked = await session(hosted, 2, notes, 'rev-1', { kind: 'existing', path: folder });
  await turn(hosted, 2, '@say first');
  expect(await killed(hosted, 2)).toEqual({});

  notes.rehandle('notes-2');
  expect(await rooms.download([notes])).toMatchObject({ status: 0, stderr: '' });
  await turn(hosted, 1, `@sh house update ${updating([{ op: 'write', path: '/rooms/notes-2/a.md', content: 'one\n', base: notes.revision('a.md') }])}`);
  await turn(hosted, 2, '@say again', { provider_session_id: worked });

  expect(await readFile(join(imp, 'a.md'), 'utf8')).toBe('one\n');
  expect(JSON.parse(await readFile(join(imp, '.house'), 'utf8')).files['a.md'].revision).toBe(notes.revision('a.md'));
  expect((await opening(hosted, 'session/resume', 0)).cwd).toBe(folder);
  expect(await held(folder)).toEqual(MADE);

  expect(await killed(hosted, 2, true)).toEqual({});
  expect(await rooms.download([notes])).toMatchObject({ status: 0, stderr: '' });

  expect(notes.repository).not.toBe(folder);
  expect(await held(notes.repository)).toEqual(MADE);
  expect(await readFile(join(notes.repository, 'a.md'), 'utf8')).toBe('one\n');
  await absent(folder);
});

it("counts a linked attachment another folder of the Room wrote in place and uploaded as House's in a Run's copy, which reckoning downloads nothing into, so that copy goes once no turn ran in it for 24 hours", async () => {
  const clock = await clocked();
  const { hosted, rooms, notes } = await staged([{}, {}], clock.hosting);
  notes.upload('table.csv', Buffer.from('a,b\n'));
  await rooms.download([notes], '--with-attachments');
  const imp = copyOf(hosted, 'notes', 'imp-1');
  await session(hosted, 1, notes, 'imp-1', { kind: 'new' });
  await session(hosted, 2, notes, 'rev-1', { kind: 'none' });
  await turn(hosted, 1, '@say first');
  expect(await killed(hosted, 1)).toEqual({});
  await writeFile(join(notes.repository, 'table.csv'), 'a,b,c\n');
  expect(await house(hosted, notes.repository, 'upload')).toMatchObject({ status: 0, stderr: '' });
  expect(await readFile(join(imp, 'table.csv'), 'utf8')).toBe('a,b,c\n');
  const fetched = downloads(hosted);

  await clock.shift(25 * HOUR);
  await turn(hosted, 2, '@say looking');
  await until(() => (existsSync(imp) ? undefined : true));

  expect(downloads(hosted)).toBe(fetched);
  expect(await readFile(join(notes.repository, 'table.csv'), 'utf8')).toBe('a,b,c\n');
});

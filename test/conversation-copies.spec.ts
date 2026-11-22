import { agentInstructions } from '@agentshouse/skills';
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { settle, until, type Received } from './double.ts';
import { conversationCredential, hostKit, lastCall, shelled, type Hosted, type RouteOverrides } from './environment.ts';
import { alive, temporaryDirectory } from './kit.ts';
import { callUpdate, released, serveRelease } from './release.ts';
import { house, roomRootReads, serveRooms, upload, type Room, type Rooms } from './rooms.ts';

const INSTRUCTIONS = 'These instructions come after House’s and your own.\n\nWrite dates as YYYY-MM-DD.\n';
const OWNER_RULES = 'Keep the work in its Room.\n';
const IMPORTED = '@AGENTS.md\n';
const PLACED = '0.2.1-c000000000002';

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

function lineOf(text: string): string {
  return text.split('\n').at(-1)!;
}

function bytes(text: string): Buffer {
  return Buffer.from(text);
}

async function staged(routes: RouteOverrides[] = [{}]): Promise<{ hosted: Hosted; rooms: Rooms; notes: Room }> {
  const hosted = await hostKit(routes);
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('a.md', 'one\ntwo\nthree\n');
  notes.put('plan.md', 'Plant beans\n');
  notes.instructions = INSTRUCTIONS;
  rooms.answered = [notes];
  await rooms.download([notes]);
  return { hosted, rooms, notes };
}

it("makes a conversation's copy from House's state with the attachments the Room's folder holds unchanged, numbers a second copy of one name, keeps its path through renames and makes it again where a person deleted it", async () => {
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
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\n');
  expect(await held(join(hosted.workspace, 'conversations'))).toEqual(['notes']);
});

it("downloads into the copy before each turn, reading the instructions of the copy's Room alone, keeps what the conversation changed and still runs a turn whose download failed", async () => {
  const { hosted, rooms, notes } = await staged();
  const garden = rooms.room('garden');
  garden.put('beds.md', 'Two beds\n');
  rooms.answered = [notes, garden];
  await rooms.download([notes, garden]);
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  said(hosted, '@say first');
  await turned(hosted, 1);
  await settle();
  const read = roomRootReads(hosted).length;

  notes.put('a.md', 'one\ntwo\nthree, from House\n');
  notes.instructions = `${INSTRUCTIONS}Put new tasks on the map.\n`;
  await writeFile(join(copy, 'plan.md'), 'Plant beans and peas\n');
  said(hosted, '@say second');

  expect(await prompt(hosted, 1)).toBe('@say second');
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\ntwo\nthree, from House\n');
  expect(await readFile(join(copy, 'plan.md'), 'utf8')).toBe('Plant beans and peas\n');
  expect(await readFile(join(copy, 'AGENTS.md'), 'utf8')).toBe(`${INSTRUCTIONS}Put new tasks on the map.\n`);
  expect(roomRootReads(hosted).slice(read)).toEqual(['/rooms/notes']);
  await turned(hosted, 2);

  notes.put('a.md', 'one\n');
  rooms.reads.push(false);
  said(hosted, '@say third');

  expect(await prompt(hosted, 2)).toBe('@say third');
  expect(await readFile(join(copy, 'a.md'), 'utf8')).toBe('one\ntwo\nthree, from House\n');
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

  expect(sent!.headers.authorization).toBe(`Bearer ${conversationCredential('conversation-1')}`);
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

  expect(batch!.headers.authorization).toBe(`Bearer ${conversationCredential('conversation-1')}`);
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

it.each([
  ['the cut notice ending it', 'notice'],
  ['cut beside it', 'cut'],
] as const)("brings back the whole text House merged where its update answer cuts that text, with %s", async (_way, cutWith) => {
  const { hosted, rooms, notes } = await staged();
  const copy = copyOf(hosted, 'notes', 'Plan');
  await opened(hosted, notes, 'Plan');
  notes.bound = 8;
  notes.cutWith = cutWith;

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

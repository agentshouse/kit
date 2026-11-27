import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, type Hosted } from './environment.ts';
import { accountOf, runKit, stop, temporaryDirectory } from './kit.ts';
import { house, manifestOf, serveRooms, upload, type Room, type Rooms } from './rooms.ts';

const KIT = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const CONFLICTED = '<<<<<<< current\nc, from House\n=======\nc, mine\n>>>>>>> yours\n';

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

function recordOf(hosted: Hosted, room: Room): string {
  return join(hosted.home, 'local-copies', 'rooms', `${room.ref}.json`);
}

async function settings(hosted: Hosted): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(hosted.home, 'kit.json'), 'utf8')) as Record<string, unknown>;
}

async function earlierCopy(hosted: Hosted, room: Room, root: string): Promise<string> {
  const earlier = join(root, 'local-copies', 'rooms', room.ref);
  await mkdir(dirname(earlier), { recursive: true });
  await rename(room.repository, earlier);
  const record = JSON.parse(await readFile(recordOf(hosted, room), 'utf8')) as Record<string, unknown>;
  await writeFile(recordOf(hosted, room), JSON.stringify({ ...record, repository: earlier }));
  return earlier;
}

async function earlierKit(hosted: Hosted, rooms: Room[], root: string): Promise<void> {
  stop(hosted.kit.pid);
  await hosted.kit.exited;
  for (const room of rooms) await earlierCopy(hosted, room, root);
  if (root !== hosted.workspace) {
    await rename(join(hosted.workspace, 'agents'), join(root, 'agents'));
    await rm(hosted.workspace, { recursive: true, force: true });
  } else {
    await rm(join(root, 'rooms'), { recursive: true, force: true });
  }
  await writeFile(join(hosted.home, 'kit.json'), JSON.stringify({ ...(await settings(hosted)), workspace: root }));
}

async function copied(rooms: Rooms): Promise<{ notes: Room; design: Room }> {
  const notes = rooms.room('notebook');
  notes.put('a.md', 'a\n');
  notes.put('c.md', 'c\n');
  const design = rooms.room('design');
  design.put('brief.md', 'Brief\n');
  await rooms.download([notes, design]);
  await rooms.download([notes]);
  await writeFile(join(notes.repository, 'a.md'), 'a, changed here\n');
  await writeFile(join(notes.repository, 'new.md'), 'new here\n');
  await writeFile(join(notes.repository, 'c.md'), CONFLICTED);
  const manifest = await manifestOf(notes);
  manifest.files['c.md'] = { ...manifest.files['c.md']!, conflicted: true };
  await writeFile(join(notes.repository, '.house'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(design.repository, 'draft.md'), 'draft\n');
  return { notes, design };
}

async function started(hosted: Hosted): Promise<{ status: number | null; stderr: string }> {
  const kit = runKit(['resident'], hosted.environment);
  hosted.kit = kit;
  const status = await kit.exited;
  return { status, stderr: kit.stderr() };
}

async function agentBase(hosted: Hosted): Promise<unknown> {
  const reported = hosted.reports.length;
  await hosted.restart();
  return (await until(() => hosted.reports.slice(reported).find((report) => report.agent_base !== undefined))).agent_base;
}

it('lays out a fresh install in ~/house, its rooms and agents, and reports the Agent base there', async () => {
  const hosted = await hostKit();
  const folder = join(accountOf(hosted.home), 'house');

  expect((await readdir(folder)).sort()).toEqual(['agents', 'rooms']);
  for (const made of [folder, join(folder, 'agents'), join(folder, 'rooms')]) expect((await stat(made)).mode & 0o777).toBe(0o700);
  expect(await settings(hosted)).toMatchObject({ workspace: folder });
  expect((await until(() => hosted.reports[0])).agent_base).toBe(join(folder, 'agents'));
  await absent(join(hosted.home, 'agents'));
  await absent(join(hosted.home, 'rooms'));
});

it("moves an earlier workspace in Kit home to ~/house at its first start, each copy to its Room's handle with its changed, new and conflicted files and manifest, a copy it no longer follows aside, ends for its supervisor and saves the changed and new files at its next connection", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const { notes, design } = await copied(rooms);
  const manifest = await manifestOf(notes);
  await mkdir(join(hosted.workspace, 'agents', 'agent-1'));
  await writeFile(join(hosted.workspace, 'agents', 'agent-1', 'notes.md'), 'kept\n');
  await earlierKit(hosted, [notes, design], hosted.home);

  const moved = await started(hosted);

  expect(moved.status).toBe(1);
  expect(moved.stderr.split('\n').at(-2)).toBe(`kit: Kit ${KIT.version} moved its workspace to ${hosted.workspace}; its supervisor starts it there`);
  expect(await readFile(join(hosted.workspace, 'rooms', 'notebook', 'a.md'), 'utf8')).toBe('a, changed here\n');
  expect(await readFile(join(hosted.workspace, 'rooms', 'notebook', 'new.md'), 'utf8')).toBe('new here\n');
  expect(await readFile(join(hosted.workspace, 'rooms', 'notebook', 'c.md'), 'utf8')).toBe(CONFLICTED);
  expect(await manifestOf(notes)).toEqual(manifest);
  const kept = join(hosted.workspace, 'rooms', `${design.ref} (kept)`);
  expect(await readFile(join(kept, 'draft.md'), 'utf8')).toBe('draft\n');
  expect(await readFile(join(hosted.workspace, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
  expect(JSON.parse(await readFile(recordOf(hosted, notes), 'utf8'))).toMatchObject({ repository: notes.repository });
  expect(JSON.parse(await readFile(recordOf(hosted, design), 'utf8'))).toMatchObject({ repository: kept });
  expect(await settings(hosted)).toMatchObject({ workspace: hosted.workspace });
  expect((await readdir(join(hosted.home, 'local-copies', 'rooms'))).sort()).toEqual([`${design.ref}.json`, `${notes.ref}.json`].sort());
  await absent(join(hosted.home, 'agents'));
  await absent(join(hosted.home, 'rooms'));

  expect(await agentBase(hosted)).toBe(join(hosted.workspace, 'agents'));

  expect((await readdir(join(hosted.workspace, 'rooms'))).filter((name) => !name.startsWith('.')).sort()).toEqual([`${design.ref} (kept)`, 'notebook'].sort());
  expect(await upload(hosted, notes)).toMatchObject({ status: 1, stderr: `house: ${notes.root}/c.md still holds conflict markers; the next save sends it once its markers go\n` });
  await until(() => notes.files.get('new.md'));
  expect(notes.files.get('new.md')?.content).toBe('new here\n');
  expect(notes.files.get('a.md')?.content).toBe('a, changed here\n');
  await writeFile(join(notes.repository, 'c.md'), 'c, resolved\n');
  expect(await upload(hosted, notes)).toMatchObject({ status: 0, stdout: `House accepted 1 file of ${notes.root}.\n` });
});

it('keeps a workspace its person set elsewhere at its path and lays its Local copies out there by handle', async () => {
  const workspace = join(await temporaryDirectory(), 'Work');
  const hosted = await hostKit([{}], { workspace });
  const rooms = serveRooms(hosted);
  const { notes, design } = await copied(rooms);
  await earlierKit(hosted, [notes, design], workspace);

  const moved = await started(hosted);

  expect(moved.status).toBe(1);
  expect(moved.stderr.split('\n').at(-2)).toBe(`kit: Kit ${KIT.version} laid out its workspace ${workspace}; its supervisor starts it again`);
  expect(await readFile(join(workspace, 'rooms', 'notebook', 'new.md'), 'utf8')).toBe('new here\n');
  expect(await readFile(join(workspace, 'rooms', `${design.ref} (kept)`, 'draft.md'), 'utf8')).toBe('draft\n');
  await absent(join(workspace, 'local-copies'));
  await absent(join(accountOf(hosted.home), 'house'));
  expect(await settings(hosted)).toMatchObject({ workspace });
  expect(await agentBase(hosted)).toBe(join(workspace, 'agents'));
});

it("keeps an earlier workspace in Kit home where ~/house holds what is not Kit's, lays it out there and names it as the setting, and moves nothing at the next start", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const { notes, design } = await copied(rooms);
  await earlierKit(hosted, [notes, design], hosted.home);
  const folder = join(accountOf(hosted.home), 'house');
  await mkdir(folder);
  await writeFile(join(folder, 'mine.txt'), 'mine\n');

  const moved = await started(hosted);

  expect(moved.status).toBe(1);
  expect(moved.stderr.split('\n').at(-2)).toBe(`kit: Kit ${KIT.version} laid out its workspace ${hosted.home}; its supervisor starts it again`);
  expect(await readFile(join(hosted.home, 'rooms', 'notebook', 'a.md'), 'utf8')).toBe('a, changed here\n');
  expect(await readdir(folder)).toEqual(['mine.txt']);
  expect(await settings(hosted)).toMatchObject({ workspace: hosted.home });

  expect(await agentBase(hosted)).toBe(join(hosted.home, 'agents'));
  expect(await readdir(folder)).toEqual(['mine.txt']);
  expect((await readdir(join(hosted.home, 'rooms'))).filter((name) => !name.startsWith('.')).sort()).toEqual([`${design.ref} (kept)`, 'notebook'].sort());
});

function routed(hosted: Hosted, routes: { agent_id: string; working_directory: string }[]): void {
  hosted.house.route('POST', '/kit/agents/desired/list', () => ({
    body: {
      agents: ['codex-acp'],
      routes: routes.map((route) => ({ kind: 'codex-acp', base_instructions: 'Be useful.', model: 'route-model', effort: 'route-effort', mode: null, ...route })),
      transcribe: false,
    },
  }));
}

it("keeps where they are the folders an Agent's owner chose inside the earlier workspace, a copy one names among them, and moves every other", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const { notes, design } = await copied(rooms);
  await earlierKit(hosted, [notes, design], hosted.home);
  const reader = join(hosted.home, 'agents', 'reader');
  await mkdir(reader, { recursive: true });
  await writeFile(join(reader, 'chosen.md'), 'chosen\n');
  await mkdir(join(hosted.home, 'agents', 'agent-2'));
  await writeFile(join(hosted.home, 'agents', 'agent-2', 'default.md'), 'default\n');
  const chosenCopy = join(hosted.home, 'local-copies', 'rooms', notes.ref);
  routed(hosted, [
    { agent_id: 'agent-1', working_directory: reader },
    { agent_id: 'agent-2', working_directory: join(hosted.home, 'agents', 'agent-2') },
    { agent_id: 'agent-3', working_directory: join(chosenCopy, 'drafts') },
  ]);

  const moved = await started(hosted);

  expect(moved.status).toBe(1);
  expect(moved.stderr.split('\n').at(-2)).toBe(`kit: Kit ${KIT.version} moved its workspace to ${hosted.workspace}; its supervisor starts it there`);
  expect(await readFile(join(reader, 'chosen.md'), 'utf8')).toBe('chosen\n');
  expect(await readFile(join(hosted.workspace, 'agents', 'agent-2', 'default.md'), 'utf8')).toBe('default\n');
  await absent(join(hosted.workspace, 'agents', 'reader'));
  expect(await readFile(join(chosenCopy, 'new.md'), 'utf8')).toBe('new here\n');
  expect(JSON.parse(await readFile(recordOf(hosted, notes), 'utf8'))).toMatchObject({ repository: chosenCopy });
  expect(await readFile(join(hosted.workspace, 'rooms', `${design.ref} (kept)`, 'draft.md'), 'utf8')).toBe('draft\n');
  routed(hosted, []);
  await hosted.restart();
  expect(await house(hosted, chosenCopy, 'upload')).toMatchObject({
    status: 1,
    stderr: `house: ${notes.root}/c.md still holds conflict markers; the next save sends it once its markers go\n`,
  });
});

it("stays where it is and moves at its next start while House does not answer which folders its Agents' owners chose", async () => {
  const hosted = await hostKit();
  const rooms = serveRooms(hosted);
  const { notes, design } = await copied(rooms);
  await earlierKit(hosted, [notes, design], hosted.home);
  hosted.house.route('POST', '/kit/agents/desired/list', () => ({ status: 503, body: { error: { code: 'house_unavailable', retryable: true } } }));
  const waiting = runKit(['resident'], hosted.environment);
  hosted.kit = waiting;

  await until(() => waiting.stderr().includes(`kit: the workspace stays at ${hosted.home} and moves at the next start: `) || undefined);

  expect(await readFile(join(hosted.home, 'local-copies', 'rooms', notes.ref, 'new.md'), 'utf8')).toBe('new here\n');
  await absent(join(hosted.workspace, 'rooms'));
  expect(await settings(hosted)).toMatchObject({ workspace: hosted.home });
  stop(waiting.pid);
  await waiting.exited;
  routed(hosted, []);
  expect((await started(hosted)).status).toBe(1);
  expect(await readFile(join(hosted.workspace, 'rooms', 'notebook', 'new.md'), 'utf8')).toBe('new here\n');
});

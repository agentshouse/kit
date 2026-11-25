import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listSkills } from '@agentshouse/skills';
import { expect, it, onTestFinished } from 'vitest';
import { catalogue, serveCatalogue } from './catalogue.ts';
import { settle, startHouse, until } from './double.ts';
import { GIT_IDENTITY, hostKit, lastCall, type Hosted } from './environment.ts';
import { accountOf, alive, runKit, temporaryDirectory, temporaryHome } from './kit.ts';

const HOUSE = 'https://house.example';
const NAMES = listSkills()
  .map(({ name }) => name)
  .sort();
const [FIRST, SECOND] = NAMES as [string, string];

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function absent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

function git(cwd: string, ...args: string[]): string {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY } });
  if (ran.status !== 0) throw new Error(ran.stderr);
  return ran.stdout;
}

function houseOf(home: string): string {
  return join(accountOf(home), 'house');
}

async function filled(home: string, workspace = houseOf(home)): Promise<void> {
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: false, workspace }));
  await put(join(workspace, 'agents', 'agent-1', 'notes.md'), 'kept\n');
  const repository = join(workspace, 'rooms', 'notes');
  await put(join(repository, 'plan.md'), 'plan\n');
  git(repository, 'init', '--quiet');
  git(repository, 'add', 'plan.md');
  git(repository, 'commit', '--quiet', '-m', 'the plan');
  await put(join(repository, 'draft.md'), 'not committed\n');
  await put(
    join(home, 'local-copies', 'rooms', 'r_notes.json'),
    JSON.stringify({ key: 'rooms/r_notes', room_ref: 'r_notes', room_handle: 'notes', repository, moves: [{ worktree: repository, from: 'a', to: 'b' }] }),
  );
}

async function followed(home: string, workspace: string): Promise<void> {
  expect(await readFile(join(workspace, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
  const repository = join(workspace, 'rooms', 'notes');
  expect(git(repository, 'log', '--format=%s')).toBe('the plan\n');
  expect(git(repository, 'status', '--porcelain')).toBe('?? draft.md\n');
  expect(await readFile(join(repository, 'draft.md'), 'utf8')).toBe('not committed\n');
  const record = JSON.parse(await readFile(join(home, 'local-copies', 'rooms', 'r_notes.json'), 'utf8')) as { repository: string; moves: { worktree: string }[] };
  expect(record.repository).toBe(repository);
  expect(record.moves[0]!.worktree).toBe(repository);
  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toMatchObject({ workspace });
  await absent(join(houseOf(home), 'agents'));
  await absent(join(houseOf(home), 'rooms'));
  expect(await readdir(join(home, 'local-copies', 'rooms'))).toEqual(['r_notes.json']);
}

async function otherFilesystem(): Promise<string> {
  const root = join('/dev/shm', `kit-settings-${randomUUID()}`);
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return join(root, 'workspace');
}

function callSettings(hosted: Hosted, change: Record<string, unknown>, input_id = `settings-${randomUUID()}`): string {
  hosted.call({ input_id, conversation_id: null, agent_id: null, provider_session_id: null, kind: 'settings', ...change });
  return input_id;
}

async function kitSettings(home: string, ...operands: string[]) {
  const kit = runKit(['settings', ...operands], { HOME: accountOf(home) });
  const status = await kit.exited;
  return { status, stdout: kit.stdout(), stderr: kit.stderr() };
}

async function lastReport(hosted: Hosted, reported: (report: Record<string, unknown>) => boolean, from = 0): Promise<Record<string, unknown>> {
  return until(() => hosted.reports.slice(from).findLast(reported));
}

async function enrolled(skills: unknown, house = HOUSE): Promise<string> {
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house, environment: 'environment-one', credential: 'ahk_held' }));
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills, workspace: home }));
  return home;
}

it("prints the settings and sets the skills to all or a list of names with no Kit process running, an earlier Kit's on reading all and its off an empty list", async () => {
  const house = await startHouse();
  serveCatalogue(house, NAMES);
  const home = await enrolled(true, house.origin);
  const skills = join(accountOf(home), '.agents', 'skills');
  const settings = () => readFile(join(home, 'kit.json'), 'utf8').then((text) => JSON.parse(text) as unknown);

  expect(await kitSettings(home)).toEqual({ status: 0, stdout: `skills all\nworkspace ${home}\n`, stderr: '' });

  expect(await kitSettings(home, 'skills', SECOND, FIRST)).toEqual({ status: 0, stdout: `skills ${SECOND} ${FIRST}\nworkspace ${home}\n`, stderr: '' });
  expect(await settings()).toEqual({ skills: [SECOND, FIRST], workspace: home });
  expect((await readdir(skills)).sort()).toEqual([FIRST, SECOND]);

  expect(await kitSettings(home, 'skills', 'all')).toEqual({ status: 0, stdout: `skills all\nworkspace ${home}\n`, stderr: '' });
  expect(await settings()).toEqual({ skills: 'all', workspace: home });
  expect((await readdir(skills)).sort()).toEqual(NAMES);

  expect(await kitSettings(home, 'skills')).toEqual({ status: 0, stdout: `skills\nworkspace ${home}\n`, stderr: '' });
  expect(await settings()).toEqual({ skills: [], workspace: home });
  expect(await readdir(skills)).toEqual([]);
  await absent(join(home, 'skill-set.json'));

  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: false, workspace: home }));
  expect(await kitSettings(home)).toEqual({ status: 0, stdout: `skills\nworkspace ${home}\n`, stderr: '' });
});

it('refuses a workspace that is no absolute path, or one the account cannot write, changing nothing', async () => {
  const home = await enrolled(false);
  const settings = await readFile(join(home, 'kit.json'), 'utf8');

  expect(await kitSettings(home, 'workspace', 'agents')).toEqual({ status: 1, stdout: '', stderr: 'house: agents is not an absolute path\n' });
  expect(await kitSettings(home, 'workspace', '/proc/kit')).toEqual({ status: 1, stdout: '', stderr: 'house: this account cannot write /proc/kit\n' });
  for (const operands of [['colour', 'blue'], ['workspace', '/a', '/b']]) {
    expect(await kitSettings(home, ...operands)).toMatchObject({ status: 1, stderr: 'house: usage: house settings [skills all|<name>... | workspace <absolute path>]\n' });
  }
  expect(await readFile(join(home, 'kit.json'), 'utf8')).toBe(settings);
});

it('refuses to move the workspace of a Kit that still runs where an earlier install placed it, changing nothing', async () => {
  const account = await temporaryDirectory();
  const home = join(account, '.house-kit');
  const workspace = join(account, 'AgentsHouse');
  await put(join(home, 'credential.json'), JSON.stringify({ house: HOUSE, environment: 'environment-one', credential: 'ahk_held' }));
  await put(join(workspace, 'agents', 'agent-1', 'notes.md'), 'kept\n');
  const environment = { HOME: account, HOUSE_KIT_PREFIX: '/opt/house-kit', HOUSE_KIT_HOME: home, HOUSE_KIT_WORKSPACE: workspace };
  const settings = async (...operands: string[]) => {
    const kit = runKit(['settings', ...operands], environment);
    return { status: await kit.exited, stdout: kit.stdout(), stderr: kit.stderr() };
  };

  expect(await settings('workspace', join(account, 'elsewhere'))).toEqual({
    status: 1,
    stdout: '',
    stderr: `house: Kit runs where an earlier install placed it; its workspace changes once Kit moves into ${join(account, '.agents', 'house')}\n`,
  });
  expect(await settings()).toEqual({ status: 0, stdout: `skills all\nworkspace ${workspace}\n`, stderr: '' });
  expect(await readFile(join(workspace, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
  await absent(join(account, 'elsewhere'));
});

it('changes a setting through a Kit process that waits for a login', async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: true, workspace: home }));
  const waiting = runKit(['resident'], { HOME: accountOf(home) });
  await until(() => waiting.stderr().includes('this Environment is not connected; run house login'));

  const changed = await kitSettings(home, 'skills', FIRST);

  expect(changed).toEqual({ status: 0, stdout: `skills ${FIRST}\nworkspace ${home}\n`, stderr: '' });
  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toEqual({ skills: [FIRST], workspace: home });
});

it('refuses to move the workspace of a Kit logged out of its Environment, which cannot tell the folders its Agents’ owners chose, changing nothing', async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: false, workspace: houseOf(home) }));
  await writeFile(join(home, 'disconnected.json'), JSON.stringify({ house: HOUSE, environment: 'environment-one' }));
  await put(join(houseOf(home), 'agents', 'reader', 'chosen.md'), 'chosen\n');
  const workspace = join(await temporaryDirectory(), 'workspace');

  expect(await kitSettings(home, 'workspace', workspace)).toEqual({
    status: 1,
    stdout: '',
    stderr: "house: Kit is logged out, so it cannot tell which Agents' folders their owners chose; run house login, then change its workspace\n",
  });
  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toEqual({ skills: false, workspace: houseOf(home) });
  expect(await readFile(join(houseOf(home), 'agents', 'reader', 'chosen.md'), 'utf8')).toBe('chosen\n');
  await absent(workspace);
});

it('declares its skills as all or a list and changes them for a settings Kit call and for house settings, declaring them again', async () => {
  const hosted = await hostKit([{}], { tools: { guide: catalogue(NAMES) } });
  expect(hosted.reports[0]).toMatchObject({ settings: { skills: [], workspace: hosted.workspace } });

  const call = callSettings(hosted, { skills: 'all' });

  expect(await hosted.result(call)).toEqual({ settings: { skills: 'all', workspace: hosted.workspace } });
  await lastReport(hosted, (report) => (report.settings as { skills: unknown }).skills === 'all');
  expect(JSON.parse(await readFile(join(hosted.home, 'skill-set.json'), 'utf8'))).toMatchObject({ origin: hosted.house.origin, names: NAMES });

  const declared = hosted.reports.length;
  expect(await kitSettings(hosted.home, 'skills', FIRST)).toEqual({ status: 0, stdout: `skills ${FIRST}\nworkspace ${hosted.workspace}\n`, stderr: '' });
  expect(await lastReport(hosted, (report) => Array.isArray((report.settings as { skills: unknown }).skills), declared)).toMatchObject({ settings: { skills: [FIRST] } });
  expect(JSON.parse(await readFile(join(hosted.home, 'skill-set.json'), 'utf8'))).toMatchObject({ names: [FIRST] });

  const none = callSettings(hosted, { skills: [] });

  expect(await hosted.result(none)).toEqual({ settings: { skills: [], workspace: hosted.workspace } });
  await absent(join(hosted.home, 'skill-set.json'));
  expect(alive(hosted.kit.pid)).toBe(true);
});

it('moves the workspace for house settings within one filesystem, keeping a Local copy’s history and uncommitted files, and ends so its supervisor starts it on the new root', async () => {
  const workspace = join(await temporaryDirectory(), 'workspace');
  const hosted = await hostKit([{}], { prepare: (home) => filled(home) });
  expect((await stat(hosted.home)).dev).toBe((await stat(dirname(workspace))).dev);

  expect(await kitSettings(hosted.home, 'workspace', workspace)).toEqual({ status: 0, stdout: `skills\nworkspace ${workspace}\n`, stderr: '' });

  expect(await hosted.kit.exited).toBe(1);
  await followed(hosted.home, workspace);
  const reported = hosted.reports.length;
  await hosted.restart();
  expect(await until(() => hosted.reports[reported])).toMatchObject({ agent_base: join(workspace, 'agents'), settings: { skills: [], workspace } });
});

it('moves the workspace for a settings Kit call across filesystems, copying and checking before the old folders go, and answers the call House sends again once it starts on the new root', async () => {
  const workspace = await otherFilesystem();
  const hosted = await hostKit([{}], { prepare: (home) => filled(home) });
  expect((await stat(hosted.home)).dev).not.toBe((await stat('/dev/shm')).dev);

  const call = callSettings(hosted, { workspace });

  expect(await hosted.kit.exited).toBe(1);
  expect(hosted.results.map((result) => (result.body as { call: string }).call)).not.toContain(call);
  await followed(hosted.home, workspace);
  await hosted.restart();
  callSettings(hosted, { workspace }, call);
  expect(await hosted.result(call)).toEqual({ settings: { skills: [], workspace } });
  expect(alive(hosted.kit.pid)).toBe(true);
});

it('keeps where they are the folders inside the workspace its owner chose for an Agent, and the Local copy an Agent works in with its record, moving every other', async () => {
  const workspace = join(await temporaryDirectory(), 'workspace');
  const home = await temporaryHome();
  const house = houseOf(home);
  const routes = [
    { working_directory: join(house, 'agents', 'reader') },
    { agent_id: 'agent-2', working_directory: join(house, 'agents', 'agent-2') },
    { agent_id: 'agent-3', working_directory: join(house, 'rooms', 'notes') },
  ];
  const hosted = await hostKit(routes, {
    home,
    skills: [],
    prepare: async () => {
      await filled(home);
      await put(join(house, 'agents', 'reader', 'chosen.md'), 'chosen\n');
      await put(join(house, 'agents', 'agent-2', 'default.md'), 'default\n');
    },
  });

  const call = callSettings(hosted, { workspace });

  expect(await hosted.kit.exited).toBe(1);
  expect(await readFile(join(house, 'agents', 'reader', 'chosen.md'), 'utf8')).toBe('chosen\n');
  expect(await readFile(join(workspace, 'agents', 'agent-2', 'default.md'), 'utf8')).toBe('default\n');
  expect(await readFile(join(workspace, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
  await absent(join(workspace, 'agents', 'reader'));
  const repository = join(house, 'rooms', 'notes');
  expect(git(repository, 'status', '--porcelain')).toBe('?? draft.md\n');
  const record = JSON.parse(await readFile(join(hosted.home, 'local-copies', 'rooms', 'r_notes.json'), 'utf8')) as { repository: string };
  expect(record.repository).toBe(repository);
  await hosted.restart();
  callSettings(hosted, { workspace }, call);
  expect(await hosted.result(call)).toEqual({ settings: { skills: [], workspace } });
});

it('moves every folder back and answers why when a move across filesystems fails, ending so it runs on the root it had', async () => {
  const workspace = await otherFilesystem();
  const hosted = await hostKit([{}], {
    prepare: async (home) => {
      await filled(home);
      await put(join(houseOf(home), 'rooms', 'notes', 'unreadable.md'), 'secret\n');
      await chmod(join(houseOf(home), 'rooms', 'notes', 'unreadable.md'), 0o000);
    },
  });
  const settings = await readFile(join(hosted.home, 'kit.json'), 'utf8');

  const call = callSettings(hosted, { workspace });

  expect(await hosted.kit.exited).toBe(1);
  await chmod(join(hosted.workspace, 'rooms', 'notes', 'unreadable.md'), 0o600);
  expect(await readFile(join(hosted.workspace, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
  expect(git(join(hosted.workspace, 'rooms', 'notes'), 'log', '--format=%s')).toBe('the plan\n');
  expect(await readFile(join(hosted.home, 'kit.json'), 'utf8')).toBe(settings);
  await absent(join(hosted.home, 'workspace-move.json'));
  expect(await readdir(workspace).catch(() => [])).toEqual([]);
  await hosted.restart();
  callSettings(hosted, { workspace }, call);
  const answered = (await hosted.result(call)) as { refused: string };
  expect(answered.refused).toMatch(new RegExp(`^the workspace could not be moved to ${workspace}: .*EACCES`, 'u'));
  expect(await readFile(join(hosted.workspace, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
});

it('finishes a move an ended Kit process left unfinished when it starts, from what it finds', async () => {
  const workspace = await otherFilesystem();
  const hosted = await hostKit([{}], {
    prepare: async (home) => {
      await filled(home);
      await put(join(workspace, 'agents', 'agent-1.moving', 'notes.md'), 'ke');
      await writeFile(join(home, 'workspace-move.json'), JSON.stringify({ from: houseOf(home), to: workspace }));
    },
  });

  await followed(hosted.home, workspace);
  await absent(join(workspace, 'agents', 'agent-1.moving'));
  await absent(join(hosted.home, 'workspace-move.json'));
  expect(hosted.reports[0]).toMatchObject({ agent_base: join(workspace, 'agents'), settings: { skills: [], workspace } });
});

it('refuses a workspace that already holds an agents or rooms folder, changing nothing', async () => {
  const taken = join(await temporaryDirectory(), 'taken');
  await put(join(taken, 'rooms', 'mine.md'), 'mine\n');
  const hosted = await hostKit([{}], { prepare: (home) => filled(home) });
  const settings = await readFile(join(hosted.home, 'kit.json'), 'utf8');

  const call = callSettings(hosted, { workspace: taken });

  expect(await hosted.result(call)).toEqual({ refused: `${taken} already holds ${join(taken, 'rooms')}` });
  expect(await readFile(join(hosted.home, 'kit.json'), 'utf8')).toBe(settings);
  expect(await readdir(taken)).toEqual(['rooms']);
  expect(await readFile(join(hosted.workspace, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
  const agents = join(await temporaryDirectory(), 'agents-taken');
  await put(join(agents, 'agents', 'mine.md'), 'mine\n');
  expect(await hosted.result(callSettings(hosted, { workspace: agents }))).toEqual({ refused: `${agents} already holds ${join(agents, 'agents')}` });
  expect(await readFile(join(hosted.workspace, 'rooms', 'notes', 'plan.md'), 'utf8')).toBe('plan\n');
  await settle();
  expect(alive(hosted.kit.pid)).toBe(true);
});

it('refuses to move the workspace while another Kit call is carried, a function run among them, and keeps it running', async () => {
  const workspace = join(await temporaryDirectory(), 'workspace');
  const hosted = await hostKit();
  const go = join(hosted.home, 'go');
  hosted.call({
    kind: 'run_function',
    conversation_id: null,
    agent_id: null,
    script: `while [ ! -e '${go}' ]; do sleep 0.1; done`,
    input: null,
    terminal: false,
    time_cap: 60,
    output_cap: 65_536,
  });
  const running = lastCall();
  await settle();

  const call = callSettings(hosted, { workspace });

  expect(await hosted.result(call)).toEqual({ refused: 'an Agent is working; change the workspace once its turn ends' });
  await absent(workspace);
  await writeFile(go, '');
  expect(await hosted.result(running)).toMatchObject({ exit_code: 0 });
  expect(alive(hosted.kit.pid)).toBe(true);
});

it('moves the workspace for a change House sends as a skills and a workspace Kit call, while the skills call still returns its Result', async () => {
  const workspace = join(await temporaryDirectory(), 'workspace');
  const hosted = await hostKit([{}], { tools: { guide: catalogue(NAMES) } });
  const first = hosted.kit;
  const skills = `settings-${randomUUID()}`;
  hosted.house.route('POST', '/kit/kit-calls/results/return', async (request) => {
    if ((request.body as { call: string }).call === skills) await first.exited;
    else hosted.results.push(request);
    return { body: {} };
  });

  callSettings(hosted, { skills: 'all' }, skills);
  const move = callSettings(hosted, { workspace });

  expect(await hosted.kit.exited).toBe(1);
  expect(JSON.parse(await readFile(join(hosted.home, 'kit.json'), 'utf8'))).toEqual({ skills: 'all', workspace });
  hosted.house.route('POST', '/kit/kit-calls/results/return', (request) => {
    hosted.results.push(request);
    return { body: {} };
  });
  await hosted.restart();
  callSettings(hosted, { skills: 'all' }, skills);
  callSettings(hosted, { workspace }, move);
  expect(await hosted.result(skills)).toEqual({ settings: { skills: 'all', workspace } });
  expect(await hosted.result(move)).toEqual({ settings: { skills: 'all', workspace } });
  expect(JSON.parse(await readFile(join(hosted.home, 'skill-set.json'), 'utf8'))).toMatchObject({ origin: hosted.house.origin });
});

it('refuses to move the workspace while a turn is open, saying an Agent is working, and keeps the turn running', async () => {
  const workspace = join(await temporaryDirectory(), 'workspace');
  const hosted = await hostKit();
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.call({ kind: 'message', text: '@gate go\n@say done', first: true });
  await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/start'));

  const call = callSettings(hosted, { workspace });

  expect(await hosted.result(call)).toEqual({ refused: 'an Agent is working; change the workspace once its turn ends' });
  await absent(workspace);
  expect(JSON.parse(await readFile(join(hosted.home, 'kit.json'), 'utf8'))).toEqual({ skills: [], workspace: hosted.workspace });
  await writeFile(join(hosted.home, 'go'), '');
  await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end'));
  expect(alive(hosted.kit.pid)).toBe(true);
});

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listSkills } from '@agentshouse/skills';
import { expect, it, onTestFinished } from 'vitest';
import { settle, until } from './double.ts';
import { GIT_IDENTITY, hostKit, lastCall, type Hosted } from './environment.ts';
import { accountOf, alive, runKit, temporaryDirectory, temporaryHome } from './kit.ts';

const HOUSE = 'https://house.example';

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

async function filled(home: string, workspace: string): Promise<void> {
  await put(join(workspace, 'agents', 'agent-1', 'notes.md'), 'kept\n');
  const repository = join(workspace, 'local-copies', 'rooms', 'r_notes');
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
  const repository = join(workspace, 'local-copies', 'rooms', 'r_notes');
  expect(git(repository, 'log', '--format=%s')).toBe('the plan\n');
  expect(git(repository, 'status', '--porcelain')).toBe('?? draft.md\n');
  expect(await readFile(join(repository, 'draft.md'), 'utf8')).toBe('not committed\n');
  const record = JSON.parse(await readFile(join(home, 'local-copies', 'rooms', 'r_notes.json'), 'utf8')) as { repository: string; moves: { worktree: string }[] };
  expect(record.repository).toBe(repository);
  expect(record.moves[0]!.worktree).toBe(repository);
  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toMatchObject({ workspace });
  await absent(join(home, 'agents'));
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

async function lastReport(hosted: Hosted, reported: (report: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return until(() => hosted.reports.findLast(reported));
}

async function enrolled(skills: boolean): Promise<string> {
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: HOUSE, environment: 'environment-one', credential: 'ahk_held' }));
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills, workspace: home }));
  return home;
}

it('prints the two settings and turns placing the Skill set off and on again with no Kit process running', async () => {
  const home = await enrolled(true);
  const skills = join(accountOf(home), '.agents', 'skills');
  const names = listSkills().map(({ name }) => name);

  expect(await kitSettings(home)).toEqual({ status: 0, stdout: `skills on\nworkspace ${home}\n`, stderr: '' });

  expect(await kitSettings(home, 'skills', 'off')).toEqual({ status: 0, stdout: `skills off\nworkspace ${home}\n`, stderr: '' });
  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toEqual({ skills: false, workspace: home });
  await absent(join(home, 'skill-set.json'));

  expect(await kitSettings(home, 'skills', 'on')).toEqual({ status: 0, stdout: `skills on\nworkspace ${home}\n`, stderr: '' });
  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toEqual({ skills: true, workspace: home });
  expect((await readdir(skills)).sort()).toEqual(expect.arrayContaining(names));

  expect(await kitSettings(home, 'skills', 'off')).toMatchObject({ status: 0 });
  expect(await readdir(skills)).toEqual([]);
});

it('refuses a workspace that is no absolute path, or one the account cannot write, changing nothing', async () => {
  const home = await enrolled(false);
  const settings = await readFile(join(home, 'kit.json'), 'utf8');

  expect(await kitSettings(home, 'workspace', 'agents')).toEqual({ status: 1, stdout: '', stderr: 'kit: agents is not an absolute path\n' });
  expect(await kitSettings(home, 'workspace', '/proc/kit')).toEqual({ status: 1, stdout: '', stderr: 'kit: this account cannot write /proc/kit\n' });
  expect(await kitSettings(home, 'skills', 'maybe')).toMatchObject({ status: 1, stderr: 'kit: usage: kit settings [skills on|off | workspace <absolute path>]\n' });
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
    stderr: `kit: Kit runs where an earlier install placed it; its workspace changes once Kit moves into ${join(account, '.agents', 'house')}\n`,
  });
  expect(await settings()).toEqual({ status: 0, stdout: `skills on\nworkspace ${workspace}\n`, stderr: '' });
  expect(await readFile(join(workspace, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
  await absent(join(account, 'elsewhere'));
});

it('changes a setting through a Kit process that waits for a login', async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: true, workspace: home }));
  const waiting = runKit(['resident'], { HOME: accountOf(home) });
  await until(() => waiting.stderr().includes('this Environment is not connected; run kit login'));

  const changed = await kitSettings(home, 'skills', 'off');

  expect(changed).toEqual({ status: 0, stdout: `skills off\nworkspace ${home}\n`, stderr: '' });
  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toEqual({ skills: false, workspace: home });
});

it('refuses to move the workspace of a Kit logged out of its Environment, which cannot tell the folders its Agents’ owners chose, changing nothing', async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: false, workspace: home }));
  await writeFile(join(home, 'disconnected.json'), JSON.stringify({ house: HOUSE, environment: 'environment-one' }));
  await put(join(home, 'agents', 'reader', 'chosen.md'), 'chosen\n');
  const workspace = join(await temporaryDirectory(), 'workspace');

  expect(await kitSettings(home, 'workspace', workspace)).toEqual({
    status: 1,
    stdout: '',
    stderr: "kit: Kit is logged out, so it cannot tell which Agents' folders their owners chose; run kit login, then change its workspace\n",
  });
  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toEqual({ skills: false, workspace: home });
  expect(await readFile(join(home, 'agents', 'reader', 'chosen.md'), 'utf8')).toBe('chosen\n');
  await absent(workspace);
});

it('declares its settings and changes placing the Skill set for a settings Kit call and for kit settings, declaring them again', async () => {
  const hosted = await hostKit();
  expect(hosted.reports[0]).toMatchObject({ settings: { skills: false, workspace: hosted.home } });

  const call = callSettings(hosted, { skills: true });

  expect(await hosted.result(call)).toEqual({ settings: { skills: true, workspace: hosted.home } });
  await lastReport(hosted, (report) => (report.settings as { skills: boolean }).skills);
  expect(JSON.parse(await readFile(join(hosted.home, 'skill-set.json'), 'utf8'))).toMatchObject({ origin: hosted.house.origin });

  expect(await kitSettings(hosted.home, 'skills', 'off')).toEqual({ status: 0, stdout: `skills off\nworkspace ${hosted.home}\n`, stderr: '' });
  await lastReport(hosted, (report) => !(report.settings as { skills: boolean }).skills);
  await absent(join(hosted.home, 'skill-set.json'));
  expect(alive(hosted.kit.pid)).toBe(true);
});

it('moves the workspace for kit settings within one filesystem, keeping a Local copy’s history and uncommitted files, and ends so its supervisor starts it on the new root', async () => {
  const workspace = join(await temporaryDirectory(), 'workspace');
  const hosted = await hostKit([{}], { prepare: (home) => filled(home, home) });
  expect((await stat(hosted.home)).dev).toBe((await stat(dirname(workspace))).dev);

  expect(await kitSettings(hosted.home, 'workspace', workspace)).toEqual({ status: 0, stdout: `skills off\nworkspace ${workspace}\n`, stderr: '' });

  expect(await hosted.kit.exited).toBe(1);
  await followed(hosted.home, workspace);
  const reported = hosted.reports.length;
  await hosted.restart();
  expect(await until(() => hosted.reports[reported])).toMatchObject({ agent_base: join(workspace, 'agents'), settings: { skills: false, workspace } });
});

it('moves the workspace for a settings Kit call across filesystems, copying and checking before the old folders go, and answers the call House sends again once it starts on the new root', async () => {
  const workspace = await otherFilesystem();
  const hosted = await hostKit([{}], { prepare: (home) => filled(home, home) });
  expect((await stat(hosted.home)).dev).not.toBe((await stat('/dev/shm')).dev);

  const call = callSettings(hosted, { workspace });

  expect(await hosted.kit.exited).toBe(1);
  expect(hosted.results.map((result) => (result.body as { call: string }).call)).not.toContain(call);
  await followed(hosted.home, workspace);
  await hosted.restart();
  callSettings(hosted, { workspace }, call);
  expect(await hosted.result(call)).toEqual({ settings: { skills: false, workspace } });
  expect(alive(hosted.kit.pid)).toBe(true);
});

it('keeps where they are the folders inside the workspace its owner chose for an Agent, and the Local copy an Agent works in with its record, moving every other', async () => {
  const workspace = join(await temporaryDirectory(), 'workspace');
  const home = await temporaryHome();
  const routes = [
    { working_directory: join(home, 'agents', 'reader') },
    { agent_id: 'agent-2', working_directory: join(home, 'agents', 'agent-2') },
    { agent_id: 'agent-3', working_directory: join(home, 'local-copies', 'rooms', 'r_notes') },
  ];
  const hosted = await hostKit(routes, {
    home,
    skills: false,
    prepare: async () => {
      await filled(home, home);
      await put(join(home, 'agents', 'reader', 'chosen.md'), 'chosen\n');
      await put(join(home, 'agents', 'agent-2', 'default.md'), 'default\n');
    },
  });

  const call = callSettings(hosted, { workspace });

  expect(await hosted.kit.exited).toBe(1);
  expect(await readFile(join(hosted.home, 'agents', 'reader', 'chosen.md'), 'utf8')).toBe('chosen\n');
  expect(await readFile(join(workspace, 'agents', 'agent-2', 'default.md'), 'utf8')).toBe('default\n');
  expect(await readFile(join(workspace, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
  await absent(join(workspace, 'agents', 'reader'));
  const repository = join(hosted.home, 'local-copies', 'rooms', 'r_notes');
  expect(git(repository, 'status', '--porcelain')).toBe('?? draft.md\n');
  const record = JSON.parse(await readFile(join(hosted.home, 'local-copies', 'rooms', 'r_notes.json'), 'utf8')) as { repository: string };
  expect(record.repository).toBe(repository);
  await hosted.restart();
  callSettings(hosted, { workspace }, call);
  expect(await hosted.result(call)).toEqual({ settings: { skills: false, workspace } });
});

it('moves every folder back and answers why when a move across filesystems fails, ending so it runs on the root it had', async () => {
  const workspace = await otherFilesystem();
  const hosted = await hostKit([{}], {
    prepare: async (home) => {
      await filled(home, home);
      await put(join(home, 'local-copies', 'rooms', 'r_notes', 'unreadable.md'), 'secret\n');
      await chmod(join(home, 'local-copies', 'rooms', 'r_notes', 'unreadable.md'), 0o000);
    },
  });
  const settings = await readFile(join(hosted.home, 'kit.json'), 'utf8');

  const call = callSettings(hosted, { workspace });

  expect(await hosted.kit.exited).toBe(1);
  await chmod(join(hosted.home, 'local-copies', 'rooms', 'r_notes', 'unreadable.md'), 0o600);
  expect(await readFile(join(hosted.home, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
  expect(git(join(hosted.home, 'local-copies', 'rooms', 'r_notes'), 'log', '--format=%s')).toBe('the plan\n');
  expect(await readFile(join(hosted.home, 'kit.json'), 'utf8')).toBe(settings);
  await absent(join(hosted.home, 'workspace-move.json'));
  expect(await readdir(workspace).catch(() => [])).toEqual([]);
  await hosted.restart();
  callSettings(hosted, { workspace }, call);
  const answered = (await hosted.result(call)) as { refused: string };
  expect(answered.refused).toMatch(new RegExp(`^the workspace could not be moved to ${workspace}: .*EACCES`, 'u'));
  expect(await readFile(join(hosted.home, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
});

it('finishes a move an ended Kit process left unfinished when it starts, from what it finds', async () => {
  const workspace = await otherFilesystem();
  const hosted = await hostKit([{}], {
    prepare: async (home) => {
      await filled(home, home);
      await put(join(workspace, 'agents', 'agent-1.moving', 'notes.md'), 'ke');
      await writeFile(join(home, 'workspace-move.json'), JSON.stringify({ from: home, to: workspace }));
    },
  });

  await followed(hosted.home, workspace);
  await absent(join(workspace, 'agents', 'agent-1.moving'));
  await absent(join(hosted.home, 'workspace-move.json'));
  expect(hosted.reports[0]).toMatchObject({ agent_base: join(workspace, 'agents'), settings: { skills: false, workspace } });
});

it('refuses a workspace that already holds an agents or local-copies folder, changing nothing', async () => {
  const taken = join(await temporaryDirectory(), 'taken');
  await put(join(taken, 'local-copies', 'mine.md'), 'mine\n');
  const hosted = await hostKit([{}], { prepare: (home) => filled(home, home) });
  const settings = await readFile(join(hosted.home, 'kit.json'), 'utf8');

  const call = callSettings(hosted, { workspace: taken });

  expect(await hosted.result(call)).toEqual({ refused: `${taken} already holds ${join(taken, 'local-copies')}` });
  expect(await readFile(join(hosted.home, 'kit.json'), 'utf8')).toBe(settings);
  expect(await readdir(taken)).toEqual(['local-copies']);
  expect(await readFile(join(hosted.home, 'agents', 'agent-1', 'notes.md'), 'utf8')).toBe('kept\n');
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
  const hosted = await hostKit();
  const first = hosted.kit;
  const skills = `settings-${randomUUID()}`;
  hosted.house.route('POST', '/kit/kit-calls/results/return', async (request) => {
    if ((request.body as { call: string }).call === skills) await first.exited;
    else hosted.results.push(request);
    return { body: {} };
  });

  callSettings(hosted, { skills: true }, skills);
  const move = callSettings(hosted, { workspace });

  expect(await hosted.kit.exited).toBe(1);
  expect(JSON.parse(await readFile(join(hosted.home, 'kit.json'), 'utf8'))).toEqual({ skills: true, workspace });
  hosted.house.route('POST', '/kit/kit-calls/results/return', (request) => {
    hosted.results.push(request);
    return { body: {} };
  });
  await hosted.restart();
  callSettings(hosted, { skills: true }, skills);
  callSettings(hosted, { workspace }, move);
  expect(await hosted.result(skills)).toEqual({ settings: { skills: true, workspace } });
  expect(await hosted.result(move)).toEqual({ settings: { skills: true, workspace } });
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
  expect(JSON.parse(await readFile(join(hosted.home, 'kit.json'), 'utf8'))).not.toHaveProperty('workspace');
  await writeFile(join(hosted.home, 'go'), '');
  await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end'));
  expect(alive(hosted.kit.pid)).toBe(true);
});

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { settle, until, type Received } from './double.ts';
import { clocked, GIT_IDENTITY, hostKit, lastCall, shelled, type Hosted, type Hosting, type RouteOverrides } from './environment.ts';
import { temporaryDirectory } from './kit.ts';
import { serveRooms, type Room } from './rooms.ts';

const HOUR = 60 * 60_000;
const LIST = '/rooms/notes/settings/repositories.md';

type Code = { kind: 'main' } | { kind: 'new_worktree'; branch?: string } | { kind: 'existing'; path: string; branch: string };
type Copy = { kind: 'none' } | { kind: 'new' } | { kind: 'existing'; path: string };

interface Origin {
  url: string;
  main: string;
  release: string;
}

interface Launched {
  pid: number;
  env: Record<string, string>;
  argv: string[];
}

function git(cwd: string, ...args: string[]): string {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY } });
  if (ran.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${ran.stderr}`);
  return ran.stdout.trim();
}

async function origin(): Promise<Origin> {
  const root = await temporaryDirectory();
  const work = join(root, 'work');
  await mkdir(work);
  git(work, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(work, 'app.txt'), 'one\n');
  git(work, 'add', 'app.txt');
  git(work, 'commit', '--quiet', '-m', 'one');
  git(work, 'switch', '--quiet', '-c', 'release');
  await writeFile(join(work, 'app.txt'), 'two\n');
  git(work, 'commit', '--quiet', '-am', 'two');
  git(work, 'switch', '--quiet', 'main');
  const url = join(root, 'app.git');
  git(root, 'clone', '--quiet', '--bare', work, url);
  git(url, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  return { url, main: git(url, 'rev-parse', 'main'), release: git(url, 'rev-parse', 'release') };
}

function repositories(hosted: Hosted): string {
  return join(hosted.workspace, 'repositories');
}

function cloned(hosted: Hosted, url: string): string {
  const clone = join(repositories(hosted), 'app');
  git(tmpdir(), 'clone', '--quiet', url, clone);
  return clone;
}

function listing(entries: Record<string, string>[]): string {
  const lines = entries.flatMap((entry) => Object.entries(entry).map(([field, value], index) => `${index === 0 ? '  - ' : '    '}${field}: ${JSON.stringify(value)}`));
  return ['---', 'repositories:', ...lines, '---', '', 'The code this Room works on.', ''].join('\n');
}

function listed(hosted: Hosted, document: string): void {
  hosted.tools.shell = (args) =>
    args.command === `cat ${LIST}` ? shelled(document) : shelled('', 1, [`cat: path_not_found ${String(args.command).replace(/^cat /u, '')}`]);
}

function listReads(hosted: Hosted): number {
  return hosted.mcp.filter((received: Received) => {
    const { name, arguments: args } = (received.body as { params: { name?: string; arguments?: { command?: unknown } } }).params;
    return name === 'shell' && args?.command === `cat ${LIST}`;
  }).length;
}

async function staged(routes: RouteOverrides[], hosting: Hosting = {}): Promise<{ hosted: Hosted; notes: Room; garden: Room }> {
  const hosted = await hostKit(routes, hosting);
  const rooms = serveRooms(hosted);
  const notes = rooms.room('notes');
  notes.put('plan.md', 'Plant beans\n');
  const garden = rooms.room('garden');
  rooms.answered = [notes];
  await rooms.download([notes]);
  return { hosted, notes, garden };
}

function copyOf(hosted: Hosted, name: string): string {
  return join(hosted.workspace, 'conversations', 'notes', name);
}

async function opened(
  hosted: Hosted,
  index: number,
  room: Room,
  name: string,
  repository: { url: string; code: Code } | null,
  copy: Copy = { kind: 'new' },
): Promise<{ provider_session_id?: string; refused?: string }> {
  hosted.call({ kind: 'open', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, room_ref: room.ref, name, run: { name, copy, repository } });
  return (await hosted.result(lastCall())) as { provider_session_id?: string; refused?: string };
}

async function session(hosted: Hosted, index: number, room: Room, name: string, url: string, code: Code): Promise<string> {
  const answer = await opened(hosted, index, room, name, { url, code });
  if (answer.provider_session_id === undefined) throw new Error(`the open was refused: ${answer.refused}`);
  return answer.provider_session_id;
}

async function logged(hosted: Hosted, method: string): Promise<Record<string, unknown>[]> {
  return (await hosted.adapterLog()).filter((entry) => entry.method === method);
}

async function opening(hosted: Hosted, method: 'session/new' | 'session/resume', index: number): Promise<{ pid: number; params: Record<string, unknown> }> {
  const sessions = await until(async () => {
    const written = await logged(hosted, method);
    return written.length > index ? written : undefined;
  });
  return sessions[index] as { pid: number; params: Record<string, unknown> };
}

async function cwdOf(hosted: Hosted, method: 'session/new' | 'session/resume', index: number): Promise<unknown> {
  return (await opening(hosted, method, index)).params.cwd;
}

async function launched(hosted: Hosted, method: 'session/new' | 'session/resume', index: number): Promise<Launched> {
  const { pid } = await opening(hosted, method, index);
  return (await logged(hosted, 'initialize')).find((entry) => entry.pid === pid) as unknown as Launched;
}

async function writableRoots(hosted: Hosted, method: 'session/new' | 'session/resume', index: number): Promise<unknown> {
  const config = JSON.parse((await launched(hosted, method, index)).env.CODEX_CONFIG!) as { sandbox_workspace_write?: { writable_roots?: unknown } };
  return config.sandbox_workspace_write?.writable_roots;
}

function claudeSettings(params: Record<string, unknown>): Record<string, unknown> {
  return ((params._meta as { claudeCode: { options: { settings: Record<string, unknown> } } }).claudeCode.options.settings);
}

function ended(hosted: Hosted): number {
  return hosted.turns.filter((turn) => turn.path === '/kit/turns/end').length;
}

async function turn(hosted: Hosted, index: number, text: string, fields: Record<string, unknown> = {}): Promise<void> {
  const before = ended(hosted);
  hosted.call({ kind: 'message', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, text, first: false, ...fields });
  await until(() => ended(hosted) > before);
  await settle();
}

async function killed(hosted: Hosted, index: number, deleted?: true): Promise<unknown> {
  hosted.call({ kind: 'kill', conversation_id: `conversation-${index}`, agent_id: `agent-${index}`, ...(deleted === undefined ? {} : { deleted }) });
  return hosted.result(lastCall());
}

function worktrees(clone: string): string[] {
  return git(clone, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '));
}

it("gives a Run the clone's folder on whatever branch it has checked out, a new worktree beside the clone on its starter's branch or else its name, from the branch or commit the Room's list names for its entry at its first turn or else origin's default, or the existing worktree passed, starting its CLI in its copy every time and giving each later session of the Run, resumed or opened again, the folder its first had", async () => {
  const { hosted, notes } = await staged([{}, {}, {}, {}, {}]);
  const app = await origin();
  const clone = cloned(hosted, app.url);
  git(clone, 'switch', '--quiet', '-c', 'mine', 'origin/release');
  const held = join(await temporaryDirectory(), 'held');
  git(clone, 'worktree', 'add', '--quiet', '-b', 'held', held, 'origin/main');
  const added = `${clone}.worktrees`;

  await session(hosted, 1, notes, 'imp-1', app.url, { kind: 'main' });
  listed(hosted, listing([{ url: app.url, ref: 'release', access: 'write' }]));
  const second = await session(hosted, 2, notes, 'imp-2', app.url, { kind: 'new_worktree', branch: 'feat/two' });
  listed(hosted, listing([{ url: 'https://example.com/acme/other' }, { url: app.url, ref: app.release }]));
  await session(hosted, 3, notes, 'imp-3', app.url, { kind: 'new_worktree' });
  listed(hosted, listing([{ url: app.url, access: 'read' }]));
  await session(hosted, 4, notes, 'imp-4', app.url, { kind: 'new_worktree' });
  await session(hosted, 5, notes, 'rev-1', app.url, { kind: 'existing', path: held, branch: 'held' });

  const folders = [clone, join(added, 'feat', 'two'), join(added, 'imp-3'), join(added, 'imp-4'), held];
  for (const [index, name] of ['imp-1', 'imp-2', 'imp-3', 'imp-4', 'rev-1'].entries()) {
    expect(await cwdOf(hosted, 'session/new', index)).toBe(copyOf(hosted, name));
    expect(await writableRoots(hosted, 'session/new', index)).toEqual([folders[index]]);
  }
  expect(git(clone, 'branch', '--show-current')).toBe('mine');
  expect(git(folders[1]!, 'branch', '--show-current')).toBe('feat/two');
  expect(git(folders[1]!, 'rev-parse', 'HEAD')).toBe(app.release);
  expect(git(folders[2]!, 'branch', '--show-current')).toBe('imp-3');
  expect(git(folders[2]!, 'rev-parse', 'HEAD')).toBe(app.release);
  expect(git(folders[3]!, 'branch', '--show-current')).toBe('imp-4');
  expect(git(folders[3]!, 'rev-parse', 'HEAD')).toBe(app.main);
  expect(listReads(hosted)).toBe(3);

  await turn(hosted, 2, '@say first');
  expect(await killed(hosted, 2)).toEqual({});
  await turn(hosted, 2, '@say again', { provider_session_id: second });

  expect(await killed(hosted, 3)).toEqual({});
  expect(await opened(hosted, 3, notes, 'imp-3', { url: app.url, code: { kind: 'new_worktree' } })).toHaveProperty('provider_session_id');

  expect(await cwdOf(hosted, 'session/resume', 0)).toBe(copyOf(hosted, 'imp-2'));
  expect(await writableRoots(hosted, 'session/resume', 0)).toEqual([folders[1]]);
  expect(await cwdOf(hosted, 'session/new', 5)).toBe(copyOf(hosted, 'imp-3'));
  expect(await writableRoots(hosted, 'session/new', 5)).toEqual([folders[2]]);
  expect(listReads(hosted)).toBe(3);
  expect(worktrees(clone)).toHaveLength(5);
});

it("leaves a Run not started, naming the cause, where its clone is missing or its origin names another repository, the Room's list no longer names it or the Room is out of reach, Git's fetch fails or its new branch is one the clone holds, or the existing worktree passed is no worktree of the clone on that branch", async () => {
  const { hosted, notes, garden } = await staged([{}, {}, {}, {}, {}, {}, {}, {}]);
  const app = await origin();
  const clone = cloned(hosted, app.url);
  git(clone, 'branch', 'taken');
  const held = join(await temporaryDirectory(), 'held');
  git(clone, 'worktree', 'add', '--quiet', '-b', 'held', held);
  const plain = await temporaryDirectory();
  const elsewhere = join(dirname(dirname(app.url)), 'elsewhere', 'app.git');
  const worktree = (branch?: string): Code => (branch === undefined ? { kind: 'new_worktree' } : { kind: 'new_worktree', branch });
  listed(hosted, listing([{ url: 'https://example.com/acme/other' }]));

  expect(await opened(hosted, 1, notes, 'imp-1', { url: 'https://example.com/acme/gone.git', code: { kind: 'main' } })).toEqual({
    refused: `${join(repositories(hosted), 'gone')} is missing; clone https://example.com/acme/gone.git there`,
  });
  expect(await opened(hosted, 2, notes, 'imp-2', { url: elsewhere, code: { kind: 'main' } })).toEqual({ refused: `${clone} is not a clone of ${elsewhere}` });
  expect(await opened(hosted, 3, notes, 'imp-3', { url: app.url, code: worktree() })).toEqual({
    refused: `the Room's settings/repositories.md lists no repository ${app.url}`,
  });
  expect(await opened(hosted, 4, garden, 'imp-4', { url: app.url, code: worktree() })).toEqual({
    refused: "this Environment does not reach the Run's Room, so Kit cannot read its settings/repositories.md",
  });
  listed(hosted, listing([{ url: app.url, ref: 'nowhere' }]));
  expect(await opened(hosted, 5, notes, 'imp-5', { url: app.url, code: worktree() })).toEqual({ refused: expect.stringContaining("couldn't find remote ref nowhere") });
  listed(hosted, listing([{ url: app.url }]));
  expect(await opened(hosted, 6, notes, 'imp-6', { url: app.url, code: worktree('taken') })).toEqual({
    refused: expect.stringMatching(/\nfatal: a branch named 'taken' already exists$/u),
  });
  expect(await opened(hosted, 7, notes, 'rev-1', { url: app.url, code: { kind: 'existing', path: held, branch: 'main' } })).toEqual({
    refused: `${held} is not a worktree of ${clone} on main`,
  });
  expect(await opened(hosted, 8, notes, 'rev-2', { url: app.url, code: { kind: 'existing', path: plain, branch: 'held' } })).toEqual({
    refused: `${plain} is not a worktree of ${clone} on held`,
  });

  expect(await logged(hosted, 'session/new')).toHaveLength(0);
  expect(worktrees(clone)).toHaveLength(2);
});

it("takes a clone whose origin names the Run's repository by one host and path in its https, ssh or scp form, with or without a user, a port or a trailing .git, and no clone of the same path on another host", async () => {
  const { hosted, notes } = await staged([{}, {}, {}, {}]);
  const clone = join(repositories(hosted), 'app');
  await mkdir(clone, { recursive: true });
  git(clone, 'init', '--quiet');
  git(clone, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
  const forms = ['https://github.com/acme/app', 'ssh://git@github.com:22/acme/app.git', 'https://someone@GitHub.com/acme/app.git/'];

  for (const [index, url] of forms.entries()) await session(hosted, index + 1, notes, `imp-${index + 1}`, url, { kind: 'main' });

  for (const index of [0, 1, 2]) expect(await writableRoots(hosted, 'session/new', index)).toEqual([clone]);
  expect(await opened(hosted, 4, notes, 'imp-4', { url: 'https://gitlab.com/acme/app', code: { kind: 'main' } })).toEqual({
    refused: `${clone} is not a clone of https://gitlab.com/acme/app`,
  });
});

it("starts each CLI in the Run's copy and has it write in the code folder without asking, Claude Code by its permissions' additional directories, Codex by its sandbox's writable roots and Grok Build with its sandbox off and every tool approved, at the session's start and its resume, and gives no code folder to a Run with no repository", async () => {
  const { hosted, notes } = await staged([{ kind: 'claude-agent-acp' }, { kind: 'codex-acp' }, { kind: 'grok-build' }, { kind: 'claude-agent-acp' }, { kind: 'codex-acp' }]);
  const app = await origin();
  const clone = cloned(hosted, app.url);
  const claude = await session(hosted, 1, notes, 'imp-1', app.url, { kind: 'main' });
  const codex = await session(hosted, 2, notes, 'imp-2', app.url, { kind: 'main' });
  await session(hosted, 3, notes, 'imp-3', app.url, { kind: 'main' });
  for (const index of [4, 5]) expect(await opened(hosted, index, notes, `ask-${index}`, null)).toHaveProperty('provider_session_id');
  for (const index of [1, 2]) {
    await turn(hosted, index, '@say first');
    expect(await killed(hosted, index)).toEqual({});
  }
  await turn(hosted, 1, '@say again', { provider_session_id: claude });
  await turn(hosted, 2, '@say again', { provider_session_id: codex });

  for (const [index, name] of ['imp-1', 'imp-2', 'imp-3', 'ask-4', 'ask-5'].entries()) expect(await cwdOf(hosted, 'session/new', index)).toBe(copyOf(hosted, name));
  for (const method of ['session/new', 'session/resume'] as const) {
    const { params } = await opening(hosted, method, 0);
    expect(claudeSettings(params)).toMatchObject({ permissions: { additionalDirectories: [clone] } });
    expect(params).not.toHaveProperty('additionalDirectories');
    expect(await writableRoots(hosted, method, 1)).toEqual([clone]);
  }
  expect(JSON.parse((await launched(hosted, 'session/new', 1)).env.CODEX_CONFIG!)).toEqual({
    features: { shell_zsh_fork: true },
    sandbox_workspace_write: { writable_roots: [clone] },
  });
  expect((await launched(hosted, 'session/new', 2)).argv.join(' ')).toContain('--sandbox off agent --always-approve');
  expect(claudeSettings((await opening(hosted, 'session/new', 3)).params)).not.toHaveProperty('permissions');
  expect(await writableRoots(hosted, 'session/new', 4)).toBeUndefined();
});

it("removes no worktree and no branch where a Run's conversation is deleted or its copy goes after a day with no turn, and refuses to move the workspace while its repositories folder holds anything", async () => {
  const clock = await clocked();
  const { hosted, notes } = await staged([{}, {}], clock.hosting);
  const app = await origin();
  const clone = cloned(hosted, app.url);
  listed(hosted, listing([{ url: app.url }]));
  await session(hosted, 1, notes, 'imp-1', app.url, { kind: 'new_worktree' });
  await session(hosted, 2, notes, 'imp-2', app.url, { kind: 'new_worktree' });
  await turn(hosted, 2, '@say first');
  const added = (name: string) => join(`${clone}.worktrees`, name);

  expect(await killed(hosted, 1, true)).toEqual({});
  expect(await killed(hosted, 2)).toEqual({});
  await clock.shift(25 * HOUR);
  await hosted.restart();
  await until(() => (existsSync(copyOf(hosted, 'imp-2')) ? undefined : true));

  expect(existsSync(copyOf(hosted, 'imp-1'))).toBe(false);
  for (const name of ['imp-1', 'imp-2']) {
    expect((await lstat(added(name))).isDirectory()).toBe(true);
    expect(git(clone, 'rev-parse', '--verify', `refs/heads/${name}`)).toBe(app.main);
  }
  expect(worktrees(clone)).toHaveLength(3);

  const workspace = join(await temporaryDirectory(), 'workspace');
  hosted.call({ input_id: 'settings-refused', conversation_id: null, agent_id: null, provider_session_id: null, kind: 'settings', workspace });
  expect(await hosted.result('settings-refused')).toEqual({
    refused: `${repositories(hosted)} is not empty, and Kit moves no clone or worktree; move them yourself, then change the workspace`,
  });
  expect(existsSync(workspace)).toBe(false);
  expect(await readdir(repositories(hosted))).toEqual(['app', 'app.worktrees']);
});

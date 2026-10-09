import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it } from 'vitest';
import { RELEASES, placeUserCli } from './cli.ts';
import { startHouse, until, type House } from './double.ts';
import { LOGIN_SHELL, placeUserClis, userBin } from './environment.ts';
import { HOST_KEY, fakeBin, placeHostKey, runKit, temporaryHome, type KitRun } from './kit.ts';

const KIT_PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};
const PINNED = KIT_PACKAGE.peerDependencies;
const FAST_INTERVALS = ['--import', fileURLToPath(new URL('./fast-intervals.ts', import.meta.url))];

let house: House;
let kit: KitRun | undefined;
let home: string;
let desired: string[];
const reports: Record<string, unknown>[] = [];

beforeEach(async () => {
  house = await startHouse();
  home = await temporaryHome();
  await writeFile(
    join(home, 'credential.json'),
    JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }),
  );
  reports.length = 0;
  house.route('POST', '/kit/agents/desired', () => ({ body: { agents: desired, routes: [] } }));
  house.route('POST', '/kit/agents/report', ({ body }) => {
    reports.push(body as Record<string, unknown>);
    return { body: {} };
  });
});

async function logged(name: string): Promise<string[]> {
  const log = await readFile(join(home, name), 'utf8').catch(() => '');
  return log.split('\n').filter((line) => line !== '');
}

async function adapterInstalls(): Promise<string[]> {
  return (await logged('npm.log')).map((line) => (JSON.parse(line) as string[]).at(-1)!);
}

async function start(prepare?: () => Promise<void>, node: string[] = [], environment: Record<string, string> = {}) {
  const path = await fakeBin(home);
  await placeUserClis(home);
  await prepare?.();
  kit = runKit(['resident'], { HOUSE_KIT_HOME: home, PATH: path, ...LOGIN_SHELL, ...environment }, node);
}

async function signIn(...kinds: string[]): Promise<void> {
  await mkdir(join(home, 'signed-in'), { recursive: true });
  for (const kind of kinds) await writeFile(join(home, 'signed-in', kind), '');
}

async function probes(): Promise<number> {
  return (await logged('adapter.log')).filter((line) => line.includes('"method":"session/new"')).length;
}

it('pins in its package only the Codex and Claude Code adapters, no CLI and no Grok Build package', () => {
  expect(Object.keys(PINNED).sort()).toEqual(['@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/codex-acp']);
  expect(Object.keys({ ...KIT_PACKAGE.dependencies, ...PINNED }).join(' ')).not.toMatch(/grok|@openai\/codex|claude-code/);
});

it('installs the pinned adapter of each named CLI that has one, and of one a later work frame names', async () => {
  desired = ['codex-acp', 'grok-build'];
  await start();

  await until(() => reports[0]);
  expect(await adapterInstalls()).toEqual([`@agentclientprotocol/codex-acp@${PINNED['@agentclientprotocol/codex-acp']}`]);

  desired = ['codex-acp', 'claude-agent-acp'];
  const socket = await until(() => house.sockets[0]);
  socket.send({ type: 'work_available', subject: 'agents' });

  await until(() => reports[1]);
  expect((await adapterInstalls()).slice(1)).toEqual([
    `@agentclientprotocol/claude-agent-acp@${PINNED['@agentclientprotocol/claude-agent-acp']}`,
  ]);
  expect(await logged('curl.log')).toEqual([]);
});

it('reports the release of each CLI the login shell finds, its sign-in state, the models with the efforts and the modes its session options name and its full-access mode, with the operating system and the Kit version', async () => {
  desired = ['codex-acp', 'claude-agent-acp', 'grok-build'];
  await signIn(...desired);
  await start();

  const report = await until(() => reports[0]);

  expect(report).toEqual({
    os: expect.stringMatching(/\S/),
    kit_version: KIT_PACKAGE.version,
    agent_base: '/agents/house/agents',
    agents: [
      {
        kind: 'codex-acp',
        release: RELEASES['codex-acp'],
        failure: null,
        signed_in: true,
        models: [
          { model: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
          { model: 'gpt-5.5-mini', efforts: ['minimal', 'low', 'medium', 'high'] },
          { model: 'codex-instant', efforts: [] },
        ],
        modes: [
          { mode: 'read-only', name: 'Read-only' },
          { mode: 'workspace-write', name: 'Workspace access' },
          { mode: 'agent', name: 'Auto review' },
          { mode: 'agent-full-access', name: 'Full access' },
        ],
        full_access: 'agent-full-access',
      },
      {
        kind: 'claude-agent-acp',
        release: RELEASES['claude-agent-acp'],
        failure: null,
        signed_in: true,
        models: [
          { model: 'default', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
          { model: 'sonnet', efforts: ['default', 'low', 'medium', 'high', 'max'] },
          { model: 'haiku', efforts: [] },
        ],
        modes: [
          { mode: 'default', name: 'Manual' },
          { mode: 'acceptEdits', name: 'Accept edits' },
          { mode: 'plan', name: 'Plan' },
          { mode: 'auto', name: 'Auto' },
          { mode: 'bypassPermissions', name: 'Bypass permissions' },
        ],
        full_access: 'bypassPermissions',
      },
      {
        kind: 'grok-build',
        release: RELEASES['grok-build'],
        failure: null,
        signed_in: true,
        models: [
          { model: 'grok-4.6', efforts: ['xhigh', 'high', 'medium', 'low'] },
          { model: 'grok-4.5', efforts: ['high', 'medium', 'low'] },
        ],
        modes: [],
        full_access: null,
      },
    ],
  });
});

it('installs each chosen CLI the login shell does not find through its official route into its ordinary place beneath the home, where a later Kit finds it', async () => {
  desired = ['codex-acp', 'claude-agent-acp', 'grok-build'];
  await start(() => rm(userBin(home), { recursive: true }));

  const report = await until(() => reports[0]);

  expect(report.agents).toEqual(desired.map((kind) => expect.objectContaining({ kind, release: RELEASES[kind], failure: null })));
  expect((await logged('curl.log')).sort()).toEqual([
    'https://chatgpt.com/codex/install.sh',
    'https://claude.ai/install.sh',
    'https://x.ai/cli/install.sh',
  ]);
  for (const place of ['.local/bin/codex', '.local/bin/claude', '.grok/bin/grok']) {
    expect(await readFile(join(home, place), 'utf8')).toContain('CLI_RELEASE');
  }

  process.kill(kit!.pid, 'SIGKILL');
  await kit!.exited;
  reports.length = 0;
  kit = runKit(['resident'], { HOUSE_KIT_HOME: home, PATH: await fakeBin(home), ...LOGIN_SHELL });

  expect((await until(() => reports[0])).agents).toEqual(report.agents);
  expect(await logged('curl.log')).toHaveLength(3);
});

it('installs a chosen CLI the login shell does not find though its profile prints a path', async () => {
  desired = ['claude-agent-acp'];
  await start(async () => {
    await rm(join(userBin(home), 'claude'));
    await writeFile(join(home, '.profile'), `echo "$HOME"\n${await readFile(join(home, '.profile'), 'utf8')}`);
  });

  const report = await until(() => reports[0]);

  expect(report.agents).toEqual([expect.objectContaining({ kind: 'claude-agent-acp', release: RELEASES['claude-agent-acp'], failure: null })]);
  expect(await logged('curl.log')).toEqual(['https://claude.ai/install.sh']);
});

it("reports a CLI whose official install failed with no release and the installer's cause, and installs it at a later work frame", async () => {
  desired = ['codex-acp', 'claude-agent-acp'];
  await start(async () => {
    await rm(join(userBin(home), 'claude'));
    await writeFile(join(home, 'install-fail'), 'claude-agent-acp\n');
  });

  const failed = await until(() => reports[0]);

  expect(failed.agents).toEqual([
    expect.objectContaining({ kind: 'codex-acp', release: RELEASES['codex-acp'] }),
    { kind: 'claude-agent-acp', release: null, failure: 'Checksum verification failed', signed_in: false, models: [], modes: [], full_access: 'bypassPermissions' },
  ]);
  expect(kit!.stderr()).toContain('claude-agent-acp did not install: Checksum verification failed');

  await rm(join(home, 'install-fail'));
  house.sockets[0]!.send({ type: 'work_available', subject: 'agents' });

  const recovered = await until(() => reports[1]);
  expect(recovered.agents).toEqual([
    expect.objectContaining({ kind: 'codex-acp', release: RELEASES['codex-acp'] }),
    { kind: 'claude-agent-acp', release: RELEASES['claude-agent-acp'], failure: null, signed_in: false, models: [], modes: [], full_access: 'bypassPermissions' },
  ]);
});

it("keeps the end of a long installer output as the cause, so it stays within what House takes", async () => {
  desired = ['grok-build'];
  await start(async () => {
    await rm(join(userBin(home), 'grok'));
    await writeFile(join(home, 'install-fail'), 'grok-build\n');
    await writeFile(join(home, 'install-output'), `${'Downloading Grok Build\n'.repeat(400)}`);
  });

  const [grok] = (await until(() => reports[0])).agents as { failure: string }[];

  expect(grok!.failure).toHaveLength(4000);
  expect(grok!.failure.endsWith('Downloading Grok Build\nChecksum verification failed')).toBe(true);
});

it("reports a CLI whose adapter failed to install with no release and npm's cause", async () => {
  desired = ['claude-agent-acp'];
  await start(() => writeFile(join(home, 'npm-fail'), '@agentclientprotocol/claude-agent-acp'));

  const report = await until(() => reports[0]);

  expect(report.agents).toEqual([
    {
      kind: 'claude-agent-acp',
      release: null,
      failure: 'npm error 404 Not Found - @agentclientprotocol/claude-agent-acp',
      signed_in: false,
      models: [],
      modes: [],
      full_access: 'bypassPermissions',
    },
  ]);
  expect(kit!.stderr()).toContain('claude-agent-acp did not install: npm error 404 Not Found - @agentclientprotocol/claude-agent-acp');
});

it("names npm's exit status as the cause of an adapter install that failed without output", async () => {
  desired = ['claude-agent-acp'];
  await start(() => writeFile(join(home, 'npm-mute'), '@agentclientprotocol/claude-agent-acp'));

  const report = await until(() => reports[0]);

  expect(report.agents).toEqual([
    { kind: 'claude-agent-acp', release: null, failure: 'npm exited with 1', signed_in: false, models: [], modes: [], full_access: 'bypassPermissions' },
  ]);
});

it('reports a CLI below its minimum with the version found and the minimum, and reads no models from it', async () => {
  desired = ['codex-acp'];
  await signIn('codex-acp');
  await start(async () => {
    placeUserCli(userBin(home), 'codex-acp', '0.150.0');
  });

  const report = await until(() => reports[0]);

  expect(report.agents).toEqual([
    {
      kind: 'codex-acp',
      release: '0.150.0',
      minimum: '0.159.1',
      failure: null,
      signed_in: false,
      models: [],
      modes: [],
      full_access: 'agent-full-access',
    },
  ]);
  expect(await probes()).toBe(0);
});

it('reports a model its CLI refuses to select with no efforts before the Kit read any for it', async () => {
  desired = ['claude-agent-acp'];
  await signIn('claude-agent-acp');
  await start(() => writeFile(join(home, 'refuse-model'), 'sonnet'));

  const report = await until(() => reports[0]);

  expect(report.agents).toEqual([
    {
      kind: 'claude-agent-acp',
      release: RELEASES['claude-agent-acp'],
      failure: null,
      signed_in: true,
      models: [
        { model: 'default', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
        { model: 'sonnet', efforts: [] },
        { model: 'haiku', efforts: [] },
      ],
      modes: expect.arrayContaining([{ mode: 'bypassPermissions', name: 'Bypass permissions' }]),
      full_access: 'bypassPermissions',
    },
  ]);
  expect(kit!.stderr()).toContain('claude-agent-acp refused its model sonnet: Model switch blocked by a PreModelSwitch hook');
});

it('reads the models when it starts and on no timer after it, though House names its Agents again', async () => {
  desired = ['codex-acp'];
  await signIn('codex-acp');
  await start(undefined, FAST_INTERVALS);
  await until(() => reports[0]);
  await mkdir(join(home, 'models'));
  await writeFile(join(home, 'models', 'codex-acp'), JSON.stringify([{ id: 'gpt-5.5', name: '5.5', efforts: ['high'] }]));

  house.sockets[0]!.send({ type: 'work_available', subject: 'agents' });
  await new Promise((resolve) => setTimeout(resolve, 1500));

  expect(await probes()).toBe(1);
  expect(reports).toHaveLength(1);
});

it('reports the SHA256 fingerprint of the host SSH key when the host has one', async () => {
  desired = [];
  await start(() => placeHostKey(home));

  const report = await until(() => reports[0]);

  expect(report.ssh_host_key).toBe(HOST_KEY);
});

it('creates and reports the agents folder of the native workspace root as its Agent base', async () => {
  desired = [];
  const workspace = await temporaryHome();
  await start(undefined, [], { HOUSE_KIT_WORKSPACE: workspace });

  const report = await until(() => reports[0]);

  expect(report.agent_base).toBe(join(workspace, 'agents'));
  expect((await stat(join(workspace, 'agents'))).isDirectory()).toBe(true);
});

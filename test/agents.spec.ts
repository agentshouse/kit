import { KIT_WIRE } from '@agentshouse/kit-wire';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it } from 'vitest';
import { RELEASES, placeUserCli } from './cli.ts';
import { serveKitFiles } from './building.ts';
import { startHouse, until, type House } from './double.ts';
import { LOGIN_SHELL, placeUserClis, placeRelease, userBin } from './environment.ts';
import { accountOf, fakeBin, HOST_KEY, placeHostKey, runKit, temporaryHome, type KitRun } from './kit.ts';

const KIT_PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};
const PINNED = KIT_PACKAGE.peerDependencies;
const FAST_INTERVALS = ['--import', fileURLToPath(new URL('./fast-intervals.ts', import.meta.url))];
const FAST_DEADLINES = ['--import', fileURLToPath(new URL('./fast-deadlines.ts', import.meta.url))];

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
  serveKitFiles(house, home);
  house.route('POST', '/kit/agents/desired/list', () => ({ body: { agents: desired, routes: [] } }));
  house.route('POST', '/kit/agents/report', ({ body }) => {
    reports.push(body as Record<string, unknown>);
    return { body: {} };
  });
});

function completeReports(): Record<string, unknown>[] {
  return reports.filter((report) => {
    const agents = report.agents as { kind: string; installing?: true }[];
    return desired.every((kind) => agents.some((agent) => agent.kind === kind && agent.installing === undefined));
  });
}

function installing(kind: string, full_access: string | null) {
  return { kind, release: null, failure: null, installing: true, signed_in: false, models: [], modes: [], full_access };
}

function namedBefore(report: Record<string, unknown>, kind: string): unknown[] {
  return reports
    .slice(0, reports.indexOf(report))
    .flatMap((earlier) => (earlier.agents as { kind: string }[]).filter((agent) => agent.kind === kind));
}

async function logged(name: string): Promise<string[]> {
  const log = await readFile(join(home, name), 'utf8').catch(() => '');
  return log.split('\n').filter((line) => line !== '');
}

async function start(prepare?: () => Promise<void>, node: string[] = [], environment: Record<string, string> = {}) {
  const path = await fakeBin(home);
  await placeUserClis(home);
  await prepare?.();
  kit = runKit(['resident'], { HOME: accountOf(home), PATH: path, ...LOGIN_SHELL, ...(await placeRelease(home)), ...environment }, node);
}

async function signIn(...kinds: string[]): Promise<void> {
  await mkdir(join(home, 'signed-in'), { recursive: true });
  for (const kind of kinds) await writeFile(join(home, 'signed-in', kind), '');
}

async function probes(): Promise<number> {
  return (await logged('adapter.log')).filter((line) => line.includes('"method":"session/new"')).length;
}

it('reports a present signed-in CLI with its models beside another CLI it reports installing', async () => {
  desired = ['claude-agent-acp', 'codex-acp'];
  await signIn('codex-acp');
  await start(async () => {
    await rm(join(userBin(home), 'claude'));
    await writeFile(join(home, 'install-stall-claude-agent-acp'), '');
  });
  await until(async () => (await logged('curl.log')).includes('https://claude.ai/install.sh'));
  const report = await until(() => reports.find((report) =>
    (report.agents as { kind: string; signed_in: boolean }[]).some((agent) => agent.kind === 'codex-acp' && agent.signed_in),
  ));
  expect(report.agents).toEqual([
    installing('claude-agent-acp', 'bypassPermissions'),
    expect.objectContaining({ kind: 'codex-acp', signed_in: true, models: expect.arrayContaining([expect.objectContaining({ model: 'gpt-5.5' })]) }),
  ]);
});

it('reports a CLI the login shell does not find as installing from the moment its install starts until it reports its release', async () => {
  desired = ['claude-agent-acp'];
  await start(() => rm(join(userBin(home), 'claude')));

  const installed = await until(() => completeReports()[0]);

  expect(installed.agents).toEqual([
    { kind: 'claude-agent-acp', release: RELEASES['claude-agent-acp'], failure: null, signed_in: false, models: [], modes: [], full_access: 'bypassPermissions' },
  ]);
  const earlier = namedBefore(installed, 'claude-agent-acp');
  expect(earlier.length).toBeGreaterThan(0);
  expect(earlier).toEqual(earlier.map(() => installing('claude-agent-acp', 'bypassPermissions')));
});

it('pins in its package only the Codex and Claude Code adapters, no CLI and no Grok Build package', () => {
  expect(Object.keys(PINNED).sort()).toEqual(['@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/codex-acp']);
  expect(Object.keys({ ...KIT_PACKAGE.dependencies, ...PINNED }).join(' ')).not.toMatch(/grok|@openai\/codex|claude-code/);
});

it("reports the release of each CLI the login shell finds, its sign-in state, the models its session options name, each with its name and efforts and none for the CLI's own default, the model and the effort the CLI starts with, the modes and its full-access mode, with the operating system, the Kit release, its wire and its transcription engine", async () => {
  desired = ['codex-acp', 'claude-agent-acp', 'grok-build'];
  await signIn(...desired);
  await start();

  const report = await until(() => completeReports()[0]);

  expect(report).toEqual({
    os: expect.stringMatching(/\S/),
    ...('form' in report ? { form: expect.stringMatching(/^(laptop|desktop|server)$/) } : {}),
    kit_release: KIT_PACKAGE.version,
    wire: KIT_WIRE,
    agent_base: join(home, 'agents'),
    agents: [
      {
        kind: 'codex-acp',
        release: RELEASES['codex-acp'],
        failure: null,
        signed_in: true,
        models: [
          { model: 'gpt-5.5', name: '5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
          { model: 'gpt-5.5-mini', name: '5.5 Mini', efforts: ['minimal', 'low', 'medium', 'high'] },
          { model: 'codex-instant', name: 'codex-instant', efforts: [] },
        ],
        default_model: 'gpt-5.5',
        default_effort: 'medium',
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
          { model: 'opus', name: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
          { model: 'sonnet', name: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'max'] },
          { model: 'haiku', name: 'Haiku 5.5', efforts: [] },
          { model: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] },
        ],
        default_model: 'opus',
        default_effort: 'xhigh',
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
          { model: 'grok-4.6', name: 'Grok 4.6', efforts: ['xhigh', 'high', 'medium', 'low'] },
          { model: 'grok-4.5', name: 'Grok 4.5', efforts: ['high', 'medium', 'low'] },
        ],
        default_model: 'grok-4.6',
        default_effort: 'medium',
        modes: [],
        full_access: null,
      },
    ],
    transcription: { installed: false, failure: null },
  });
});

it('installs each chosen CLI the login shell does not find through its official route into its ordinary place beneath the home, where a later Kit finds it', async () => {
  desired = ['codex-acp', 'claude-agent-acp', 'grok-build'];
  await start(() => rm(userBin(home), { recursive: true }));

  const report = await until(() => completeReports()[0]);

  expect(report.agents).toEqual(desired.map((kind) => expect.objectContaining({ kind, release: RELEASES[kind], failure: null })));
  expect((await logged('curl.log')).sort()).toEqual([
    'https://chatgpt.com/codex/install.sh',
    'https://claude.ai/install.sh',
    'https://x.ai/cli/install.sh',
  ]);
  for (const place of ['.local/bin/codex', '.local/bin/claude', '.grok/bin/grok']) {
    expect(await readFile(join(accountOf(home), place), 'utf8')).toContain('CLI_RELEASE');
  }

  process.kill(kit!.pid, 'SIGKILL');
  await kit!.exited;
  reports.length = 0;
  kit = runKit(['resident'], { HOME: accountOf(home), PATH: await fakeBin(home), ...LOGIN_SHELL });

  expect((await until(() => completeReports()[0])).agents).toEqual(report.agents);
  expect(await logged('curl.log')).toHaveLength(3);
});

it('installs a chosen CLI the login shell does not find though its profile prints a path', async () => {
  desired = ['claude-agent-acp'];
  await start(async () => {
    await rm(join(userBin(home), 'claude'));
    await writeFile(join(accountOf(home), '.profile'), `echo "$HOME"\n${await readFile(join(accountOf(home), '.profile'), 'utf8')}`);
  });

  const report = await until(() => completeReports()[0]);

  expect(report.agents).toEqual([expect.objectContaining({ kind: 'claude-agent-acp', release: RELEASES['claude-agent-acp'], failure: null })]);
  expect(await logged('curl.log')).toEqual(['https://claude.ai/install.sh']);
});

it("reports a CLI whose official install failed with no release and the installer's cause, and installs it at a later work_available One-way call", async () => {
  desired = ['codex-acp', 'claude-agent-acp'];
  await start(async () => {
    await rm(join(userBin(home), 'claude'));
    await writeFile(join(home, 'install-fail'), 'claude-agent-acp\n');
  });

  const failed = await until(() => completeReports()[0]);

  expect(failed.agents).toEqual([
    expect.objectContaining({ kind: 'codex-acp', release: RELEASES['codex-acp'] }),
    { kind: 'claude-agent-acp', release: null, failure: 'Checksum verification failed', signed_in: false, models: [], modes: [], full_access: 'bypassPermissions' },
  ]);
  expect(namedBefore(failed, 'claude-agent-acp')).toContainEqual(installing('claude-agent-acp', 'bypassPermissions'));
  expect(kit!.stderr()).toContain('claude-agent-acp did not install: Checksum verification failed');

  await rm(join(home, 'install-fail'));
  house.connections[0]!.send({ type: 'work_available', subject: 'agents' });

  const recovered = await until(() => completeReports()[1]);
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

  const [grok] = (await until(() => completeReports()[0])).agents as { failure: string }[];

  expect(grok!.failure).toHaveLength(4000);
  expect(grok!.failure.endsWith('Downloading Grok Build\nChecksum verification failed')).toBe(true);
});

it('reports a CLI whose install has not ended within the install deadline as failed, having ended every process the install started', async () => {
  desired = ['claude-agent-acp'];
  await start(async () => {
    await rm(join(userBin(home), 'claude'));
    await writeFile(join(home, 'install-stall-claude-agent-acp'), '');
  }, FAST_DEADLINES);

  const report = await until(() => completeReports()[0]);

  expect(report.agents).toEqual([
    { kind: 'claude-agent-acp', release: null, failure: 'the install did not end within 900 seconds', signed_in: false, models: [], modes: [], full_access: 'bypassPermissions' },
  ]);
});

it("reports a CLI below its minimum with the version found, the minimum and the CLI's update command, beside its sign-in and models", async () => {
  desired = ['codex-acp'];
  await signIn('codex-acp');
  await start(async () => {
    placeUserCli(userBin(home), 'codex-acp', '0.150.0');
  });

  const report = await until(() => completeReports()[0]);

  expect(report.agents).toEqual([
    {
      kind: 'codex-acp',
      release: '0.150.0',
      minimum: '0.165.0',
      update: 'codex update',
      failure: null,
      signed_in: true,
      models: [
        { model: 'gpt-5.5', name: '5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
        { model: 'gpt-5.5-mini', name: '5.5 Mini', efforts: ['minimal', 'low', 'medium', 'high'] },
        { model: 'codex-instant', name: 'codex-instant', efforts: [] },
      ],
      default_model: 'gpt-5.5',
        default_effort: 'medium',
      modes: [
        { mode: 'read-only', name: 'Read-only' },
        { mode: 'workspace-write', name: 'Workspace access' },
        { mode: 'agent', name: 'Auto review' },
        { mode: 'agent-full-access', name: 'Full access' },
      ],
      full_access: 'agent-full-access',
    },
  ]);
});

it("reports the version a CLI's update command leaves, with the sign-in and models it read, and without the minimum that version reaches", async () => {
  desired = ['codex-acp'];
  await signIn('codex-acp');
  await start(async () => {
    placeUserCli(userBin(home), 'codex-acp', '0.150.0');
    await writeFile(join(home, 'update-codex-acp'), RELEASES['codex-acp']!);
  });

  const outdated = await until(() =>
    reports.flatMap((report) => report.agents as Record<string, unknown>[]).find((agent) => agent.release === '0.150.0' && agent.signed_in === true),
  );
  const updated = await until(() => reports.find((report) => (report.agents as { release: string }[])[0]?.release === RELEASES['codex-acp']));

  const { minimum, update, ...read } = outdated;
  expect({ minimum, update }).toEqual({ minimum: '0.165.0', update: 'codex update' });
  expect(updated.agents).toEqual([{ ...read, release: RELEASES['codex-acp'] }]);
  expect(await probes()).toBe(1);
});

it('reports a model its CLI refuses to select with no efforts before the Kit read any for it', async () => {
  desired = ['claude-agent-acp'];
  await signIn('claude-agent-acp');
  await start(() => writeFile(join(home, 'refuse-model'), 'sonnet'));

  const report = await until(() => completeReports()[0]);

  expect(report.agents).toEqual([
    {
      kind: 'claude-agent-acp',
      release: RELEASES['claude-agent-acp'],
      failure: null,
      signed_in: true,
      models: [
        { model: 'opus', name: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { model: 'sonnet', name: 'Sonnet 5.5', efforts: [] },
        { model: 'haiku', name: 'Haiku 5.5', efforts: [] },
        { model: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] },
      ],
      default_model: 'opus',
        default_effort: 'xhigh',
      modes: expect.arrayContaining([{ mode: 'bypassPermissions', name: 'Bypass permissions' }]),
      full_access: 'bypassPermissions',
    },
  ]);
  expect(kit!.stderr()).toContain('claude-agent-acp refused its model sonnet: Model switch blocked by a PreModelSwitch hook');
});

it("reports a name two of a CLI's models share once, by the model it lists first, and names that model where the CLI starts with its default", async () => {
  desired = ['claude-agent-acp'];
  await signIn('claude-agent-acp');
  await start(async () => {
    await mkdir(join(home, 'models'), { recursive: true });
    await writeFile(
      join(home, 'models', 'claude-agent-acp'),
      JSON.stringify([
        { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5', efforts: [] },
        { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: [] },
        { id: 'opus', name: 'Opus 5.5', efforts: [] },
        { id: 'haiku', name: 'Haiku 5.5', efforts: [] },
      ]),
    );
  });

  const report = await until(() => completeReports()[0]);

  const [claude] = report.agents as Record<string, unknown>[];
  expect(claude).toMatchObject({
    kind: 'claude-agent-acp',
    models: [
      { model: 'claude-opus-5-5', name: 'Opus 5.5', efforts: [] },
      { model: 'haiku', name: 'Haiku 5.5', efforts: [] },
    ],
    default_model: 'claude-opus-5-5',
  });
});

it('names no model a CLI starts with when its own default choice describes none of the models it lists', async () => {
  desired = ['claude-agent-acp'];
  await signIn('claude-agent-acp');
  await start(async () => {
    await mkdir(join(home, 'models'), { recursive: true });
    await writeFile(
      join(home, 'models', 'claude-agent-acp'),
      JSON.stringify([
        { id: 'default', name: 'Default (recommended)', description: 'Opus', efforts: [] },
        { id: 'opus', name: 'Opus 5.5', efforts: [] },
      ]),
    );
  });

  const report = await until(() => completeReports()[0]);

  const [claude] = report.agents as Record<string, unknown>[];
  expect(claude).toMatchObject({ kind: 'claude-agent-acp', models: [{ model: 'opus', name: 'Opus 5.5', efforts: [] }] });
  expect(claude).not.toHaveProperty('default_model');
});

it('reads the models when it starts and on no timer after it, though House names its Agents again', async () => {
  desired = ['codex-acp'];
  await signIn('codex-acp');
  await start(undefined, FAST_INTERVALS);
  await until(() => completeReports()[0]);
  await mkdir(join(home, 'models'));
  await writeFile(join(home, 'models', 'codex-acp'), JSON.stringify([{ id: 'gpt-5.5', name: '5.5', efforts: ['high'] }]));

  house.connections[0]!.send({ type: 'work_available', subject: 'agents' });
  // A second and a half lets every Kit interval, capped at 300 ms, fire several times before the reads are counted.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  expect(await probes()).toBe(1);
  expect(completeReports()).toHaveLength(1);
});

it('reports the SHA256 fingerprint of the host SSH key when the host has one', async () => {
  desired = [];
  await start(() => placeHostKey(home));

  const report = await until(() => completeReports()[0]);

  expect(report.ssh_host_key).toBe(HOST_KEY);
});

it('creates and reports the agents folder of the native workspace root as its Agent base', async () => {
  desired = [];
  const workspace = await temporaryHome();
  await start(() => writeFile(join(home, 'kit.json'), JSON.stringify({ skills: false, workspace })));

  const report = await until(() => completeReports()[0]);

  expect(report.agent_base).toBe(join(workspace, 'agents'));
  expect((await stat(join(workspace, 'agents'))).isDirectory()).toBe(true);
});


import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { startHouse, until, type House } from './double.ts';
import { HOST_KEY, fakeBin, placeHostKey, runKit, temporaryHome, type KitRun } from './kit.ts';

const KIT_PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};
const PINNED = KIT_PACKAGE.peerDependencies;

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

async function installs(): Promise<string[]> {
  const log = await readFile(join(home, 'npm.log'), 'utf8');
  return log
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as string[]).at(-1)!);
}

async function start(prepare?: () => Promise<void>) {
  const path = await fakeBin(home);
  await prepare?.();
  kit = runKit(['resident'], { HOUSE_KIT_HOME: home, PATH: path });
}

it('installs exactly the named CLIs at their pinned versions and adds one a later work frame names', async () => {
  desired = ['codex-acp', 'grok-build'];
  await start();

  await until(() => reports[0]);
  expect(await installs()).toEqual([
    `@agentclientprotocol/codex-acp@${PINNED['@agentclientprotocol/codex-acp']}`,
    `@xai-official/grok@${PINNED['@xai-official/grok']}`,
  ]);

  desired = ['codex-acp', 'claude-agent-acp'];
  const socket = await until(() => house.sockets[0]);
  socket.send({ type: 'work_available', subject: 'agents' });

  await until(() => reports[1]);
  expect((await installs()).slice(2)).toEqual([
    `@agentclientprotocol/claude-agent-acp@${PINNED['@agentclientprotocol/claude-agent-acp']}`,
  ]);
});

async function signIn(...kinds: string[]): Promise<void> {
  await mkdir(join(home, 'signed-in'), { recursive: true });
  for (const kind of kinds) await writeFile(join(home, 'signed-in', kind), '');
}

async function probes(): Promise<number> {
  const log = await readFile(join(home, 'adapter.log'), 'utf8').catch(() => '');
  return log.split('\n').filter((line) => line.includes('"method":"session/new"')).length;
}

it('reports each CLI release, sign-in state and the models with the efforts its session options name, with the operating system and the Kit version', async () => {
  desired = ['codex-acp', 'claude-agent-acp', 'grok-build'];
  await signIn(...desired);
  await start();

  const report = await until(() => reports[0]);

  expect(report).toEqual({
    os: expect.stringMatching(/\S/),
    kit_version: KIT_PACKAGE.version,
    agents: [
      {
        kind: 'codex-acp',
        release: PINNED['@agentclientprotocol/codex-acp'],
        failure: null,
        signed_in: true,
        models: [
          { model: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
          { model: 'gpt-5.5-mini', efforts: ['minimal', 'low', 'medium', 'high'] },
          { model: 'codex-instant', efforts: [] },
        ],
      },
      {
        kind: 'claude-agent-acp',
        release: PINNED['@agentclientprotocol/claude-agent-acp'],
        failure: null,
        signed_in: true,
        models: [
          { model: 'default', efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
          { model: 'sonnet', efforts: ['default', 'low', 'medium', 'high', 'max'] },
          { model: 'haiku', efforts: [] },
        ],
      },
      {
        kind: 'grok-build',
        release: PINNED['@xai-official/grok'],
        failure: null,
        signed_in: true,
        models: [
          { model: 'grok-4.6', efforts: ['xhigh', 'high', 'medium', 'low'] },
          { model: 'grok-4.5', efforts: ['high', 'medium', 'low'] },
        ],
      },
    ],
  });
});

it('reports a CLI that failed to install with no release and the cause its log shows, and its release once a later install succeeds', async () => {
  desired = ['codex-acp', 'claude-agent-acp'];
  await writeFile(join(home, 'npm-fail'), '@agentclientprotocol/claude-agent-acp');
  await start();

  const failed = await until(() => reports[0]);

  const codex = {
    kind: 'codex-acp',
    release: PINNED['@agentclientprotocol/codex-acp'],
    failure: null,
    signed_in: false,
    models: [],
  };
  expect(failed.agents).toEqual([
    codex,
    {
      kind: 'claude-agent-acp',
      release: null,
      failure: 'npm error 404 Not Found - @agentclientprotocol/claude-agent-acp',
      signed_in: false,
      models: [],
    },
  ]);
  expect(kit!.stderr()).toContain('claude-agent-acp did not install: npm error 404 Not Found - @agentclientprotocol/claude-agent-acp');

  await rm(join(home, 'npm-fail'));
  house.sockets[0]!.send({ type: 'work_available', subject: 'agents' });

  const recovered = await until(() => reports[1]);
  expect(recovered.agents).toEqual([
    codex,
    {
      kind: 'claude-agent-acp',
      release: PINNED['@agentclientprotocol/claude-agent-acp'],
      failure: null,
      signed_in: false,
      models: [],
    },
  ]);
});

it("sends a new report when a CLI's efforts change and none while nothing changed", async () => {
  desired = ['codex-acp'];
  await signIn('codex-acp');
  await start();
  await until(() => reports[0]);
  const socket = await until(() => house.sockets[0]);

  socket.send({ type: 'work_available', subject: 'agents' });
  await until(async () => (await probes()) === 2);
  await mkdir(join(home, 'models'));
  await writeFile(
    join(home, 'models', 'codex-acp'),
    JSON.stringify([
      { id: 'gpt-5.5', name: '5.5', efforts: ['medium', 'high'] },
      { id: 'codex-instant', name: 'codex-instant', efforts: [] },
    ]),
  );
  socket.send({ type: 'work_available', subject: 'agents' });

  const changed = await until(() => reports[1]);
  expect(changed.agents).toEqual([
    {
      kind: 'codex-acp',
      release: PINNED['@agentclientprotocol/codex-acp'],
      failure: null,
      signed_in: true,
      models: [
        { model: 'gpt-5.5', efforts: ['medium', 'high'] },
        { model: 'codex-instant', efforts: [] },
      ],
    },
  ]);
  expect(reports).toHaveLength(2);
});

it('reports the SHA256 fingerprint of the host SSH key when the host has one', async () => {
  desired = [];
  await start(() => placeHostKey(home));

  const report = await until(() => reports[0]);

  expect(report.ssh_host_key).toBe(HOST_KEY);
});

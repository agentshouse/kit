import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { startHouse, until, type House } from './double.ts';
import { fakeNpm, runKit, temporaryHome, type KitRun } from './kit.ts';

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

async function start() {
  kit = runKit(['resident'], { HOUSE_KIT_HOME: home, PATH: await fakeNpm(home) });
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

it('reports each CLI release and sign-in state with the operating system and the Kit version', async () => {
  desired = ['codex-acp', 'claude-agent-acp', 'grok-build'];
  await mkdir(join(home, 'signed-in'));
  await writeFile(join(home, 'signed-in', 'codex-acp'), '');
  await writeFile(join(home, 'signed-in', 'grok-build'), '');
  await start();

  const report = await until(() => reports[0]);

  expect(report).toEqual({
    os: expect.stringMatching(/\S/),
    kit_version: KIT_PACKAGE.version,
    agents: [
      { kind: 'codex-acp', release: PINNED['@agentclientprotocol/codex-acp'], signed_in: true },
      { kind: 'claude-agent-acp', release: PINNED['@agentclientprotocol/claude-agent-acp'], signed_in: false },
      { kind: 'grok-build', release: PINNED['@xai-official/grok'], signed_in: true },
    ],
  });
});

it('reports a CLI that failed to install with no release and its cause in the log', async () => {
  desired = ['codex-acp', 'claude-agent-acp'];
  await writeFile(join(home, 'npm-fail'), '@agentclientprotocol/claude-agent-acp');
  await start();

  const report = await until(() => reports[0]);

  expect(report.agents).toEqual([
    { kind: 'codex-acp', release: PINNED['@agentclientprotocol/codex-acp'], signed_in: false },
    { kind: 'claude-agent-acp', release: null, signed_in: false },
  ]);
  expect(kit!.stderr()).toContain('claude-agent-acp did not install: npm error 404 Not Found');
});

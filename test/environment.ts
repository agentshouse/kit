import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { onTestFinished } from 'vitest';
import { startHouse, until, type House, type KitSocket, type Received } from './double.ts';
import { fakeNpm, runKit, temporaryHome, type KitRun } from './kit.ts';
import { placeCli } from './npm.ts';

const KIT_PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  peerDependencies: Record<string, string>;
};
const PACKAGES: Record<string, string> = {
  'codex-acp': '@agentclientprotocol/codex-acp',
  'claude-agent-acp': '@agentclientprotocol/claude-agent-acp',
  'grok-build': '@xai-official/grok',
};

export interface RouteOverrides {
  agent_id?: string;
  kind?: string;
  base_instructions?: string;
  working_directory?: string;
  model?: string;
  effort?: string | null;
}

export interface Hosted {
  house: House;
  home: string;
  kit: KitRun;
  socket: KitSocket;
  workingDirectory: string;
  acks: Received[];
  turns: Received[];
  input(fields: Record<string, unknown>): void;
  ack(inputId: string): Promise<unknown>;
  adapterLog(): Promise<Record<string, unknown>[]>;
}

let inputs = 0;

export async function hostKit(routes: RouteOverrides[] = [{}]): Promise<Hosted> {
  const house = await startHouse();
  const home = await temporaryHome();
  const workingDirectory = await mkdtemp(join(tmpdir(), 'kit-agent-'));
  onTestFinished(() => rm(workingDirectory, { recursive: true, force: true }));
  await writeFile(
    join(home, 'credential.json'),
    JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }),
  );
  const resolved = routes.map((route, index) => ({
    agent_id: `agent-${index + 1}`,
    kind: 'codex-acp',
    base_instructions: 'Be useful.',
    working_directory: workingDirectory,
    model: 'route-model',
    effort: 'route-effort',
    ...route,
  }));
  const kinds = [...new Set(resolved.map((route) => route.kind))];
  for (const kind of kinds) {
    await mkdir(join(home, 'agents', kind), { recursive: true });
    placeCli(join(home, 'agents', kind), kind, KIT_PACKAGE.peerDependencies[PACKAGES[kind]!]!);
  }
  const acks: Received[] = [];
  const turns: Received[] = [];
  house.route('POST', '/kit/restarted', () => ({ body: {} }));
  house.route('POST', '/kit/agents/desired', () => ({ body: { agents: kinds, routes: resolved } }));
  house.route('POST', '/kit/agents/report', () => ({ body: {} }));
  house.route('POST', '/kit/inputs/:input/ack', (request) => {
    acks.push(request);
    return { body: {} };
  });
  for (const event of ['started', 'ended']) {
    house.route('POST', `/kit/conversations/:conversation/turns/:turn/${event}`, (request) => {
      turns.push(request);
      return { body: {} };
    });
  }
  const kit = runKit(['resident'], { HOUSE_KIT_HOME: home, PATH: await fakeNpm(home) });
  const socket = await until(() => house.sockets[0]);
  return {
    house,
    home,
    kit,
    socket,
    workingDirectory,
    acks,
    turns,
    input: (fields) => {
      inputs++;
      socket.send({
        type: 'input',
        input_id: `input-${inputs}`,
        conversation_id: 'conversation-1',
        agent_id: 'agent-1',
        provider_session_id: null,
        ...fields,
      });
    },
    ack: async (inputId) => (await until(() => acks.find((ack) => ack.params.input === inputId))).body,
    adapterLog: async () => {
      try {
        const log = await readFile(join(home, 'adapter.log'), 'utf8');
        return log
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
  };
}

export function lastInput(): string {
  return `input-${inputs}`;
}

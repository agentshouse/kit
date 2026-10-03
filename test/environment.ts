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

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export type ToolAnswer = (args: Record<string, unknown>) => ToolResult;

export const LISTING = [
  {
    name: 'search',
    description: 'Search Rooms and `/private` by words, meaning or date.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'inspect',
    description: 'Open a file or `ref` with its provenance and revisions.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'append_record',
    description: 'Add a record to a Room, stored as given.',
    inputSchema: { type: 'object', properties: { room_ref: { type: 'string' }, attachments: { type: 'array' } } },
  },
  {
    name: 'upload_attachment',
    description: 'Store a file to link from a document.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, room_ref: { type: 'string' } } },
  },
];

const WRITES = new Set(['append_record', 'upload_attachment']);

export function conversationCredential(conversation: string): string {
  return `ahc_${conversation}`;
}

export interface McpCall {
  method: string;
  params: { name?: string; arguments?: Record<string, unknown>; _meta: Record<string, unknown> };
}

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
  interactions: Received[];
  idles: Received[];
  mcp: Received[];
  tools: Record<string, ToolAnswer>;
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
  const interactions: Received[] = [];
  const idles: Received[] = [];
  const mcp: Received[] = [];
  const tools: Record<string, ToolAnswer> = {
    inspect: () => ({ isError: true, content: [{ type: 'text', text: 'not_found: check the reference, then call again.' }] }),
  };
  house.route('POST', '/', (request) => {
    mcp.push(request);
    const message = request.body as { id: number } & McpCall;
    const name = message.params.name!;
    const answer = tools[name] ?? (() => ({ content: [{ type: 'text', text: `${name} answered` }] }));
    const result = message.method === 'tools/list' ? { tools: LISTING } : answer(message.params.arguments ?? {});
    return { body: { jsonrpc: '2.0', id: message.id, result } };
  });
  house.route('POST', '/kit/tools/mutations', () => ({
    body: { tools: LISTING.map((tool) => ({ name: tool.name, writes: WRITES.has(tool.name) })) },
  }));
  house.route('POST', '/kit/conversations/:conversation/credential', (request) => ({
    body: { credential: conversationCredential(request.params.conversation!) },
  }));
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
  house.route('POST', '/kit/conversations/:conversation/turns/:turn/interactions', (request) => {
    interactions.push(request);
    return { body: {} };
  });
  house.route('POST', '/kit/idle', (request) => {
    idles.push(request);
    return { body: {} };
  });
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
    interactions,
    idles,
    mcp,
    tools,
    input: (fields) => {
      inputs++;
      house.sockets.at(-1)!.send({
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

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { CLIS } from '../src/clis.ts';
import { BINS, placeUserCli } from './cli.ts';
import { certificate, startHouse, until, type House, type KitSocket, type Received } from './double.ts';
import { fakeBin, runKit, stop, temporaryHome, type KitRun } from './kit.ts';
import { placeAdapter } from './npm.ts';

const KIT_PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  peerDependencies: Record<string, string>;
};

export const LOGIN_SHELL = { SHELL: '/bin/sh' };

export function userBin(home: string): string {
  return join(home, 'user-bin');
}

export async function placeUserClis(home: string): Promise<void> {
  for (const kind of Object.keys(BINS)) placeUserCli(userBin(home), kind);
  await writeFile(join(home, '.profile'), 'PATH="$HOME/user-bin:$HOME/bin:$PATH"\n');
}

export function placePinnedAdapter(home: string, kind: string): void {
  const adapter = CLIS[kind]!.adapter;
  if (adapter !== null) placeAdapter(join(home, 'agents', kind), kind, KIT_PACKAGE.peerDependencies[adapter.package]!);
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export type ToolAnswer = (args: Record<string, unknown>, request: Received) => ToolResult | null;

export function shelled(stdout: string, exit = 0, stderr: string[] = []): ToolResult {
  const text = [
    ...(exit === 0 ? [] : [`exit: ${exit}`]),
    ...stderr.map((line) => `stderr: ${line}`),
    ...(stdout === '' ? [] : [stdout]),
  ];
  return { content: [{ type: 'text', text: text.join('\n') }] };
}

export interface Listed {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export function helpLine(tool: Listed): string {
  return tool.description === undefined ? tool.name : `${tool.name}: ${tool.description}`;
}

export const LISTING: Listed[] = [
  {
    name: 'search',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'shell',
    description: 'Read-only shell over `/rooms/<handle>`.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } } },
  },
  {
    name: 'inspect',
    description: 'Provenance and revisions; `shell` reads current file text.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'edit',
    inputSchema: { type: 'object', properties: { changes: { type: 'array' } } },
  },
  {
    name: 'append_record',
    description: 'Add a record to a Room, stored as given.',
    inputSchema: { type: 'object', properties: { room_ref: { type: 'string' }, attachments: { type: 'array' } } },
  },
  {
    name: 'upload_attachment',
    description: 'Store a file to link from a document or an answer.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, room_ref: { type: 'string' } } },
  },
  {
    name: 'list_rooms',
    description: 'Your Rooms and what you may do in each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'find_command',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'run_command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, arguments: { type: 'object' } } },
  },
  {
    name: 'get_started',
    inputSchema: { type: 'object', properties: {} },
  },
];

const WRITES = new Set(['edit', 'append_record', 'upload_attachment', 'run_command']);

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
  mode?: string | null;
}

export interface Hosting {
  tls?: boolean;
  environment?: Record<string, string>;
  home?: string;
  skills?: boolean;
  prepare?: (home: string) => Promise<void>;
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

export const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Agent',
  GIT_AUTHOR_EMAIL: 'agent@example.com',
  GIT_COMMITTER_NAME: 'Agent',
  GIT_COMMITTER_EMAIL: 'agent@example.com',
};

let inputs = 0;

export async function hostKit(routes: RouteOverrides[] = [{}], hosting: Hosting = {}): Promise<Hosted> {
  const house = await startHouse(hosting.tls ? certificate() : undefined);
  const home = hosting.home ?? (await temporaryHome());
  onTestFinished(async () => {
    for (const log of ['adapter.log', 'login.log']) {
      const lines = (await readFile(join(home, log), 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');
      for (const line of lines) {
        const { pid, spawned, clean } = JSON.parse(line) as { pid?: number; spawned?: number; clean?: number };
        for (const target of [pid, spawned, clean]) if (target !== undefined) stop(target);
      }
    }
  });
  const workingDirectory = await mkdtemp(join(tmpdir(), 'kit-agent-'));
  onTestFinished(() => rm(workingDirectory, { recursive: true, force: true }));
  await writeFile(
    join(home, 'credential.json'),
    JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }),
  );
  if (hosting.home === undefined || hosting.skills !== undefined) {
    await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: hosting.skills ?? false }));
  }
  const resolved = routes.map((route, index) => ({
    agent_id: `agent-${index + 1}`,
    kind: 'codex-acp',
    base_instructions: 'Be useful.',
    working_directory: workingDirectory,
    model: 'route-model',
    effort: 'route-effort',
    mode: null,
    ...route,
  }));
  const kinds = [...new Set(resolved.map((route) => route.kind))];
  for (const kind of kinds) placePinnedAdapter(home, kind);
  await placeUserClis(home);
  await hosting.prepare?.(home);
  const acks: Received[] = [];
  const turns: Received[] = [];
  const interactions: Received[] = [];
  const idles: Received[] = [];
  const mcp: Received[] = [];
  const tools: Record<string, ToolAnswer> = {
    shell: () => shelled('', 1, ['cat: path_not_found /rooms/private/how-we-work.md']),
  };
  house.route('POST', '/', (request) => {
    mcp.push(request);
    const message = request.body as { id: number } & McpCall;
    const name = message.params.name!;
    const answer = tools[name] ?? (() => ({ content: [{ type: 'text', text: `${name} answered` }] }));
    const result = message.method === 'tools/list' ? { tools: LISTING } : answer(message.params.arguments ?? {}, request);
    return result === null ? { drop: true } : { body: { jsonrpc: '2.0', id: message.id, result } };
  });
  house.route('POST', '/kit/tools/mutations', () => ({
    body: { tools: LISTING.map((tool) => ({ name: tool.name, writes: WRITES.has(tool.name) })) },
  }));
  house.route('POST', '/kit/conversations/:conversation/credential', (request) => ({
    body: { credential: conversationCredential(request.params.conversation!) },
  }));
  house.route('POST', '/kit/restarted', () => ({ body: {} }));
  house.route('POST', '/kit/local-copy/selection', () => ({ body: { local_copy: null } }));
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
  const kit = runKit(['resident'], {
    HOUSE_KIT_HOME: home,
    PATH: await fakeBin(home),
    ...LOGIN_SHELL,
    ...GIT_IDENTITY,
    ...(hosting.tls ? { NODE_EXTRA_CA_CERTS: certificate().path } : {}),
    ...hosting.environment,
  });
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
    ack: async (inputId) =>
      (
        await until(
          () => acks.find((ack) => ack.params.input === inputId),
          // Acknowledgement follows local transcription and can exceed thirty seconds under constrained CPU.
          45_000,
        )
      ).body,
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

export async function hostMac(): Promise<Hosted> {
  const home = await temporaryHome();
  const bin = join(home, 'macos');
  await mkdir(bin);
  await writeFile(join(bin, 'ps'), `#!/bin/sh\nexec env -u NODE_OPTIONS ${process.execPath} ${fileURLToPath(new URL('./ps.ts', import.meta.url))} "$@"\n`);
  await writeFile(join(bin, 'sw_vers'), '#!/bin/sh\n[ "$*" = -productVersion ] && echo 27.0.1\n');
  await Promise.all(['ps', 'sw_vers'].map((tool) => chmod(join(bin, tool), 0o755)));
  return hostKit([{}], {
    home,
    skills: false,
    environment: {
      PATH: `${bin}:${join(home, 'bin')}:${process.env.PATH}`,
      NODE_OPTIONS: `--import=${fileURLToPath(new URL('./darwin.ts', import.meta.url))}`,
    },
  });
}

export function lastInput(): string {
  return `input-${inputs}`;
}

export async function installHeld(hosted: Hosted): Promise<string> {
  const hold = join(hosted.home, 'npm-hold');
  await writeFile(hold, '');
  onTestFinished(() => rm(hold, { force: true }));
  const added = {
    agent_id: 'agent-2',
    kind: 'claude-agent-acp',
    base_instructions: 'Be useful.',
    working_directory: hosted.workingDirectory,
    model: 'route-model',
    effort: null,
  };
  hosted.house.route('POST', '/kit/agents/desired', () => ({
    body: { agents: ['codex-acp', 'claude-agent-acp'], routes: [added] },
  }));
  hosted.socket.send({ type: 'work_available', subject: 'agents' });
  await until(async () =>
    (await readFile(join(hosted.home, 'npm.log'), 'utf8').catch(() => '')).includes(
      CLIS['claude-agent-acp']!.adapter!.package,
    ),
  );
  return hold;
}

export interface Ran {
  house?: string[];
  git?: string[];
  status: number;
  stdout: string;
  stderr: string;
}

export async function opened(hosted: Hosted, conversation = 'conversation-1', agent = 'agent-1'): Promise<void> {
  hosted.input({ kind: 'open', conversation_id: conversation, agent_id: agent });
  await hosted.ack(lastInput());
}

export function directed(hosted: Hosted, text: string, conversation = 'conversation-1', agent = 'agent-1'): void {
  hosted.input({ kind: 'message', conversation_id: conversation, agent_id: agent, text, files: [], first: false });
}

export async function runs(hosted: Hosted, count: number): Promise<Ran[]> {
  return until(async () => {
    const ran = (await hosted.adapterLog()).filter((entry) => 'house' in entry || 'git' in entry);
    return ran.length >= count ? (ran as unknown as Ran[]) : undefined;
  });
}

function line(text: string): string {
  return `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`;
}

export function appRemote(hosted: Hosted, commit: string): string[] {
  const credentials: string[] = [];
  hosted.house.route('GET', '/app/:app/info/refs', (received) => {
    const basic = /^Basic (.+)$/.exec(received.headers.authorization ?? '')?.[1];
    const presented = Buffer.from(basic ?? '', 'base64').toString('utf8');
    credentials.push(presented.slice(presented.indexOf(':') + 1));
    if (basic === undefined) return { status: 401, bytes: { type: 'text/plain', content: 'authentication required\n' } };
    return {
      bytes: {
        type: 'application/x-git-upload-pack-advertisement',
        content: [
          line('# service=git-upload-pack\n'),
          '0000',
          line(`${commit} HEAD\0side-band-64k\n`),
          line(`${commit} refs/heads/main\n`),
          '0000',
        ].join(''),
      },
    };
  });
  return credentials;
}

export async function attachmentDouble(
  hosted: Hosted,
): Promise<{ operation: unknown; authorization: unknown; bytes: Buffer }[]> {
  const transfers: { operation: unknown; authorization: unknown; bytes: Buffer }[] = [];
  let declared = 0;
  hosted.house.route('POST', '/kit/attachments/upload', () => {
    declared++;
    return {
      body: {
        attachment: `at_${declared}`,
        save: { status: 'pending' },
        upload: {
          method: 'POST',
          operation: `operation-${declared}`,
          url: `${hosted.house.origin}/bytes/upload-${declared}`,
          expires_at: '2026-10-03T12:00:00Z',
        },
      },
    };
  });
  hosted.house.route('POST', '/bytes/:grant', (received) => {
    transfers.push({
      operation: received.headers['x-house-byte-operation'],
      authorization: received.headers.authorization,
      bytes: received.body as Buffer,
    });
    return { body: { attachment: `at_${received.params.grant!.slice('upload-'.length)}` } };
  });
  return transfers;
}

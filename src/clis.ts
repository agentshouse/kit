import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kitHome } from './home.ts';

export interface Notice {
  method?: string;
  params?: {
    runningPromptId?: string;
    update?: {
      sessionUpdate?: string;
      asyncTaskId?: string;
      state?: string;
      task_id?: string;
      task_snapshot?: { task_id?: string };
      _meta?: { '_claude/origin'?: unknown; codex?: { threadStatus?: { type?: string } } } | null;
    };
  };
}

export interface Job {
  id: string;
  running: boolean;
}

export interface Cli {
  package: string;
  bin: string;
  args: string[];
  signedIn: { command: string[] } | { initializeMeta: string };
  login: { args: string[]; code: 'show' | 'collect' };
  queues: boolean;
  turnStarted(notice: Notice): boolean;
  turnEnded(notice: Notice): boolean;
  job(notice: Notice): Job | null;
}

const RUNNING_JOB = new Set(['running', 'paused']);

function threadStatus({ method, params }: Notice): string | undefined {
  if (method !== 'session/update' || params?.update?.sessionUpdate !== 'session_info_update') return undefined;
  return params.update._meta?.codex?.threadStatus?.type;
}

function asyncTask({ method, params }: Notice): Job | null {
  const update = params?.update;
  if (method !== 'session/update' || update?.asyncTaskId === undefined) return null;
  if (update.sessionUpdate === 'async_task_spawned') return { id: update.asyncTaskId, running: true };
  if (update.sessionUpdate === 'async_task_state_update' && !RUNNING_JOB.has(update.state ?? '')) {
    return { id: update.asyncTaskId, running: false };
  }
  return null;
}

export const CLIS: Record<string, Cli> = {
  'codex-acp': {
    package: '@agentclientprotocol/codex-acp',
    bin: 'codex-acp',
    args: [],
    signedIn: { command: ['cli', 'login', 'status'] },
    login: { args: ['cli', 'login', '--device-auth'], code: 'show' },
    queues: false,
    turnStarted: (notice) => threadStatus(notice) === 'active',
    turnEnded: (notice) => threadStatus(notice) === 'idle',
    job: asyncTask,
  },
  'claude-agent-acp': {
    package: '@agentclientprotocol/claude-agent-acp',
    bin: 'claude-agent-acp',
    args: [],
    signedIn: { command: ['--cli', 'auth', 'status'] },
    login: { args: ['--cli', 'auth', 'login', '--claudeai'], code: 'collect' },
    queues: false,
    turnStarted: () => false,
    turnEnded: ({ method, params }) =>
      method === 'session/update' &&
      params?.update?.sessionUpdate === 'usage_update' &&
      params.update._meta?.['_claude/origin'] !== undefined,
    job: asyncTask,
  },
  'grok-build': {
    package: '@xai-official/grok',
    bin: 'grok',
    args: ['agent', '--no-leader', 'stdio'],
    signedIn: { initializeMeta: 'defaultAuthMethodId' },
    login: { args: ['login', '--device-auth'], code: 'show' },
    queues: true,
    turnStarted: ({ method, params }) => method === '_x.ai/queue/changed' && params?.runningPromptId !== undefined,
    turnEnded: ({ method, params }) =>
      method === '_x.ai/session_notification' && params?.update?.sessionUpdate === 'turn_completed',
    job: ({ method, params }) => {
      if (method === '_x.ai/task_backgrounded') return { id: params!.update!.task_id!, running: true };
      if (method === '_x.ai/task_completed') return { id: params!.update!.task_snapshot!.task_id!, running: false };
      return null;
    },
  },
};

const KIT_PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};

export const KIT_VERSION = KIT_PACKAGE.version;

export function pinned(kind: string): string {
  return KIT_PACKAGE.peerDependencies[CLIS[kind]!.package]!;
}

function prefix(kind: string): string {
  return join(kitHome(), 'agents', kind);
}

export function cliCommand(kind: string): string {
  return join(prefix(kind), 'node_modules', '.bin', CLIS[kind]!.bin);
}

export async function installedRelease(kind: string): Promise<string | null> {
  try {
    const manifest = join(prefix(kind), 'node_modules', CLIS[kind]!.package, 'package.json');
    return (JSON.parse(await readFile(manifest, 'utf8')) as { version: string }).version;
  } catch {
    return null;
  }
}

export interface Ran {
  status: number | null;
  output: string;
}

export function run(command: string, args: string[], timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error) => resolve({ status: null, output: error.message }));
    child.on('close', (status) => resolve({ status, output }));
  });
}

export async function install(kind: string): Promise<string | null> {
  const release = pinned(kind);
  if ((await installedRelease(kind)) === release) return release;
  const ran = await run(
    'npm',
    ['install', '--prefix', prefix(kind), '--no-save', '--no-audit', '--no-fund', `${CLIS[kind]!.package}@${release}`],
    15 * 60_000,
  );
  if (ran.status !== 0) {
    process.stderr.write(`kit: ${kind} did not install: ${ran.output.trim()}\n`);
    return null;
  }
  return installedRelease(kind);
}

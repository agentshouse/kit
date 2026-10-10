import type { ContentChunk } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
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

export type Phase = 'note' | 'answer';

export interface Cli {
  bin: string;
  minimum: string;
  install: string;
  adapter: { package: string; bin: string; executable: string; env: Record<string, string> } | null;
  args: string[];
  fullAccess: string | null;
  sessionMeta: Record<string, unknown>;
  allowHouse(): Promise<void>;
  signedIn: { command: string[] } | { initializeMeta: string };
  login: { args: string[]; code: 'show' } | { args: string[]; code: 'collect'; rejected: string };
  queues: boolean;
  turnStarted(notice: Notice): boolean;
  turnEnded(notice: Notice): boolean;
  job(notice: Notice): Job | null;
  phase(chunk: ContentChunk): Phase | null;
}

const RUNNING_JOB = new Set(['running', 'paused']);

async function allowHouseInCodex(): Promise<void> {
  const rules = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'rules');
  await mkdir(rules, { recursive: true });
  await writeFile(join(rules, 'house.rules'), 'prefix_rule(pattern = ["house"], decision = "allow")\n');
}

async function nothing(): Promise<void> {}

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

function airPhase({ _meta }: ContentChunk): Phase | null {
  const phase = (_meta?.jetbrains as { air?: { phase?: unknown } } | undefined)?.air?.phase;
  if (phase === 'commentary') return 'note';
  if (phase === 'final_answer') return 'answer';
  return null;
}

export const CLIS: Record<string, Cli> = {
  'codex-acp': {
    bin: 'codex',
    minimum: '0.159.1',
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    adapter: { package: '@agentclientprotocol/codex-acp', bin: 'codex-acp', executable: 'CODEX_PATH', env: {} },
    args: [],
    fullAccess: 'agent-full-access',
    sessionMeta: {},
    allowHouse: allowHouseInCodex,
    signedIn: { command: ['login', 'status'] },
    login: { args: ['login', '--device-auth'], code: 'show' },
    queues: false,
    turnStarted: (notice) => threadStatus(notice) === 'active',
    turnEnded: (notice) => threadStatus(notice) === 'idle',
    job: asyncTask,
    phase: airPhase,
  },
  'claude-agent-acp': {
    bin: 'claude',
    minimum: '2.1.286',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    adapter: {
      package: '@agentclientprotocol/claude-agent-acp',
      bin: 'claude-agent-acp',
      executable: 'CLAUDE_CODE_EXECUTABLE',
      env: { CLAUDE_CODE_ENTRYPOINT: 'claude-agent-acp', IS_SANDBOX: '1' },
    },
    args: [],
    fullAccess: 'bypassPermissions',
    sessionMeta: { claudeCode: { options: { allowedTools: ['Bash(house:*)'] } } },
    allowHouse: nothing,
    signedIn: { command: ['auth', 'status'] },
    login: { args: ['auth', 'login', '--claudeai'], code: 'collect', rejected: 'Invalid code' },
    queues: false,
    turnStarted: () => false,
    turnEnded: ({ method, params }) =>
      method === 'session/update' &&
      params?.update?.sessionUpdate === 'usage_update' &&
      params.update._meta?.['_claude/origin'] !== undefined,
    job: asyncTask,
    phase: () => null,
  },
  'grok-build': {
    bin: 'grok',
    minimum: '1.0.46',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    adapter: null,
    args: ['agent', '--always-approve', '--no-leader', 'stdio'],
    fullAccess: null,
    sessionMeta: {},
    allowHouse: nothing,
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
    phase: () => null,
  },
};

const KIT_PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};

export const KIT_VERSION = KIT_PACKAGE.version;

const PROXY = /^https?_proxy$/i;
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;
// An install still running after fifteen minutes is ended and reported as failed, so a hung download cannot hold its CLI's report.
const INSTALL_MS = 15 * 60_000;
// A login shell or a version read is ended after half a minute, so a profile that waits for input cannot stall the report.
const READ_MS = 30_000;
const CAUSE_CHARACTERS = 4000;

function prefix(kind: string): string {
  return join(kitHome(), 'agents', kind);
}

export function adapterCommand(kind: string): string {
  return join(prefix(kind), 'node_modules', '.bin', CLIS[kind]!.adapter!.bin);
}

async function installedAdapter(kind: string): Promise<string | null> {
  try {
    const manifest = join(prefix(kind), 'node_modules', CLIS[kind]!.adapter!.package, 'package.json');
    return (JSON.parse(await readFile(manifest, 'utf8')) as { version: string }).version;
  } catch {
    return null;
  }
}

export interface Ran {
  status: number | null;
  stdout: string;
  output: string;
}

export function withoutProxy(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !PROXY.test(name)));
}

export function run(
  command: string,
  args: string[],
  timeoutMs: number,
  detached = false,
  signal?: AbortSignal,
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: withoutProxy(),
      detached,
      signal: detached ? undefined : signal,
    });
    const stop = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    };
    if (detached && signal?.aborted) stop();
    if (detached) signal?.addEventListener('abort', stop, { once: true });
    const ended = (ran: Ran) => {
      signal?.removeEventListener('abort', stop);
      resolve(ran);
    };
    let stdout = '';
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (error) => ended({ status: null, stdout, output: error.message }));
    child.on('close', (status) => ended({ status, stdout, output }));
  });
}

export function failureOf(ran: Ran, program: string): string {
  return ran.output.trim().slice(-CAUSE_CHARACTERS) || `${program} exited with ${ran.status ?? 'a signal'}`;
}

export async function installAdapter(kind: string, signal?: AbortSignal): Promise<string | null> {
  const adapter = CLIS[kind]!.adapter;
  if (adapter === null) return null;
  const release = KIT_PACKAGE.peerDependencies[adapter.package]!;
  if ((await installedAdapter(kind)) === release) return null;
  const ran = await run(
    'npm',
    ['install', '--prefix', prefix(kind), '--no-save', '--no-audit', '--no-fund', '--omit=optional', `${adapter.package}@${release}`],
    INSTALL_MS,
    true,
    signal,
  );
  return ran.status === 0 ? null : failureOf(ran, 'npm');
}

export async function installCli(kind: string, signal?: AbortSignal): Promise<string | null> {
  const ran = await run('bash', ['-o', 'pipefail', '-c', CLIS[kind]!.install], INSTALL_MS, true, signal);
  return ran.status === 0 ? null : failureOf(ran, 'the install');
}

function loginShell(): string {
  return process.env.SHELL || userInfo().shell!;
}

const FOUND = 'house-kit-cli ';
const LOOKUP = `found=$(command -v "$1") || exit 0; case $found in /*) ;; *) found=$(pwd -P)/$found ;; esac; printf "${FOUND}%s\\n" "$found"`;
const USER_BIN = 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$PATH:$HOME/.local/bin" ;; esac; export PATH';

function inLoginShell(script: string, argument = '', signal?: AbortSignal): Promise<Ran> {
  return run(loginShell(), ['-l', '-i', '-c', `exec /bin/sh -c '${USER_BIN}; ${script}' sh ${argument}`], READ_MS, true, signal);
}

export async function locate(kind: string, signal?: AbortSignal): Promise<string | null> {
  const ran = await inLoginShell(LOOKUP, CLIS[kind]!.bin, signal);
  return ran.stdout.split('\n').findLast((line) => line.startsWith(FOUND))?.slice(FOUND.length) ?? null;
}

export async function loginPath(): Promise<string> {
  const marker = 'house-kit-path ';
  const ran = await inLoginShell(`printf "${marker}%s\\n" "$PATH"`);
  return ran.stdout.split('\n').findLast((line) => line.startsWith(marker))!.slice(marker.length);
}

export async function versionOf(path: string, signal?: AbortSignal): Promise<string | null> {
  return VERSION.exec((await run(path, ['--version'], READ_MS, false, signal)).stdout)?.[0] ?? null;
}

function numbers(version: string): number[] {
  return version.split(/[.-]/, 3).map(Number);
}

export function below(found: string, minimum: string): boolean {
  const [have, need] = [numbers(found), numbers(minimum)];
  for (let index = 0; index < 3; index++) {
    if (have[index] !== need[index]) return have[index]! < need[index]!;
  }
  return found.includes('-') && !minimum.includes('-');
}

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { CLAUDE_KEY, CODEX_KEY, GROK_KEY, codexHome, type KeySettings } from './keys.ts';
import { releaseDirectory } from './placement.ts';
import { childEnvironment } from './relay.ts';

export interface Cli {
  name: string;
  bin: string;
  minimum: string;
  install: string;
  update: string;
  adapter: { package: string; bin: string; executable: string; env(unable: boolean): Record<string, string> } | null;
  args(fullAccess: boolean): string[];
  reads: 'AGENTS.md' | 'CLAUDE.md' | null;
  compactWords: boolean;
  fullAccess: string | null;
  sessionMeta(bridge: string, name: string | null, code: string | null, afk: boolean): Record<string, unknown>;
  unableToAsk: boolean;
  unknownSession(error: unknown): boolean;
  allowHouse(path: string): Promise<void>;
  signedIn: { command: string[] } | { initializeMeta: string; apiKey: string };
  login: { args: string[]; code: 'show' } | { args: string[]; code: 'collect'; rejected: string };
  key: KeySettings;
  air: string[];
}

const HOUSE_EXECUTABLES = /^host_executable\(name = "house", paths = (\[.*\])\)$/m;

function houseRule(houses: string[]): string {
  return `prefix_rule(pattern = ["house"], decision = "allow")\nhost_executable(name = "house", paths = ${JSON.stringify(houses)})\n`;
}

const RAW_SUBTYPES = [
  'background_tasks_changed',
  'task_started',
  'task_updated',
  'task_notification',
  'task_progress',
  'session_state_changed',
  'hook_started',
  'hook_response',
];

const RAW_TYPES = ['result', 'user', 'assistant', 'rate_limit_event', 'prompt_suggestion'];

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function listedHouses(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const listed: unknown = JSON.parse(HOUSE_EXECUTABLES.exec(text)?.[1] ?? '[]');
    return Array.isArray(listed) ? listed.filter((house) => typeof house === 'string') : [];
  } catch {
    return [];
  }
}

export async function allowHouseInCodex(path: string): Promise<void> {
  const candidates = [...new Set(path.split(delimiter).filter((directory) => isAbsolute(directory)))].map((directory) =>
    join(directory, 'house'),
  );
  const rules = join(codexHome(), 'rules');
  const file = join(rules, 'house.rules');
  const houses: string[] = [];
  for (const house of [...(await listedHouses(file)), ...candidates]) {
    if (!houses.includes(house) && (await executable(house))) houses.push(house);
  }
  await mkdir(rules, { recursive: true });
  const temporary = `${file}.${randomUUID()}`;
  await writeFile(temporary, houseRule(houses));
  await rename(temporary, file);
}

async function nothing(): Promise<void> {}

interface Answered {
  code?: unknown;
  data?: { details?: unknown; code?: unknown } | null;
}

function answered(error: unknown): Answered {
  return typeof error === 'object' && error !== null ? (error as Answered) : {};
}

function bridgeInClaudeSandbox(bridge: string): Record<string, unknown> {
  return process.platform === 'darwin' ? { allowUnixSockets: [bridge] } : { allowAllUnixSockets: true };
}

export const CLIS: Record<string, Cli> = {
  'codex-acp': {
    name: 'Codex',
    bin: 'codex',
    minimum: '0.165.0',
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    update: 'codex update',
    adapter: {
      package: '@agentclientprotocol/codex-acp',
      bin: 'codex-acp',
      executable: 'CODEX_PATH',
      env: (unable) => ({
        CODEX_CONFIG: JSON.stringify({
          features: { shell_zsh_fork: true },
          ...(unable ? { tools: { experimental_request_user_input: { enabled: false } } } : {}),
        }),
        ...(unable ? { HOUSE_KIT_AFK: '1' } : {}),
      }),
    },
    args: () => [],
    reads: 'AGENTS.md',
    compactWords: false,
    fullAccess: 'agent-full-access',
    sessionMeta: () => ({}),
    unableToAsk: true,
    unknownSession: (error) => {
      const { code, data } = answered(error);
      return code === -32603 && typeof data?.details === 'string' && data.details.startsWith('no rollout found');
    },
    allowHouse: allowHouseInCodex,
    signedIn: { command: ['login', 'status'] },
    login: { args: ['login', '--device-auth'], code: 'show' },
    key: CODEX_KEY,
    air: ['asyncTasks', 'nativeSubagentSessions'],
  },
  'claude-agent-acp': {
    name: 'Claude Code',
    bin: 'claude',
    minimum: '2.1.316',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    update: 'claude update',
    adapter: {
      package: '@agentclientprotocol/claude-agent-acp',
      bin: 'claude-agent-acp',
      executable: 'CLAUDE_CODE_EXECUTABLE',
      env: () => ({ CLAUDE_CODE_ENTRYPOINT: 'claude-agent-acp', IS_SANDBOX: '1' }),
    },
    args: () => [],
    reads: 'CLAUDE.md',
    compactWords: true,
    fullAccess: 'bypassPermissions',
    sessionMeta: (bridge, name, code, afk) => ({
      claudeCode: {
        options: {
          allowedTools: ['Bash(house:*)'],
          ...(afk ? { disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'], permissionPrompts: 'none' } : {}),
          includeHookEvents: true,
          settings: {
            sandbox: { network: bridgeInClaudeSandbox(bridge) },
            ...(code === null ? {} : { permissions: { additionalDirectories: [code] } }),
          },
          ...(name === null ? {} : { extraArgs: { name } }),
        },
        emitRawSDKMessages: [...RAW_SUBTYPES.map((subtype) => ({ type: 'system', subtype })), ...RAW_TYPES.map((type) => ({ type }))],
      },
    }),
    unableToAsk: true,
    unknownSession: (error) => answered(error).code === -32002,
    allowHouse: nothing,
    signedIn: { command: ['auth', 'status'] },
    login: { args: ['auth', 'login', '--claudeai'], code: 'collect', rejected: 'Invalid code' },
    key: CLAUDE_KEY,
    air: ['asyncTasks', 'sessionFailure'],
  },
  'grok-build': {
    name: 'Grok Build',
    bin: 'grok',
    minimum: '1.0.46',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    update: 'grok update',
    adapter: null,
    args: (fullAccess) => ['--sandbox', 'off', 'agent', ...(fullAccess ? ['--always-approve'] : []), '--no-leader', 'stdio'],
    reads: null,
    compactWords: false,
    fullAccess: null,
    sessionMeta: (_bridge, _name, _code, afk) => (afk ? { askUserQuestion: false } : {}),
    unableToAsk: false,
    unknownSession: (error) => answered(error).data?.code === 'FS_NOT_FOUND',
    allowHouse: nothing,
    signedIn: { initializeMeta: 'defaultAuthMethodId', apiKey: 'xai.api_key' },
    login: { args: ['login', '--device-auth'], code: 'show' },
    key: GROK_KEY,
    air: ['asyncTasks'],
  },
};

const KIT_PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};

export const KIT_RELEASE = KIT_PACKAGE.version;

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;
// An install or update still running after fifteen minutes is ended as failed, so a hung download can neither hold its CLI's report nor keep the Kit busy.
const INSTALL_MS = 15 * 60_000;
// A login shell or a version read is ended after half a minute, so a profile that waits for input cannot stall the report.
const READ_MS = 30_000;
const CAUSE_CHARACTERS = 4000;

export function adapterCommand(kind: string): string {
  return join(releaseDirectory(KIT_RELEASE), 'adapters', kind, 'node_modules', '.bin', CLIS[kind]!.adapter!.bin);
}

export interface Ran {
  status: number | null;
  stdout: string;
  output: string;
}

export async function cliEnvironment(kind: string): Promise<NodeJS.ProcessEnv> {
  return { ...childEnvironment(), ...(await CLIS[kind]!.key.environment?.()) };
}

export function run(
  command: string,
  args: string[],
  timeoutMs: number,
  detached = false,
  signal?: AbortSignal,
  env = childEnvironment(),
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env,
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

export function adapterArchive(kind: string): string {
  return `${kind}-${KIT_PACKAGE.peerDependencies[CLIS[kind]!.adapter!.package]!}.tar.gz`;
}

async function bounded(program: string, work: (signal: AbortSignal) => Promise<Ran>, signal?: AbortSignal): Promise<string | null> {
  const deadline = AbortSignal.timeout(INSTALL_MS);
  const ran = await work(signal === undefined ? deadline : AbortSignal.any([signal, deadline]));
  if (deadline.aborted && signal?.aborted !== true) return `${program} did not end within ${INSTALL_MS / 1000} seconds`;
  return ran.status === 0 ? null : failureOf(ran, program);
}

export function installCli(kind: string, signal?: AbortSignal): Promise<string | null> {
  return bounded('the install', (within) => run('bash', ['-o', 'pipefail', '-c', CLIS[kind]!.install], INSTALL_MS, true, within), signal);
}

function loginShell(): string {
  return process.env.SHELL || userInfo().shell!;
}

const FOUND = 'house-kit-cli ';
const LOOKUP = `found=$(command -v "$1") || exit 0; case $found in /*) ;; *) found=$(pwd -P)/$found ;; esac; printf "${FOUND}%s\\n" "$found"`;
const USER_BIN = 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$PATH:$HOME/.local/bin" ;; esac; export PATH';

function inLoginShell(script: string, argument = '', signal?: AbortSignal, timeoutMs = READ_MS): Promise<Ran> {
  return run(loginShell(), ['-l', '-i', '-c', `exec /bin/sh -c '${USER_BIN}; ${script}' sh ${argument}`], timeoutMs, true, signal);
}

export async function onLoginPath(program: string, signal?: AbortSignal): Promise<string | null> {
  const ran = await inLoginShell(LOOKUP, program, signal);
  return ran.stdout.split('\n').findLast((line) => line.startsWith(FOUND))?.slice(FOUND.length) ?? null;
}

export function locate(kind: string, signal?: AbortSignal): Promise<string | null> {
  return onLoginPath(CLIS[kind]!.bin, signal);
}

export function updateCli(kind: string): Promise<string | null> {
  return bounded('the update', (within) => inLoginShell(CLIS[kind]!.update, '', within, INSTALL_MS));
}

export async function loginPath(): Promise<string> {
  const marker = 'house-kit-path ';
  const ran = await inLoginShell(`printf "${marker}%s\\n" "$PATH"`);
  return ran.stdout.split('\n').findLast((line) => line.startsWith(marker))!.slice(marker.length);
}

export async function writeCodexRule(): Promise<void> {
  const shell = await loginPath().catch(() => '');
  await allowHouseInCodex([dirname(process.execPath), process.env.PATH ?? '', shell].join(delimiter)).catch((error: Error) => {
    throw new Error(`Codex's rule for house could not be written: ${error.message}`);
  });
}

export async function versionOf(kind: string, path: string, signal?: AbortSignal): Promise<string | null> {
  return VERSION.exec((await run(path, ['--version'], READ_MS, false, signal, await cliEnvironment(kind))).stdout)?.[0] ?? null;
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

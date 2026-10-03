import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kitHome } from './home.ts';

export interface Cli {
  package: string;
  bin: string;
  args: string[];
  signedIn: { command: string[] } | { initializeMeta: string };
}

export const CLIS: Record<string, Cli> = {
  'codex-acp': {
    package: '@agentclientprotocol/codex-acp',
    bin: 'codex-acp',
    args: [],
    signedIn: { command: ['cli', 'login', 'status'] },
  },
  'claude-agent-acp': {
    package: '@agentclientprotocol/claude-agent-acp',
    bin: 'claude-agent-acp',
    args: [],
    signedIn: { command: ['--cli', 'auth', 'status'] },
  },
  'grok-build': {
    package: '@xai-official/grok',
    bin: 'grok',
    args: ['agent', '--no-leader', 'stdio'],
    signedIn: { initializeMeta: 'defaultAuthMethodId' },
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

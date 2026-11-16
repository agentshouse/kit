#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { constants as system } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { localCopies } from './git.ts';
import { kitHome } from './home.ts';

interface Outcome {
  status: number | null;
  signal: NodeJS.Signals | null;
}

const VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix']);
const READS = new Set([
  'blame',
  'branch',
  'cat-file',
  'check-ignore',
  'config',
  'describe',
  'diff',
  'fetch',
  'for-each-ref',
  'grep',
  'help',
  'log',
  'ls-files',
  'ls-tree',
  'reflog',
  'remote',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'tag',
  'version',
]);
const RELAYED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

function nativeGit(): string | null {
  const shim = join(kitHome(), 'shim');
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    try {
      if (realpathSync(directory) === realpathSync(shim)) continue;
      const candidate = join(directory, 'git');
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function captured(git: string, args: string[]): string | null {
  const ran = spawnSync(git, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: Infinity,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return ran.status === 0 ? ran.stdout.toString('utf8') : null;
}

function delegated(git: string, args: string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(git, args, { stdio: 'inherit' });
    const relay = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of RELAYED) process.on(signal, relay);
    const settle = (outcome: Outcome) => {
      for (const signal of RELAYED) process.off(signal, relay);
      resolve(outcome);
    };
    child.once('error', (error) => {
      process.stderr.write(`git: ${error.message}\n`);
      settle({ status: 127, signal: null });
    });
    child.once('close', (status, signal) => settle({ status, signal }));
  });
}

function moved(git: string, copy: string[], before: string): { from: string; to: string }[] {
  const renames = ['diff-index', '--cached', '-z', '--name-status', '--find-renames=100%', '--diff-filter=R', before];
  const fields = (captured(git, [...copy, ...renames]) ?? '').split('\0');
  const moves: { from: string; to: string }[] = [];
  for (let at = 0; at + 2 < fields.length; at += 3) moves.push({ from: fields[at + 1]!, to: fields[at + 2]! });
  return moves;
}

function reported(socketPath: string, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    const sent = request({ socketPath, path: '/git/observed', method: 'POST' }, (answer) => {
      answer.resume();
      answer.on('end', resolve);
    });
    sent.on('error', () => resolve());
    sent.end(JSON.stringify(body));
  });
}

async function observed(git: string, args: string[]): Promise<Outcome> {
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) index += VALUED.has(args[index]!) ? 2 : 1;
  const globals = args.slice(0, index);
  const name = args[index];
  const bridge = process.env.HOUSE_BRIDGE;
  if (bridge === undefined || name === undefined || READS.has(name)) return delegated(git, args);
  const located = captured(git, [...globals, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']);
  const [common, worktree] = located?.split('\n') ?? [];
  if (common === undefined || worktree === undefined || !dirname(common).startsWith(`${localCopies()}/`)) {
    return delegated(git, args);
  }
  const copy = [...globals, '-C', worktree];
  const before = name === 'mv' ? captured(git, [...copy, 'write-tree'])?.trim() : undefined;
  const outcome = await delegated(git, args);
  const moves = before !== undefined && outcome.status === 0 ? moved(git, copy, before) : [];
  await reported(bridge, { common, worktree, moves });
  return outcome;
}

const git = nativeGit();
if (git === null) {
  process.stderr.write('git: no installed Git found on PATH\n');
  process.exitCode = 127;
} else {
  observed(git, process.argv.slice(2)).then(({ status, signal }) => {
    if (signal === null) {
      process.exitCode = status ?? 1;
      return;
    }
    process.exitCode = 128 + system.signals[signal];
    process.kill(process.pid, signal);
  });
}

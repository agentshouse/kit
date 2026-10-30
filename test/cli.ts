import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTER = fileURLToPath(new URL('./adapter.ts', import.meta.url));
const APP_SERVER = fileURLToPath(new URL('./app-server.ts', import.meta.url));
const DEVICE_LOGIN = fileURLToPath(new URL('./device-login.ts', import.meta.url));
const CLI = fileURLToPath(import.meta.url);

export const BINS: Record<string, string> = {
  'codex-acp': 'codex',
  'claude-agent-acp': 'claude',
  'grok-build': 'grok',
};

export const RELEASES: Record<string, string> = {
  'codex-acp': '0.161.0',
  'claude-agent-acp': '2.1.304',
  'grok-build': '1.0.47',
};

const VERSION_LINES: Record<string, (release: string) => string> = {
  'codex-acp': (release) => `codex-cli ${release}`,
  'claude-agent-acp': (release) => `${release} (Claude Code)`,
  'grok-build': (release) => `grok ${release} (2765805b9442)`,
};

export interface Updated {
  kind: string;
  path: string;
  held?: true;
  pid?: number;
  ended?: true;
}

export function placeUserCli(directory: string, kind: string, release = RELEASES[kind]!): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, BINS[kind]!);
  const staged = `${path}.${process.pid}`;
  writeFileSync(
    staged,
    [
      '#!/bin/sh',
      `export ADAPTER_KIND=${kind} CLI_PATH="$0" CLI_RELEASE=${release}`,
      `if [ "$1" = --version ]; then echo '${VERSION_LINES[kind]!(release)}'; exit 0; fi`,
      `if [ "$1" = update ]; then exec ${process.execPath} ${CLI} update ${kind} "$0"; fi`,
      `case " $* " in *" --device-auth "*|*" --claudeai "*) exec ${process.execPath} ${DEVICE_LOGIN} "$@" ;; esac`,
      `case " $* " in *" app-server "*) exec ${process.execPath} ${APP_SERVER} "$@" ;; esac`,
      `exec ${process.execPath} ${ADAPTER} "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(staged, 0o755);
  renameSync(staged, path);
  return path;
}

export function linkUserCli(home: string, directory: string, kind: string, release = RELEASES[kind]!): string {
  const link = join(directory, BINS[kind]!);
  const target = placeUserCli(join(home, 'versions', release), kind, release);
  const staged = `${link}.${process.pid}`;
  mkdirSync(directory, { recursive: true });
  symlinkSync(target, staged);
  renameSync(staged, link);
  return link;
}

export function updatesRun(home: string): Updated[] {
  const log = join(home, 'updates.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Updated);
}

function updateUserCli(kind: string, path: string): void {
  const home = process.env.HOUSE_KIT_HOME!;
  const log = (entry: Updated) => appendFileSync(join(home, 'updates.log'), `${JSON.stringify(entry)}\n`);
  log({ kind, path });
  if (existsSync(join(home, 'update-hold'))) log({ kind, path, held: true, pid: process.pid });
  while (existsSync(join(home, 'update-hold'))) {
    // The held update looks for its release every twentieth of a second, so it ends as soon as the spec lets it.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (existsSync(join(home, 'update-fail'))) {
    process.stderr.write('The update could not be downloaded\n');
    process.exit(1);
  }
  const next = join(home, `update-${kind}`);
  if (existsSync(next)) {
    const release = readFileSync(next, 'utf8').trim();
    rmSync(next);
    if (lstatSync(path).isSymbolicLink()) linkUserCli(home, dirname(path), kind, release);
    else placeUserCli(dirname(path), kind, release);
  }
  log({ kind, path, ended: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'update') updateUserCli(process.argv[3]!, process.argv[4]!);
  else placeUserCli(process.argv[3]!, process.argv[2]!, process.argv[4]);
}

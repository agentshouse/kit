import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTER = fileURLToPath(new URL('./adapter.ts', import.meta.url));
const APP_SERVER = fileURLToPath(new URL('./app-server.ts', import.meta.url));
const DEVICE_LOGIN = fileURLToPath(new URL('./device-login.ts', import.meta.url));

export const BINS: Record<string, string> = {
  'codex-acp': 'codex',
  'claude-agent-acp': 'claude',
  'grok-build': 'grok',
};

export const RELEASES: Record<string, string> = {
  'codex-acp': '0.160.0',
  'claude-agent-acp': '2.1.290',
  'grok-build': '1.0.47',
};

const VERSION_LINES: Record<string, (release: string) => string> = {
  'codex-acp': (release) => `codex-cli ${release}`,
  'claude-agent-acp': (release) => `${release} (Claude Code)`,
  'grok-build': (release) => `grok ${release} (2765805b9442)`,
};

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  placeUserCli(process.argv[3]!, process.argv[2]!);
}

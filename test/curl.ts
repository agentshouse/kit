import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIS } from '../src/clis.ts';
import { recordStart } from './started.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

export const LOCATIONS: Record<string, string> = {
  'codex-acp': '.local/bin',
  'claude-agent-acp': '.local/bin',
  'grok-build': '.grok/bin',
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  recordStart('curl');
  const url = process.argv.at(-1)!;
  appendFileSync(join(process.env.HOUSE_KIT_HOME!, 'curl.log'), `${url}\n`);
  const kind = Object.keys(CLIS).find((candidate) => CLIS[candidate]!.install.includes(` ${url} `));
  if (kind === undefined) process.exit(spawnSync('/usr/bin/curl', process.argv.slice(2), { stdio: 'inherit' }).status ?? 1);
  if (existsSync(join(process.env.HOUSE_KIT_HOME!, `install-stall-${kind}`))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  // The held install looks for its hold file every twentieth of a second, so it goes on as soon as the spec removes it.
  while (existsSync(join(process.env.HOUSE_KIT_HOME!, `install-hold-${kind}`))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  process.stdout.write(
    [
      `if grep -qx ${kind} "$HOUSE_KIT_HOME/install-fail" 2>/dev/null; then cat "$HOUSE_KIT_HOME/install-output" 2>/dev/null; echo "Checksum verification failed" >&2; exit 1; fi`,
      `${process.execPath} ${CLI} ${kind} "$HOME/${LOCATIONS[kind]}"`,
      ...(kind === 'claude-agent-acp' ? [] : [`printf '%s\\n' 'PATH="$HOME/${LOCATIONS[kind]}:$PATH"' >> "$HOME/.profile"`]),
      '',
    ].join('\n'),
  );
}

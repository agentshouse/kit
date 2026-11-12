import { readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './kit.ts';

export const ROOTED = ['--import', fileURLToPath(new URL('./rooted.ts', import.meta.url))];
export const DARWIN = ['--import', fileURLToPath(new URL('./darwin.ts', import.meta.url))];

const LOGGED = 'printf \'%s %s\\n\' "${0##*/}" "$*" >> "$FAKE/log"\n';

const ROOTED_ARGUMENTS = `for word; do
  case "$word" in /opt/house-kit*|/usr/local/bin*|/etc/systemd/system*|/agents*) set -- "$@" "$KIT_TEST_ROOT$word" ;; *) set -- "$@" "$word" ;; esac
  shift
done
`;

const TOOLS: Record<string, string> = {
  systemctl: `${LOGGED}case "$*" in
  *is-active*) [ -e "$FAKE/active" ] ;;
  *is-enabled*) [ -e "$FAKE/enabled" ] ;;
  *'--no-block stop house-kit.service'*) kill -TERM "$PPID" ;;
  *enable*) touch "$FAKE/enabled" ;;
  *'start house-kit.service') touch "$FAKE/active" ;;
esac
`,
  loginctl: `${LOGGED}[ ! -e "$FAKE/linger-refused" ] || { echo 'Could not enable linger: Access denied' >&2; exit 1; }\n`,
  launchctl: `${LOGGED}case "$1" in
  print)
    [ -e "$FAKE/loaded" ] || exit 113
    if [ -e "$FAKE/active" ]; then state=running; else state='not running'; fi
    printf '%s = {\\n\\tstate = %s\\n}\\n' "$2" "$state"
    ;;
  bootstrap) touch "$FAKE/loaded" "$FAKE/active" ;;
  bootout) rm -f "$FAKE/loaded" "$FAKE/active" ;;
  kickstart) touch "$FAKE/active" ;;
esac
`,
  docker: `${LOGGED}[ ! -e "$FAKE/docker-down" ] || exit 1
case "$1" in
  info) ;;
  container) [ -e "$FAKE/container" ] && cat "$FAKE/container" ;;
  rm) rm "$FAKE/container" ;;
esac
`,
  sudo: `${LOGGED}${ROOTED_ARGUMENTS}exec "$@"\n`,
  rm: `${ROOTED_ARGUMENTS}exec /bin/rm "$@"\n`,
  rmdir: `${ROOTED_ARGUMENTS}exec /bin/rmdir "$@"\n`,
  id: 'case "$*" in -un) echo owner ;; *) exec /usr/bin/id "$@" ;; esac\n',
};

export interface Supervision {
  root: string;
  fake: string;
  path: string;
  environment: Record<string, string>;
  calls(tool: string): string[];
  mark(name: string): Promise<void>;
  systemd(): Promise<void>;
}

export async function supervision(): Promise<Supervision> {
  const fake = await temporaryDirectory();
  const root = await temporaryDirectory();
  const bin = join(fake, 'bin');
  await mkdir(bin);
  for (const [tool, body] of Object.entries(TOOLS)) {
    await writeFile(join(bin, tool), `#!/bin/sh\n${body}`);
    await chmod(join(bin, tool), 0o755);
  }
  const path = `${bin}:${process.env.PATH}`;
  return {
    root,
    fake,
    path,
    environment: { PATH: path, FAKE: fake, KIT_TEST_ROOT: root },
    calls: (tool) =>
      readFileSync(join(fake, 'log'), { encoding: 'utf8', flag: 'a+' })
        .split('\n')
        .filter((line) => line.startsWith(`${tool} `))
        .map((line) => line.slice(tool.length + 1)),
    mark: (name) => writeFile(join(fake, name), ''),
    systemd: async () => {
      await mkdir(join(root, 'run', 'systemd', 'system'), { recursive: true });
    },
  };
}

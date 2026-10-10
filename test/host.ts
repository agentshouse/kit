import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryHome } from './kit.ts';

const LINUX = fileURLToPath(new URL('../bin/connect-linux.sh', import.meta.url));

export const PUBLISHED_VERSION = '0.2.1-alpha.1';
export const LOGIN_LINK = 'https://agents.house/kit/login/one';

export async function published(): Promise<string> {
  const home = await temporaryHome();
  const script = join(home, 'connect-linux.sh');
  await writeFile(
    script,
    (await readFile(LINUX, 'utf8')).replace('__IMAGE_DIGEST__', 'a'.repeat(64)).replace('__KIT_VERSION__', PUBLISHED_VERSION),
  );
  return script;
}

export interface Platform {
  system: 'Linux' | 'Darwin';
  machine: string;
  appleSilicon?: boolean;
  macos?: string;
  shell?: string;
  environment?: Record<string, string>;
}

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Host {
  home: string;
  run(argv?: string[]): Ran;
  terminal(argv: string[], typed: string): Ran;
  command(name: string, argv: string[]): Ran;
  calls(tool: string): string[];
  mark(name: Mark): Promise<void>;
  clear(name: Mark): Promise<void>;
  forget(): Promise<void>;
  uninstall(tool: string): Promise<void>;
  restartPolicy(policy: string): Promise<void>;
}

type Mark = 'changed' | 'container' | 'docker-down' | 'login-fails' | 'opener-fails' | 'refused';

const LOGGED = 'printf \'%s %s\\n\' "${0##*/}" "$*" >> "$FAKE/log"\n';

const LOGIN = `[ ! -e "$FAKE/login-fails" ] || exit 7
printf 'Open this link and confirm: ${LOGIN_LINK}\\n'
printf '{"house":"https://agents.house","environment":"%s","credential":"ahk_one"}' "\${2:-environment-one}" > "$1/credential.json"
`;

const TOOLS: Record<string, string> = {
  uname: 'case "$1" in -s) echo "$FAKE_SYSTEM" ;; -m) echo "$FAKE_MACHINE" ;; *) exec /bin/uname "$@" ;; esac\n',
  sysctl: 'echo "$FAKE_ARM64"\n',
  sw_vers: 'echo "$FAKE_MACOS"\n',
  curl: `${LOGGED}while [ $# -gt 1 ]; do [ "$1" != -o ] || out=$2; shift; done\ncp "$FAKE/node.tar.gz" "$out"\n`,
  sha256sum: `${LOGGED}cat >/dev/null\n`,
  shasum: `${LOGGED}cat >/dev/null\n`,
  systemctl: `${LOGGED}case "$*" in
  *is-active*) [ -e "$FAKE/active" ] ;;
  *enable*|*restart*) touch "$FAKE/active" ;;
  *stop*) rm -f "$FAKE/active" ;;
esac\n`,
  launchctl: `${LOGGED}case "$1" in
  print) [ -e "$FAKE/loaded" ] ;;
  bootstrap) [ ! -e "$FAKE/loaded" ] && touch "$FAKE/loaded" ;;
  bootout) rm "$FAKE/loaded" ;;
esac\n`,
  docker: `${LOGGED}[ ! -e "$FAKE/docker-down" ] || exit 1
case "$1" in
  info) case "$3" in *OperatingSystem*) echo 'Docker Desktop' ;; *) echo linux/x86_64 ;; esac ;;
  container) [ -e "$FAKE/container" ] ;;
  inspect)
    . "$FAKE/container"
    printf '%s\\n' "$3" | sed -e "s|{{.Config.Image}}|$image|" -e "s|{{.HostConfig.RestartPolicy.Name}}|$policy|" -e 's|{{len .Mounts}}|2|' \\
      -e "s|{{range .Mounts}}{{if eq .Destination \\"/kit-home\\"}}{{.Source}}{{end}}{{end}}|$home|" \\
      -e "s|{{range .Mounts}}{{if eq .Destination \\"/agents/house\\"}}{{.Source}}{{end}}{{end}}|$workspace|" \\
      -e 's|{{range .Mounts}}{{if eq .Destination "[^"]*"}}{{.Type}}/{{.RW}}{{end}}{{end}}|bind/true|' \\
      -e "s|{{index .Config.Labels \\"agentshouse.house\\"}}|$label|" -e 's|{{.State.Running}}|true|'
    ;;
  rm) rm "$FAKE/container" ;;
  run)
    for argument; do
      case "$previous" in
        --restart) policy=$argument ;;
        --label) label=\${argument#*=} ;;
      esac
      case "$argument" in
        *dst=/kit-home) home=\${argument#*src=}; home=\${home%%\\",dst=*} ;;
        *dst=/agents/house) workspace=\${argument#*src=}; workspace=\${workspace%%\\",dst=*} ;;
        HOUSE_KIT_REPLACES=*) replacing=environment-two ;;
        -d) detached=1 ;;
      esac
      image=$previous
      previous=$argument
    done
    [ -z "$detached" ] || printf 'image=%s\\npolicy=%s\\nhome=%s\\nworkspace=%s\\nlabel=%s\\n' "$image" "$policy" "$home" "$workspace" "$label" > "$FAKE/container"
    if [ "$previous" = login ]; then set -- "$home" "$replacing"; ${LOGIN.replaceAll('\n', '\n    ')}fi
    ;;
esac\n`,
  sudo: `${LOGGED}exit 1\n`,
  'xdg-open': `${LOGGED}[ ! -e "$FAKE/opener-fails" ]\n`,
  open: `${LOGGED}[ ! -e "$FAKE/opener-fails" ]\n`,
  zsh: '[ ! -f "${ZDOTDIR:-$HOME}/.zshenv" ] || . "${ZDOTDIR:-$HOME}/.zshenv"\n[ "$1" != -c ] || eval "$2"\n',
};

const NODE = `printf 'node %s\\n' "\${1##*/}" >> "$FAKE/log"
[ "\${1##*/}" != authority-main.js ] || [ ! -e "$FAKE/refused" ] || exit 1
[ "\${1##*/}" != configure-main.js ] || [ ! -e "$FAKE/changed" ] || echo changed
[ "\${1##*/}" != clis-main.js ] || [ ! -e "$HOME/.clis" ] || cat "$HOME/.clis"
`;

const NPM = `${LOGGED}while [ $# -gt 0 ]; do [ "$1" != --prefix ] || prefix=$2; shift; done
mkdir -p "$prefix/lib/node_modules/@agentshouse/kit/dist" "$prefix/bin"
cp "$FAKE/kit" "$prefix/bin/kit"
cp "$FAKE/kit" "$prefix/bin/house"
`;

const KIT = `printf '%s %s HOUSE_KIT_HOME=%s%s\\n' "\${0##*/}" "$*" "$HOUSE_KIT_HOME" "\${HOUSE_KIT_REPLACES:+ HOUSE_KIT_REPLACES=$HOUSE_KIT_REPLACES}" >> "$FAKE/log"
if [ "$1" = login ]; then set -- "$HOUSE_KIT_HOME" "\${HOUSE_KIT_REPLACES:+environment-two}"; ${LOGIN}fi
`;

async function script(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
}

export async function fakeHost(platform: Platform): Promise<Host> {
  const home = await temporaryHome();
  const fake = await temporaryHome();
  const bin = join(fake, 'bin');
  await mkdir(bin);
  for (const [tool, body] of Object.entries(TOOLS)) await script(join(bin, tool), body);
  await script(join(fake, 'kit'), KIT);
  const system = platform.system === 'Darwin' ? 'darwin' : 'linux';
  const unpacked = `node-v24.21.0-${system}-${/arm64|aarch64/.test(platform.machine) ? 'arm64' : 'x64'}`;
  await mkdir(join(fake, unpacked, 'bin'), { recursive: true });
  await script(join(fake, unpacked, 'bin', 'node'), NODE);
  await script(join(fake, unpacked, 'bin', 'npm'), NPM);
  spawnSync('tar', ['-czf', join(fake, 'node.tar.gz'), '-C', fake, unpacked]);
  const bootstrap = await published();
  const environment = {
    HOME: home,
    SHELL: platform.shell === 'zsh' ? join(bin, 'zsh') : (platform.shell ?? '/bin/bash'),
    PATH: `${bin}:/usr/bin:/bin`,
    FAKE: fake,
    FAKE_SYSTEM: platform.system,
    FAKE_MACHINE: platform.machine,
    FAKE_ARM64: platform.appleSilicon === false ? '0' : '1',
    FAKE_MACOS: platform.macos ?? '27.0.1',
    ...platform.environment,
  };
  const ran = (command: string, argv: string[]): Ran => {
    const finished = spawnSync(command, argv, { encoding: 'utf8', env: environment });
    return { status: finished.status, stdout: finished.stdout, stderr: finished.stderr };
  };
  return {
    home,
    run: (argv = []) => ran('bash', [bootstrap, ...argv]),
    terminal: (argv, typed) => {
      const line = ['cat', bootstrap, '|', 'bash', '-s', '--', ...argv]
        .map((word) => (word === '|' ? word : `'${word.replaceAll("'", `'\\''`)}'`))
        .join(' ');
      const finished = spawnSync('script', ['-qec', line, '/dev/null'], { encoding: 'utf8', env: environment, input: typed });
      return { status: finished.status, stdout: finished.stdout.replaceAll('\r\n', '\n'), stderr: finished.stderr };
    },
    command: (name, argv) => ran(join(home, '.local', 'bin', name), argv),
    calls: (tool) =>
      readFileSync(join(fake, 'log'), { encoding: 'utf8', flag: 'a+' })
        .split('\n')
        .filter((line) => line.startsWith(`${tool} `))
        .map((line) => line.slice(tool.length + 1)),
    mark: (name) => writeFile(join(fake, name), ''),
    clear: (name) => rm(join(fake, name), { force: true }),
    forget: () => writeFile(join(fake, 'log'), ''),
    uninstall: (tool) => rm(join(bin, tool)),
    restartPolicy: async (policy) =>
      writeFile(join(fake, 'container'), (await readFile(join(fake, 'container'), 'utf8')).replace(/^policy=.*$/m, `policy=${policy}`)),
  };
}

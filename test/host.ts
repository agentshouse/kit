import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryHome } from './kit.ts';

const LINUX = fileURLToPath(new URL('../bin/connect-linux.sh', import.meta.url));
const SERVICE_MAIN = fileURLToPath(new URL('../src/service-main.ts', import.meta.url));
const DARWIN = fileURLToPath(new URL('./darwin.ts', import.meta.url));

export const PUBLISHED_VERSION = '0.2.1-alpha.1';
const OUTDATED_VERSION = '0.2.1-alpha.0';
export const LOGIN_LINK = 'https://agents.house/kit/login/one';

export async function published(): Promise<string> {
  const home = await temporaryHome();
  const script = join(home, 'connect-linux.sh');
  await writeFile(
    script,
    (await readFile(LINUX, 'utf8'))
      .replace('__IMAGE_DIGEST__', 'a'.repeat(64))
      .replace('__KIT_RELEASE__', PUBLISHED_VERSION)
      .replace('__KIT_SHA256__', 'b'.repeat(64)),
  );
  return script;
}

export const UBUNTU_26_04 = "ID=ubuntu\nVERSION_ID=26.04\nVERSION_CODENAME=resolute\nUBUNTU_CODENAME=resolute\nPRETTY_NAME='Ubuntu 26.04 LTS'\n";

export interface Platform {
  system: 'Linux' | 'Darwin';
  machine: string;
  server?: boolean;
  appleSilicon?: boolean;
  macos?: string;
  osRelease?: string;
  systemd?: boolean;
  glibc?: boolean;
  absent?: string[];
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
  prefixes: { desktop: string; server: string; container: string };
  run(argv?: string[], added?: Record<string, string>): Ran;
  terminal(argv: string[], typed: string, added?: Record<string, string>): Ran;
  command(name: string, argv: string[]): Ran;
  shell(line: string): Ran;
  calls(tool: string): string[];
  mark(name: Mark): Promise<void>;
  clear(name: Mark): Promise<void>;
  forget(): Promise<void>;
  outdate(): Promise<void>;
  publish(version: string): Promise<void>;
  uninstall(tool: string): Promise<void>;
  serverUnit(): Promise<string>;
  restartPolicy(policy: string): Promise<void>;
}

type Mark = 'active' | 'changed' | 'container' | 'docker-down' | 'enabled' | 'login-abandoned' | 'login-fails' | 'opener-fails' | 'refused' | 'stopped' | 'systemd';

const LOGGED = 'printf \'%s %s\\n\' "${0##*/}" "$*" >> "$FAKE/log"\n';

const LOGIN = `printf 'placement %s\\n' "$(cat "$1/placement" 2>/dev/null)" >> "$FAKE/log"
[ ! -e "$FAKE/login-fails" ] || exit 7
printf 'Open this link and confirm: ${LOGIN_LINK}\\n'
[ ! -e "$FAKE/login-abandoned" ] || { kill -INT "$PPID"; kill -INT $$; }
printf '{"house":"https://agents.house","environment":"%s","credential":"ahk_one"}' "\${2:-environment-one}" > "$1/credential.json"
`;

const TOOLS: Record<string, string> = {
  uname: 'case "$1" in -s) echo "$FAKE_SYSTEM" ;; -m) echo "$FAKE_MACHINE" ;; *) exec /bin/uname "$@" ;; esac\n',
  sysctl: 'echo "$FAKE_ARM64"\n',
  sw_vers: 'echo "$FAKE_MACOS"\n',
  curl: `${LOGGED}while [ $# -gt 1 ]; do [ "$1" != -o ] || out=$2; shift; done\ncase "$1" in */kit-installer/node-v*) cp "$FAKE/node.tar.gz" "$out" ;; */kit-installer/kit-*) cp "$FAKE/kit.tar.gz" "$out" ;; *) cp "$FAKE/node.tar.gz" "$out" ;; esac\n`,
  sha256sum: `${LOGGED}cat >/dev/null\n`,
  shasum: `${LOGGED}cat >/dev/null\n`,
  systemctl: `${LOGGED}case "$*" in
  *show*) sed -n 's/^Environment="\\(.*\\)"$/\\1/p' "$HOME/.config/systemd/user/house-kit.service" | tr '\\n' ' ' ;;
  *is-enabled*) [ -e "$FAKE/enabled" ] ;;
  *is-active*) [ -e "$FAKE/active" ] ;;
  *disable*) rm -f "$FAKE/enabled" ;;
  *enable*) touch "$FAKE/enabled" "$FAKE/active" ;;
  *start*) touch "$FAKE/active" ;;
  *stop*) rm -f "$FAKE/active" ;;
esac\n`,
  launchctl: `${LOGGED}case "$1" in
  print)
    [ -e "$FAKE/loaded" ] || exit 113
    if [ -e "$FAKE/active" ]; then state=running; else state='not running'; fi
    home=$(sed -n '/<key>HOUSE_KIT_HOME<\\/key>/{n;s/.*<string>\\(.*\\)<\\/string>.*/\\1/p;}' "$HOME/Library/LaunchAgents/house-kit.plist")
    printf '%s = {\\n\\tactive count = 0\\n\\tstate = %s\\n\\n\\tprogram = kit\\n\\tenvironment = {\\n\\t\\tHOUSE_KIT_HOME => %s\\n\\t}\\n}\\n' "$2" "$state" "$home"
    ;;
  bootstrap) [ ! -e "$FAKE/loaded" ] && touch "$FAKE/loaded" "$FAKE/active" ;;
  bootout) rm -f "$FAKE/active" && rm "$FAKE/loaded" ;;
  kickstart) [ -e "$FAKE/loaded" ] && touch "$FAKE/active" ;;
esac\n`,
  docker: `${LOGGED}[ ! -e "$FAKE/docker-down" ] || exit 1
case "$1" in
  info) case "$3" in *OperatingSystem*) echo 'Docker Desktop' ;; *) echo linux/x86_64 ;; esac ;;
  container) [ -e "$FAKE/container" ] ;;
  inspect)
    . "$FAKE/container"
    running=true
    [ ! -e "$FAKE/stopped" ] || running=false
    printf '%s\\n' "$3" | sed -e "s|{{.Config.Image}}|$image|" -e "s|{{.HostConfig.RestartPolicy.Name}}|$policy|" -e 's|{{len .Mounts}}|2|' \\
      -e "s|{{range .Mounts}}{{if eq .Destination \\"/kit-home\\"}}{{.Source}}{{end}}{{end}}|$home|" \\
      -e "s|{{range .Mounts}}{{if eq .Destination \\"/agents/house\\"}}{{.Source}}{{end}}{{end}}|$workspace|" \\
      -e 's|{{range .Mounts}}{{if eq .Destination "[^"]*"}}{{.Type}}/{{.RW}}{{end}}{{end}}|bind/true|' \\
      -e "s|{{index .Config.Labels \\"agentshouse.house\\"}}|$label|" -e "s|{{.State.Running}}|$running|"
    ;;
  rm) rm "$FAKE/container" ;;
  run)
    for argument; do
      case "$previous" in
        --restart) policy=$argument ;;
        --label) label=\${argument#*=} ;;
        --entrypoint) entrypoint=$argument ;;
      esac
      case "$argument" in
        *dst=/kit-home) home=\${argument#*src=}; home=\${home%%\\",dst=*} ;;
        *dst=/agents/house) workspace=\${argument#*src=}; workspace=\${workspace%%\\",dst=*} ;;
        HOUSE_KIT_REPLACES=*) replacing=environment-two ;;
        -d) detached=1 ;;
        login) login=1 ;;
        --help) help=1 ;;
      esac
      image=$previous
      previous=$argument
    done
    [ -z "$detached" ] || printf 'image=%s\\npolicy=%s\\nhome=%s\\nworkspace=%s\\nlabel=%s\\n' "$image" "$policy" "$home" "$workspace" "$label" > "$FAKE/container"
    if [ "$entrypoint" = bash ]; then
      while [ "$1" != - ]; do shift; done
      exec env FAKE_SYSTEM=Linux FAKE_MACHINE=x86_64 FAKE_GLIBC=1 NODE_EXTRA_CA_CERTS="$home/certificates.pem" bash -s -- "$2" "$3" "$4" "$home\${5#/kit-home}"
    fi
    if [ -n "$login" ] && [ -z "$help" ]; then set -- "$home" "$replacing"; ${LOGIN.replaceAll('\n', '\n    ')}fi
    ;;
esac\n`,
  sudo: `${LOGGED}case "$1" in
  -u) shift 2; exec "$@" ;;
  apt-get) exec "$@" ;;
  tee) { printf 'tee '; tr '\\n' ' '; printf '\\n'; } >> "$FAKE/log" ;;
esac\n`,
  'apt-get': `${LOGGED}case "$*" in *docker-ce*) rm -f "$FAKE/docker-down" ;; esac\n`,
  'dpkg-query': ':\n',
  dpkg: 'case "$FAKE_MACHINE" in aarch64|arm64) echo arm64 ;; *) echo amd64 ;; esac\n',
  getconf: '[ "$1" = GNU_LIBC_VERSION ] || exec /usr/bin/getconf "$@"\n[ "$FAKE_GLIBC" = 1 ] && echo \'glibc 2.41\'\n',
  security: `${LOGGED}printf -- '-----BEGIN CERTIFICATE-----\\nthe keychain authority\\n-----END CERTIFICATE-----\\n'\n`,
  id: 'case "$*" in -un|-nG|"-nG owner") echo owner ;; *) exec /usr/bin/id "$@" ;; esac\n',
  'xdg-open': `${LOGGED}[ ! -e "$FAKE/opener-fails" ]\n`,
  open: `${LOGGED}[ ! -e "$FAKE/opener-fails" ]\n`,
  zsh: '[ ! -f "${ZDOTDIR:-$HOME}/.zshenv" ] || . "${ZDOTDIR:-$HOME}/.zshenv"\n[ "$1" != -c ] || eval "$2"\n',
};

const NODE = `printf 'node %s\\n' "\${1##*/}" >> "$FAKE/log"
[ "\${1##*/}" != authority-main.js ] || [ ! -e "$FAKE/refused" ] || exit 1
[ "\${1##*/}" != configure-main.js ] || [ ! -e "$FAKE/changed" ] || echo changed
if [ "\${1##*/}" = service-main.js ]; then
  [ "$FAKE_SYSTEM" != Darwin ] || exec ${process.execPath} --import ${DARWIN} ${SERVICE_MAIN}
  exec ${process.execPath} ${SERVICE_MAIN}
fi
`;

const KIT = `printf '%s %s HOUSE_KIT_HOME=%s%s%s\\n' "\${0##*/}" "$*" "$HOUSE_KIT_HOME" "\${HOUSE_KIT_REPLACES:+ HOUSE_KIT_REPLACES=$HOUSE_KIT_REPLACES}" "\${HOUSE_KIT_WORKSPACE:+ HOUSE_KIT_WORKSPACE=$HOUSE_KIT_WORKSPACE}" >> "$FAKE/log"
[ -z "\${HOUSE_KIT_RELAY-}" ] || printf 'relay %s\\n' "$HOUSE_KIT_RELAY" >> "$FAKE/log"
[ -z "\${NODE_USE_SYSTEM_CA-}" ] || printf 'ca %s\\n' "$NODE_USE_SYSTEM_CA" >> "$FAKE/log"
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
  const absent = platform.absent ?? [];
  for (const [tool, body] of Object.entries(TOOLS)) {
    if (absent.includes(tool)) continue;
    await script(join(bin, tool), platform.server === true && tool === 'sudo' ? `${LOGGED}exec "$@"\n` : body);
  }
  let path = `${bin}:/usr/bin:/bin`;
  if (absent.length > 0) {
    const present = join(fake, 'present');
    await mkdir(present);
    for (const entry of await readdir('/usr/bin')) if (!absent.includes(entry)) await symlink(join('/usr/bin', entry), join(present, entry));
    path = `${bin}:${present}`;
  }
  await script(join(fake, 'kit'), KIT);
  const system = platform.system === 'Darwin' ? 'darwin' : 'linux';
  const unpacked = `node-v24.22.1-${system}-${/arm64|aarch64/.test(platform.machine) ? 'arm64' : 'x64'}`;
  await mkdir(join(fake, unpacked, 'bin'), { recursive: true });
  await script(join(fake, unpacked, 'bin', 'node'), NODE);
  spawnSync('tar', ['-czf', join(fake, 'node.tar.gz'), '-C', fake, unpacked]);
  const packaged = join(fake, 'kit-tree');
  await mkdir(join(packaged, 'lib', 'node_modules', '@agentshouse', 'kit', 'dist'), { recursive: true });
  await mkdir(join(packaged, 'bin'));
  await script(join(packaged, 'bin', 'kit'), KIT);
  await script(join(packaged, 'bin', 'house'), KIT);
  spawnSync('tar', ['-czf', join(fake, 'kit.tar.gz'), '-C', packaged, 'lib', 'bin']);
  await writeFile(join(fake, 'ca-certificates.crt'), "-----BEGIN CERTIFICATE-----\nthe computer's own authority\n-----END CERTIFICATE-----\n");
  const bootstrap = await published();
  await writeFile(bootstrap, (await readFile(bootstrap, 'utf8')).replace('/etc/ssl/certs/ca-certificates.crt', join(fake, 'ca-certificates.crt')));
  if (platform.system === 'Linux') {
    const osRelease = join(fake, 'os-release');
    await writeFile(osRelease, platform.osRelease ?? UBUNTU_26_04);
    await writeFile(
      bootstrap,
      (await readFile(bootstrap, 'utf8')).replaceAll('/etc/os-release', osRelease).replace('[[ -d /run/systemd/system ]]', '[[ -e "$FAKE/systemd" ]]'),
    );
    if (platform.systemd ?? platform.server !== true) await writeFile(join(fake, 'systemd'), '');
  }
  if (platform.server === true) {
    const server = join(fake, 'server');
    await writeFile(
      bootstrap,
      (await readFile(bootstrap, 'utf8'))
        .replace('SERVER_PREFIX=/opt/house-kit', `SERVER_PREFIX=${server}/house-kit`)
        .replace('NATIVE_BIN=/usr/local/bin', `NATIVE_BIN=${server}/bin`)
        .replace('NATIVE_UNIT=/etc/systemd/system/house-kit.service', `NATIVE_UNIT=${server}/house-kit.service`)
        .replace('NATIVE_WORKSPACE=/agents/house', `NATIVE_WORKSPACE=${server}/workspace`),
    );
  }
  const environment = {
    HOME: home,
    SHELL: platform.shell === 'zsh' ? join(bin, 'zsh') : (platform.shell ?? '/bin/bash'),
    PATH: path,
    FAKE: fake,
    FAKE_SYSTEM: platform.system,
    FAKE_MACHINE: platform.machine,
    FAKE_ARM64: platform.appleSilicon === false ? '0' : '1',
    FAKE_MACOS: platform.macos ?? '27.0.1',
    FAKE_GLIBC: platform.glibc === false ? '0' : '1',
    ...platform.environment,
  };
  const ran = (command: string, argv: string[], added: Record<string, string> = {}): Ran => {
    const finished = spawnSync(command, argv, { encoding: 'utf8', env: { ...environment, ...added } });
    return { status: finished.status, stdout: finished.stdout, stderr: finished.stderr };
  };
  return {
    home,
    prefixes: {
      desktop: join(home, '.local', 'share', 'house-kit'),
      server: join(fake, 'server', 'house-kit'),
      container: join(platform.environment?.HOUSE_KIT_HOME ?? join(home, '.house-kit'), 'kit'),
    },
    run: (argv = [], added = {}) => ran('bash', [bootstrap, ...argv], added),
    terminal: (argv, typed, added = {}) => {
      const line = ['bash', bootstrap, ...argv].map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ');
      const finished = spawnSync('script', ['-qec', line, '/dev/null'], { encoding: 'utf8', env: { ...environment, ...added }, input: typed });
      return { status: finished.status, stdout: finished.stdout.replaceAll('\r\n', '\n'), stderr: finished.stderr };
    },
    command: (name, argv) => ran(join(home, '.local', 'bin', name), argv),
    shell: (line) => ran('sh', ['-c', line]),
    calls: (tool) =>
      readFileSync(join(fake, 'log'), { encoding: 'utf8', flag: 'a+' })
        .split('\n')
        .filter((line) => line.startsWith(`${tool} `))
        .map((line) => line.slice(tool.length + 1)),
    mark: (name) => writeFile(join(fake, name), ''),
    clear: (name) => rm(join(fake, name), { force: true }),
    forget: () => writeFile(join(fake, 'log'), ''),
    outdate: () =>
      writeFile(join(platform.server === true ? join(fake, 'server', 'house-kit') : join(home, '.local', 'share', 'house-kit'), 'current'), `${OUTDATED_VERSION}\n`),
    publish: async (version) => writeFile(bootstrap, (await readFile(bootstrap, 'utf8')).replace(/^VERSION='[^']*'$/m, `VERSION='${version}'`)),
    uninstall: (tool) => rm(join(bin, tool)),
    serverUnit: () => readFile(join(fake, 'server', 'house-kit.service'), 'utf8'),
    restartPolicy: async (policy) =>
      writeFile(join(fake, 'container'), (await readFile(join(fake, 'container'), 'utf8')).replace(/^policy=.*$/m, `policy=${policy}`)),
  };
}

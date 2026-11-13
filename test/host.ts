import { spawn } from '@lydell/node-pty';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIS, adapterArchive } from '../src/clis.ts';
import { temporaryDirectory } from './kit.ts';

const LINUX = fileURLToPath(new URL('../bin/connect-linux.sh', import.meta.url));

export const PUBLISHED_VERSION = '0.2.1-alpha.1';
export const ADAPTER_ARCHIVES = Object.keys(CLIS)
  .filter((kind) => CLIS[kind]!.adapter !== null)
  .map((kind) => adapterArchive(kind));

export async function published(): Promise<string> {
  const script = join(await temporaryDirectory(), 'connect-linux.sh');
  await writeFile(
    script,
    (await readFile(LINUX, 'utf8'))
      .replace('__KIT_RELEASE__', PUBLISHED_VERSION)
      .replace('__KIT_SHA256__', 'b'.repeat(64))
      .replace('__ADAPTERS__', ADAPTER_ARCHIVES.map((name) => `${name}=${'c'.repeat(64)}`).join(' ')),
  );
  return script;
}

export const UBUNTU_26_04 = "ID=ubuntu\nVERSION_ID=26.04\nVERSION_CODENAME=resolute\nUBUNTU_CODENAME=resolute\nPRETTY_NAME='Ubuntu 26.04 LTS'\n";

export interface Platform {
  system: 'Linux' | 'Darwin';
  machine: string;
  appleSilicon?: boolean;
  macos?: string;
  osRelease?: string;
  glibc?: string | false;
  absent?: string[];
  shell?: string;
  environment?: Record<string, string>;
}

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Asked {
  status: number;
  shown: string;
}

export interface Host {
  home: string;
  kitHome: string;
  run(argv?: string[], added?: Record<string, string>): Ran;
  ask(argv: string[], added: Record<string, string>, answer: string): Promise<Asked>;
  shell(line: string): Ran;
  calls(tool: string): string[];
  forget(): Promise<void>;
  publish(version: string): Promise<void>;
}

const LOGGED = 'printf \'%s %s\\n\' "${0##*/}" "$*" >> "$FAKE/log"\n';

const TOOLS: Record<string, string> = {
  uname: 'case "$1" in -s) echo "$FAKE_SYSTEM" ;; -m) echo "$FAKE_MACHINE" ;; *) exec /bin/uname "$@" ;; esac\n',
  sysctl: 'echo "$FAKE_ARM64"\n',
  sw_vers: 'echo "$FAKE_MACOS"\n',
  curl: `${LOGGED}while [ $# -gt 1 ]; do [ "$1" != -o ] || out=$2; shift; done\ncase "$1" in */kit-installer/node-v*) cp "$FAKE/node.tar.gz" "$out" ;; */kit-installer/kit-*) cp "$FAKE/kit.tar.gz" "$out" ;; */kit-installer/*-acp-[0-9]*) cp "$FAKE/adapter.tar.gz" "$out" ;; esac\n`,
  sha256sum: `${LOGGED}cat >/dev/null\n`,
  shasum: `${LOGGED}cat >/dev/null\n`,
  sudo: `${LOGGED}exec "$@"\n`,
  'apt-get': LOGGED,
  getconf: '[ "$1" = GNU_LIBC_VERSION ] || exec /usr/bin/getconf "$@"\n[ -n "$FAKE_GLIBC" ] && echo "glibc $FAKE_GLIBC"\n',
  zsh: '[ ! -f "${ZDOTDIR:-$HOME}/.zshenv" ] || . "${ZDOTDIR:-$HOME}/.zshenv"\n[ "$1" != -c ] || eval "$2"\n',
};

const NODE = `printf 'node %s\\n' "\${1##*/}" >> "$FAKE/log"\n`;

const KIT = `printf '%s %s\\n' "\${0##*/}" "$*" >> "$FAKE/log"
printf 'release %s\\n' "\${0%/bin/*}" >> "$FAKE/log"
printf 'prefix %s\\n' "$HOUSE_KIT_PREFIX" >> "$FAKE/log"
[ -z "\${HOUSE_KIT_RELAY-}" ] || printf 'relay %s\\n' "$HOUSE_KIT_RELAY" >> "$FAKE/log"
[ -z "\${HOUSE_KIT_INSTALL_COMMAND-}" ] || printf 'install %s\\n' "$HOUSE_KIT_INSTALL_COMMAND" >> "$FAKE/log"
[ -z "\${NODE_USE_SYSTEM_CA-}" ] || printf 'ca %s\\n' "$NODE_USE_SYSTEM_CA" >> "$FAKE/log"
`;

async function script(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
}

export async function fakeHost(platform: Platform): Promise<Host> {
  const home = await temporaryDirectory();
  const fake = await temporaryDirectory();
  const bin = join(fake, 'bin');
  await mkdir(bin);
  const absent = platform.absent ?? [];
  for (const [tool, body] of Object.entries(TOOLS)) {
    if (!absent.includes(tool)) await script(join(bin, tool), body);
  }
  let path = `${bin}:/usr/bin:/bin`;
  if (absent.length > 0) {
    const present = join(fake, 'present');
    await mkdir(present);
    for (const entry of await readdir('/usr/bin')) if (!absent.includes(entry)) await symlink(join('/usr/bin', entry), join(present, entry));
    path = `${bin}:${present}`;
  }
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
  const adapter = join(fake, 'adapter-tree');
  await mkdir(join(adapter, 'node_modules', '.bin'), { recursive: true });
  await script(join(adapter, 'node_modules', '.bin', 'adapter'), 'exit 0\n');
  spawnSync('tar', ['-czf', join(fake, 'adapter.tar.gz'), '-C', adapter, 'node_modules']);
  await writeFile(join(fake, 'ca-certificates.crt'), "-----BEGIN CERTIFICATE-----\nthe computer's own authority\n-----END CERTIFICATE-----\n");
  const bootstrap = await published();
  let text = (await readFile(bootstrap, 'utf8')).replace('/etc/ssl/certs/ca-certificates.crt', join(fake, 'ca-certificates.crt'));
  if (platform.system === 'Linux') {
    const osRelease = join(fake, 'os-release');
    await writeFile(osRelease, platform.osRelease ?? UBUNTU_26_04);
    text = text.replaceAll('/etc/os-release', osRelease);
  }
  await writeFile(bootstrap, text);
  const environment = {
    HOME: home,
    SHELL: platform.shell === 'zsh' ? join(bin, 'zsh') : (platform.shell ?? '/bin/bash'),
    PATH: path,
    FAKE: fake,
    FAKE_SYSTEM: platform.system,
    FAKE_MACHINE: platform.machine,
    FAKE_ARM64: platform.appleSilicon === false ? '0' : '1',
    FAKE_MACOS: platform.macos ?? '27.0.1',
    FAKE_GLIBC: platform.glibc === false ? '' : (platform.glibc ?? '2.41'),
    ...platform.environment,
  };
  const ran = (command: string, argv: string[], added: Record<string, string> = {}): Ran => {
    const finished = spawnSync(command, argv, { encoding: 'utf8', env: { ...environment, ...added } });
    return { status: finished.status, stdout: finished.stdout, stderr: finished.stderr };
  };
  return {
    home,
    kitHome: join(home, '.agents', 'house'),
    run: (argv = [], added = {}) => ran('bash', [bootstrap, ...argv], added),
    ask: (argv, added, answer) =>
      new Promise((resolve) => {
        const terminal = spawn('bash', [bootstrap, ...argv], { cols: 200, rows: 24, env: { ...environment, ...added } });
        let shown = '';
        let answered = false;
        terminal.onData((data) => {
          shown += data;
          if (answered || !shown.includes('[y/N] ')) return;
          answered = true;
          terminal.write(`${answer}\r`);
        });
        terminal.onExit(({ exitCode }) => resolve({ status: exitCode, shown: shown.replaceAll('\r\n', '\n') }));
      }),
    shell: (line) => ran('sh', ['-c', line]),
    calls: (tool) =>
      readFileSync(join(fake, 'log'), { encoding: 'utf8', flag: 'a+' })
        .split('\n')
        .filter((line) => line.startsWith(`${tool} `))
        .map((line) => line.slice(tool.length + 1)),
    forget: () => writeFile(join(fake, 'log'), ''),
    publish: async (version) => writeFile(bootstrap, (await readFile(bootstrap, 'utf8')).replace(/^VERSION='[^']*'$/m, `VERSION='${version}'`)),
  };
}

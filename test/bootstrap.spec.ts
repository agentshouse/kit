import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { placeUserCli } from './cli.ts';
import { startHouse } from './double.ts';
import { LOGIN_SHELL, placeUserClis, userBin } from './environment.ts';
import { fakeHost, published } from './host.ts';
import { readOnlyHome, runKit, temporaryHome } from './kit.ts';

const LINUX = fileURLToPath(new URL('../bin/connect-linux.sh', import.meta.url));
const WINDOWS = fileURLToPath(new URL('../bin/connect-windows.ps1', import.meta.url));
const CLIS_MAIN = fileURLToPath(new URL('../src/clis-main.ts', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../scripts/bootstrap-manifest.mjs', import.meta.url));

function bootstrap(script: string, argv: string[]) {
  const ran = spawnSync('bash', [script, ...argv], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent' } });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

it('leaves the release exactly one image digest and one Kit release to fill', async () => {
  const linux = await readFile(LINUX, 'utf8');
  const windows = await readFile(WINDOWS, 'utf8');

  expect(spawnSync('bash', ['-n', LINUX]).status).toBe(0);
  expect(linux.split('__IMAGE_DIGEST__')).toHaveLength(2);
  expect(linux.split('__KIT_RELEASE__')).toHaveLength(2);
  expect(windows.split('__IMAGE_DIGEST__')).toHaveLength(2);
  expect(windows).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
});

it('installs natively the Node.js release the package runs on', async () => {
  const { engines } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    engines: { node: string };
  };

  expect(await readFile(LINUX, 'utf8')).toContain(`\nNODE_VERSION=${engines.node}\n`);
});

it('refuses to run before the release fills it', () => {
  expect(bootstrap(LINUX, [])).toMatchObject({
    status: 1,
    stderr: 'kit_bootstrap_refused: this bootstrap has not been published with an immutable release\n',
  });
});

it('enrolls with a credential only on a server', async () => {
  expect(bootstrap(await published(), ['--enroll', 'environment-one'])).toMatchObject({
    status: 1,
    stderr: 'kit_bootstrap_refused: --enroll enrolls a server; add --linux\n',
  });
});

it('takes --no-skills as a bootstrap option', async () => {
  expect(bootstrap(await published(), ['--no-skills', '--enroll', 'environment-one'])).toMatchObject({
    status: 1,
    stderr: 'kit_bootstrap_refused: --enroll enrolls a server; add --linux\n',
  });
});

it('takes --update-clis as a bootstrap option', async () => {
  expect(bootstrap(await published(), ['--update-clis', '--enroll', 'environment-one'])).toMatchObject({
    status: 1,
    stderr: 'kit_bootstrap_refused: --enroll enrolls a server; add --linux\n',
  });
});

it('leaves a native host its own kit and house rather than forwarding to them', async () => {
  expect(bootstrap(await published(), ['--linux', 'house', 'push', '--owner'])).toMatchObject({
    status: 1,
    stderr: "kit_bootstrap_refused: --linux puts kit and house on this host's PATH; run house there directly\n",
  });
});

it('keeps the installed Kit in place when its replacement cannot be placed beside it', async () => {
  const home = await temporaryHome();
  const linux = await readFile(LINUX, 'utf8');
  const placement = /^place_native_kit\(\) \{\n[\s\S]*?\n\}\n/m.exec(linux)![0];
  const ran = spawnSync(
    'bash',
    [
      '-c',
      `set -u
elevated() { "$@"; }
refuse() { printf 'refused: %s\\n' "$1" >&2; exit 1; }
NATIVE_PREFIX="$0/opt/house-kit"
NATIVE_STAGE="$0/stage"
NATIVE_BIN="$0/bin"
PLACING=(elevated)
PLACING_OWNER=root:root
PLACING_NOTE=''
mkdir -p "$NATIVE_PREFIX" "$NATIVE_BIN" "$NATIVE_STAGE"
printf old > "$NATIVE_PREFIX/release"
${placement}
place_native_kit`,
      home,
    ],
    { encoding: 'utf8' },
  );

  expect(ran.status).toBe(1);
  expect(ran.stderr).toContain(`refused: Kit could not be installed in ${home}/opt/house-kit`);
  expect(await readFile(join(home, 'opt', 'house-kit', 'release'), 'utf8')).toBe('old');
});

it('downloads its packages, Node.js and the Kit without the proxy variables a Sandbox sets for House traffic', async () => {
  const home = await temporaryHome();
  const linux = await readFile(LINUX, 'utf8');
  const steps = ['establish_native_packages', 'stage_native_kit'].map(
    (step) => new RegExp(`^${step}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(linux)![0],
  );
  const bin = join(home, 'bin');
  await mkdir(bin);
  for (const tool of ['apt-get', 'curl', 'npm', 'sha256sum', 'tar']) {
    const logged = ['sha256sum', 'tar'].includes(tool)
      ? ''
      : `printf '%s %s\\n' ${tool} "\${HTTP_PROXY-}\${HTTPS_PROXY-}\${http_proxy-}\${https_proxy-}" >> "$LOG"\n`;
    await writeFile(join(bin, tool), `#!/bin/sh\n${logged}`);
    await chmod(join(bin, tool), 0o755);
  }
  const ran = spawnSync(
    'bash',
    [
      '-c',
      `set -u
elevated() { "$@"; }
refuse() { printf 'refused: %s\\n' "$1" >&2; exit 1; }
installed_packages() { :; }
${/^DIRECT=.*$/m.exec(linux)![0]}
NATIVE_PACKAGES=(ca-certificates curl git)
VERSION=0.2.1-alpha.1
NODE_VERSION=24.22.1
NODE_PLATFORM=linux-x64
NODE_SHA256=${'0'.repeat(64)}
CHECKSUM=(sha256sum)
RELEASE=release
${steps.join('')}
establish_native_packages
stage_native_kit`,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        LOG: join(home, 'downloads.log'),
        TMPDIR: home,
        HTTP_PROXY: 'http://forwarder:3128',
        HTTPS_PROXY: 'http://forwarder:3128',
        http_proxy: 'http://forwarder:3128',
        https_proxy: 'http://forwarder:3128',
      },
    },
  );

  expect(ran.stderr).toBe('');
  expect((await readFile(join(home, 'downloads.log'), 'utf8')).split('\n').filter(Boolean).sort()).toEqual(
    ['apt-get ', 'apt-get ', 'curl ', 'npm '],
  );
});

async function steps(...names: string[]): Promise<string> {
  const linux = await readFile(LINUX, 'utf8');
  return names.map((name) => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(linux)![0]).join('');
}

it('passes a login code and the Kit relay through the native server bootstrap entry', async () => {
  const relay = 'https://kit-relay.example';
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server: true, environment: { HOUSE_KIT_RELAY: relay } });

  const ran = host.run(['--linux', '--house', 'https://agents.house', '--code', 'ahk_code_one']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(host.calls('kit')).toEqual([expect.stringMatching(/^login --house https:\/\/agents\.house --code ahk_code_one /)]);
  expect(host.calls('relay')).toEqual([relay]);
});

it('installs a server whose home is read-only with its Kit home under the temporary directory, the one a later kit finds', async () => {
  const temporary = await temporaryHome();
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server: true, environment: { TMPDIR: `${temporary}/` } });
  await readOnlyHome(host.home);
  const kitHome = join(temporary, `house-kit-${process.getuid!()}`);

  expect(host.run(['--linux'])).toMatchObject({ status: 0, stderr: '' });

  expect(host.calls('kit')).toEqual([`login HOUSE_KIT_HOME=${kitHome}`]);
  expect((await stat(kitHome)).mode & 0o777).toBe(0o700);
  expect(JSON.parse(await readFile(join(kitHome, 'credential.json'), 'utf8'))).toMatchObject({ environment: 'environment-one' });
  const house = await startHouse();
  const kit = runKit(['login', '--house', house.origin, '--code', 'ahk_code_one'], { HOME: host.home, TMPDIR: `${temporary}/` });
  expect(await kit.exited).toBe(1);
  expect(kit.stderr()).toBe('kit: --code connects a new machine; this Kit home records Environment environment-one, so run kit login to reconnect it\n');
});

it('installs a server with its Kit home where HOUSE_KIT_HOME names, and its service reads it there', async () => {
  const kitHome = join(await temporaryHome(), 'kit-home');
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server: true, environment: { HOUSE_KIT_HOME: kitHome } });
  await host.mark('systemd');

  expect(host.run(['--linux'])).toMatchObject({ status: 0, stderr: '' });

  expect(host.calls('kit')).toEqual([`login HOUSE_KIT_HOME=${kitHome}`]);
  expect(JSON.parse(await readFile(join(kitHome, 'credential.json'), 'utf8'))).toMatchObject({ environment: 'environment-one' });
  await expect(access(join(host.home, '.house-kit'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await host.serverUnit()).split('\n')).toContain(`Environment="HOUSE_KIT_HOME=${kitHome}"`);
});

const LISTED = [
  ['codex', '/home/u/.local/bin/codex', '0.150.0', '0.159.1', 'old'],
  ['claude', '/home/u/.local/bin/claude', '2.1.200', '2.1.286', 'old'],
  ['grok', '/home/u/.grok/bin/grok', '1.0.50', '1.0.46', 'current'],
];

async function updatingClis(flag: 0 | 1, terminal: boolean, answers = '') {
  const home = await temporaryHome();
  const log = join(home, 'updates.log');
  const script = `set -u
UPDATE_CLIS=${flag}
KIT_HOME=${home}
${await steps('terminal', 'update_clis')}
listing() { printf '%s\\n' ${LISTED.map((line) => `'${line.join('\t')}'`).join(' ')}; }
updating() { printf '%s\\n' "$1" >> ${log}; [ "$1" != /home/u/.grok/bin/grok ]; }
update_clis listing updating
`;
  await writeFile(join(home, 'run.sh'), script);
  await writeFile(join(home, 'answers'), answers);
  const command = terminal ? ['script', ['-qec', `bash ${join(home, 'run.sh')}`, '/dev/null']] as const : ['bash', [join(home, 'run.sh')]] as const;
  const typed = openSync(join(home, 'answers'), 'r');
  const child = spawn(command[0], [...command[1]], { stdio: [typed, 'pipe', 'pipe'] });
  closeSync(typed);
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  await new Promise((resolve) => child.on('close', resolve));
  const updated = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { output: output.replaceAll('\r', ''), updated, restartAsked: existsSync(join(home, 'restart')) };
}

it('asks once for each CLI below its minimum, updates one on Enter, leaves one it is refused and asks nothing about a current one', async () => {
  const { output, updated } = await updatingClis(0, true, '\nn\n');

  expect(output.match(/Update it\? \[Y\/n\]/g)).toHaveLength(2);
  expect(output).toContain('codex 0.150.0 is older than 0.159.1, the oldest this Kit runs. Update it? [Y/n]');
  expect(output).toContain('claude 2.1.200 is older than 2.1.286, the oldest this Kit runs. Update it? [Y/n]');
  expect(output).not.toContain('grok 1.0.50 is older');
  expect(updated).toEqual(['/home/u/.local/bin/codex']);
});

it('updates every chosen CLI without asking when --update-clis is given, names one whose update failed, and asks the Kit to restart once idle', async () => {
  const { output, updated, restartAsked } = await updatingClis(1, false);

  expect(updated).toEqual(LISTED.map((line) => line[1]));
  expect(output).not.toContain('Update it?');
  expect(output).toContain('grok could not be updated; it stays at 1.0.50.');
  expect(restartAsked).toBe(true);
});

it('updates nothing, asks nothing and asks the Kit for no restart without a terminal and without --update-clis', async () => {
  const { output, updated, restartAsked } = await updatingClis(0, false, '\n\n');

  expect(updated).toEqual([]);
  expect(output).toBe('');
  expect(restartAsked).toBe(false);
});

it("runs a CLI's own update command in place natively without the proxy variables, and in a container of the installed image", async () => {
  const home = await temporaryHome();
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf \'docker %s\\n\' "$*"\n');
  await writeFile(join(bin, 'codex'), '#!/bin/sh\nprintf \'codex %s %s\\n\' "$*" "${HTTPS_PROXY-}${https_proxy-}"\n');
  for (const tool of ['docker', 'codex']) await chmod(join(bin, tool), 0o755);
  const linux = await readFile(LINUX, 'utf8');
  const ran = spawnSync(
    'bash',
    [
      '-c',
      `set -u
${/^DIRECT=.*$/m.exec(linux)![0]}
${/^IMAGE_PACKAGE=.*$/m.exec(linux)![0]}
DOCKER_RUN=(docker run --rm --user 1:1 --mount kit-home --mount workspace image)
${await steps('native_cli_update', 'container_clis', 'container_cli_update')}
native_cli_update ${bin}/codex
container_clis
container_cli_update /kit-home/.local/bin/codex </dev/null`,
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HTTPS_PROXY: 'http://forwarder:3128' } },
  );

  expect(ran.stderr).toBe('');
  expect(ran.stdout.split('\n').filter(Boolean)).toEqual([
    'codex update ',
    'docker run --entrypoint node --rm --user 1:1 --mount kit-home --mount workspace image /usr/local/lib/node_modules/@agentshouse/kit/dist/clis-main.js',
    'docker run -i --entrypoint /kit-home/.local/bin/codex --rm --user 1:1 --mount kit-home --mount workspace image update',
  ]);
});

it('leaves a running container Kit process and its conversations running after it updated a CLI, and asks it to restart once idle', async () => {
  const home = await temporaryHome();
  const ran = spawnSync(
    'bash',
    [
      '-c',
      `set -u
NAME=house-kit
CONFIGURED=''
UPDATE_CLIS=1
KIT_HOME=${home}
kit_running() { true; }
enrolled() { printf environment-one; }
docker() { printf 'docker %s\\n' "$*" >&2; }
listing() { printf 'codex\\t/kit-home/.local/bin/codex\\t0.150.0\\t0.159.1\\told\\n'; }
updating() { printf 'updated %s\\n' "$1" >&2; }
${await steps('terminal', 'update_clis', 'resume_kit')}
update_clis listing updating
resume_kit`,
    ],
    { encoding: 'utf8', cwd: home },
  );

  expect(ran.stderr).toBe('updated /kit-home/.local/bin/codex\n');
  expect(ran.stdout).toBe('Updating codex 0.150.0.\nKit is already installed.\n');
  await expect(access(join(home, 'restart'))).resolves.toBeUndefined();
});

it.each([
  ['holding its credential', false],
  ['whose rejected credential it forgot', true],
])('asks the server Kit process %s to restart once idle when a rerun updates a CLI, and restarts no service itself', async (_name, rejected) => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server: true });
  await host.mark('systemd');
  expect(host.run(['--linux'])).toMatchObject({ status: 0, stderr: '' });
  if (rejected) await rm(join(host.home, '.house-kit', 'credential.json'));
  const codex = join(host.home, 'codex');
  await writeFile(codex, '#!/bin/sh\nprintf \'codex %s\\n\' "$*" >> "$FAKE/log"\n', { mode: 0o755 });
  await writeFile(join(host.home, '.clis'), `codex\t${codex}\t0.160.0\t0.159.1\tcurrent\n`);
  await host.forget();

  const ran = host.run(['--linux', '--update-clis']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(host.calls('kit')).toHaveLength(rejected ? 1 : 0);
  expect(host.calls('codex')).toEqual(['update']);
  expect(host.calls('systemctl')).not.toContain('restart house-kit.service');
  await expect(access(join(host.home, '.house-kit', 'restart'))).resolves.toBeUndefined();
});

function listClis(home: string, cwd: string): Promise<{ status: number | null; listed: string[][] }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIS_MAIN], { cwd, env: { ...process.env, HOME: home, HOUSE_KIT_HOME: home, ...LOGIN_SHELL } });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('close', (status) =>
      resolve({
        status,
        listed: stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('\t'))
          .map(([name, path, ...rest]) => [name!, realpathSync(path!), ...rest]),
      }),
    );
  });
}

async function desiredGrok(home: string): Promise<void> {
  const house = await startHouse();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }));
  house.route('POST', '/kit/agents/desired', () => ({ body: { agents: ['grok-build'], routes: [] } }));
}

it('finds the CLI the login shell runs through a relative entry from a linked directory, with no env on its PATH', async () => {
  const home = await temporaryHome();
  await desiredGrok(home);
  await mkdir(join(home, 'physical', 'work'), { recursive: true });
  await symlink(join(home, 'physical', 'work'), join(home, 'link'));
  placeUserCli(join(home, 'bin'), 'grok-build', '1.0.49');
  placeUserCli(join(home, 'physical', 'bin'), 'grok-build', '1.0.50');
  await writeFile(join(home, '.profile'), 'cd "$HOME/link"\nPATH="../bin"\n');

  expect(await listClis(home, home)).toEqual({
    status: 0,
    listed: [['grok', join(home, 'physical', 'bin', 'grok'), '1.0.50', '1.0.46', 'current']],
  });
});

it("finds a CLI through an empty PATH entry in the directory the login shell ends its profile in, as that shell does", async () => {
  const home = await temporaryHome();
  await desiredGrok(home);
  await writeFile(join(home, '.profile'), 'cd "$HOME/there"\nPATH=":$PATH"\n');
  const here = join(home, 'here');
  const there = join(home, 'there');
  placeUserCli(here, 'grok-build', '1.0.49');
  placeUserCli(there, 'grok-build', '1.0.50');

  expect(await listClis(home, here)).toEqual({ status: 0, listed: [['grok', join(there, 'grok'), '1.0.50', '1.0.46', 'current']] });
});

it('names each chosen CLI the login shell finds, even through a relative PATH entry, with its absolute path, its release, its minimum and whether it is below that minimum', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }));
  house.route('POST', '/kit/agents/desired', () => ({ body: { agents: ['codex-acp', 'claude-agent-acp', 'grok-build'], routes: [] } }));
  await placeUserClis(home);
  placeUserCli(userBin(home), 'codex-acp', '0.150.0');
  await rm(join(userBin(home), 'claude'));
  await writeFile(join(home, '.profile'), `PATH="${relative(process.cwd(), userBin(home))}:$PATH"\n`);

  const listed = await listClis(home, process.cwd());

  expect(listed).toEqual({
    status: 0,
    listed: [
      ['codex', join(userBin(home), 'codex'), '0.150.0', '0.159.1', 'old'],
      ['grok', join(userBin(home), 'grok'), '1.0.47', '1.0.46', 'current'],
    ],
  });
  expect(house.requests.map((request) => [request.path, request.headers.authorization])).toEqual([
    ['/kit/agents/desired', 'Bearer ahk_held'],
  ]);
});

it('lists macOS with the Linux script beside Linux and Windows', async () => {
  const root = await temporaryHome();
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.2.1-alpha.1' }));
  await writeFile(join(root, 'scripts', 'bootstrap-manifest.mjs'), await readFile(MANIFEST, 'utf8'));

  expect(spawnSync(process.execPath, [join(root, 'scripts', 'bootstrap-manifest.mjs')]).status).toBe(0);

  const release = 'https://github.com/agentshouse/kit/releases/download/v0.2.1-alpha.1';
  expect(JSON.parse(await readFile(join(root, 'dist', 'bootstrap.json'), 'utf8'))).toEqual({
    schemaVersion: 2,
    version: '0.2.1-alpha.1',
    hosts: {
      macos: { asset: { name: 'connect-linux.sh', url: `${release}/connect-linux.sh` } },
      linux: { asset: { name: 'connect-linux.sh', url: `${release}/connect-linux.sh` } },
      windows: { asset: { name: 'connect-windows.ps1', url: `${release}/connect-windows.ps1` } },
    },
  });
});

it.each([
  ['the workspace root', '', '/agents/house'],
  ['a directory beneath the workspace', '/notes/2026', '/agents/house/notes/2026'],
  ['a directory outside the workspace', '/../elsewhere', '/agents/house'],
  ['a sibling whose name starts like the workspace', '/../AgentsHouse2', '/agents/house'],
])("runs the host's house from %s at its place in the container", async (_name, below, expected) => {
  const home = await temporaryHome();
  const workspace = join(home, 'AgentsHouse');
  const here = join(workspace, below);
  await mkdir(here, { recursive: true });
  const ran = spawnSync('bash', ['-c', `set -u\nWORKSPACE="$0"\n${await steps('house_workdir')}house_workdir`, workspace], {
    encoding: 'utf8',
    cwd: here,
  });

  expect(ran).toMatchObject({ status: 0, stdout: expected, stderr: '' });
});

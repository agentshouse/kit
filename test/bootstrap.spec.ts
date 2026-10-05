import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { placeUserCli } from './cli.ts';
import { startHouse } from './double.ts';
import { LOGIN_SHELL, placeUserClis, userBin } from './environment.ts';
import { temporaryHome } from './kit.ts';

const LINUX = fileURLToPath(new URL('../bin/connect-linux.sh', import.meta.url));
const WINDOWS = fileURLToPath(new URL('../bin/connect-windows.ps1', import.meta.url));
const CLIS_MAIN = fileURLToPath(new URL('../src/clis-main.ts', import.meta.url));

async function published(): Promise<string> {
  const home = await temporaryHome();
  const script = join(home, 'connect-linux.sh');
  await writeFile(
    script,
    (await readFile(LINUX, 'utf8')).replace('__IMAGE_DIGEST__', 'a'.repeat(64)).replace('__KIT_VERSION__', '0.2.1-alpha.1'),
  );
  return script;
}

function bootstrap(script: string, argv: string[]) {
  const ran = spawnSync('bash', [script, ...argv], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent' } });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

it('leaves the release exactly one image digest and one Kit version to fill', async () => {
  const linux = await readFile(LINUX, 'utf8');
  const windows = await readFile(WINDOWS, 'utf8');

  expect(spawnSync('bash', ['-n', LINUX]).status).toBe(0);
  expect(linux.split('__IMAGE_DIGEST__')).toHaveLength(2);
  expect(linux.split('__KIT_VERSION__')).toHaveLength(2);
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

it('refuses a native install on any host but the one selected Linux platform before changing it', async () => {
  const refused = bootstrap(await published(), ['--linux', '--house', 'https://agents.house', '--enroll', 'environment-one']);

  expect(refused.status).toBe(1);
  expect(refused.stdout).toBe('');
  expect(refused.stderr).toMatch(/^kit_bootstrap_refused: --linux runs only on Ubuntu 26\.04 LTS on amd64, not Debian GNU\/Linux 12 \(bookworm\) on (amd64|arm64)\n$/);
});

it('leaves a native host its own kit and house rather than forwarding to them', async () => {
  expect(bootstrap(await published(), ['--linux', 'house', 'git', 'push', '--owner'])).toMatchObject({
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
mkdir -p "$NATIVE_PREFIX" "$NATIVE_BIN" "$NATIVE_STAGE"
printf old > "$NATIVE_PREFIX/release"
${placement}
place_native_kit`,
      home,
    ],
    { encoding: 'utf8' },
  );

  expect(ran.status).toBe(1);
  expect(ran.stderr).toContain(`refused: House Kit could not be installed in ${home}/opt/house-kit`);
  expect(await readFile(join(home, 'opt', 'house-kit', 'release'), 'utf8')).toBe('old');
});

it('downloads its packages, Node.js and the Kit without the proxy variables a Flex sandbox sets for House traffic', async () => {
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
NODE_VERSION=24.21.0
NODE_SHA256=${'0'.repeat(64)}
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
${await steps('update_clis')}
listing() { printf '%s\\n' ${LISTED.map((line) => `'${line.join('\t')}'`).join(' ')}; }
updating() { printf '%s\\n' "$1" >> ${log}; [ "$1" != /home/u/.grok/bin/grok ]; }
update_clis listing updating
`;
  await writeFile(join(home, 'run.sh'), script);
  const command = terminal ? ['script', ['-qec', `bash ${join(home, 'run.sh')}`, '/dev/null']] as const : ['bash', [join(home, 'run.sh')]] as const;
  const child = spawn(command[0], [...command[1]], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stdin.end(answers);
  await new Promise((resolve) => child.on('close', resolve));
  const updated = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { output: output.replaceAll('\r', ''), updated };
}

it('asks once for each CLI below its minimum, updates one on Enter, leaves one it is refused and asks nothing about a current one', async () => {
  const { output, updated } = await updatingClis(0, true, '\nn\n');

  expect(output.match(/Update it\? \[Y\/n\]/g)).toHaveLength(2);
  expect(output).toContain('codex 0.150.0 is older than 0.159.1, the oldest this House Kit runs. Update it? [Y/n]');
  expect(output).toContain('claude 2.1.200 is older than 2.1.286, the oldest this House Kit runs. Update it? [Y/n]');
  expect(output).not.toContain('grok 1.0.50 is older');
  expect(updated).toEqual(['/home/u/.local/bin/codex']);
});

it('updates every chosen CLI without asking when --update-clis is given, and names one whose update failed', async () => {
  const { output, updated } = await updatingClis(1, false);

  expect(updated).toEqual(LISTED.map((line) => line[1]));
  expect(output).not.toContain('Update it?');
  expect(output).toContain('grok could not be updated; it stays at 1.0.50.');
});

it('updates nothing and asks nothing without a terminal and without --update-clis', async () => {
  const { output, updated } = await updatingClis(0, false, '\n\n');

  expect(updated).toEqual([]);
  expect(output).toBe('');
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

it('leaves a running container Kit and its conversations running after it updated a CLI', async () => {
  const home = await temporaryHome();
  const ran = spawnSync(
    'bash',
    [
      '-c',
      `set -u
NAME=house-kit
CONFIGURED=''
UPDATE_CLIS=1
kit_running() { true; }
enrolled() { printf environment-one; }
docker() { printf 'docker %s\\n' "$*" >&2; }
listing() { printf 'codex\\t/kit-home/.local/bin/codex\\t0.150.0\\t0.159.1\\told\\n'; }
updating() { printf 'updated %s\\n' "$1" >&2; }
${await steps('update_clis', 'resume_kit')}
update_clis listing updating
resume_kit`,
    ],
    { encoding: 'utf8', cwd: home },
  );

  expect(ran.stderr).toBe('updated /kit-home/.local/bin/codex\n');
  expect(ran.stdout).toBe('Updating codex 0.150.0.\nHouse Kit is already running for Environment environment-one.\n');
});

function listClis(home: string, cwd: string): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIS_MAIN], { cwd, env: { ...process.env, HOME: home, HOUSE_KIT_HOME: home, ...LOGIN_SHELL } });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stdout }));
  });
}

it('finds a CLI in the current directory through an empty PATH entry, as the login shell does', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }));
  house.route('POST', '/kit/agents/desired', () => ({ body: { agents: ['grok-build'], routes: [] } }));
  await writeFile(join(home, '.profile'), 'PATH=":$PATH"\n');
  const here = join(home, 'here');
  placeUserCli(here, 'grok-build', '1.0.49');

  expect(await listClis(home, here)).toEqual({ status: 0, stdout: `grok\t${join(here, 'grok')}\t1.0.49\t1.0.46\tcurrent\n` });
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
    stdout: [
      `codex\t${join(userBin(home), 'codex')}\t0.150.0\t0.159.1\told\n`,
      `grok\t${join(userBin(home), 'grok')}\t1.0.47\t1.0.46\tcurrent\n`,
    ].join(''),
  });
  expect(house.requests.map((request) => [request.path, request.headers.authorization])).toEqual([
    ['/kit/agents/desired', 'Bearer ahk_held'],
  ]);
});

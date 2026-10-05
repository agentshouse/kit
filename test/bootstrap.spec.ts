import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { published } from './host.ts';
import { temporaryHome } from './kit.ts';

const LINUX = fileURLToPath(new URL('../bin/connect-linux.sh', import.meta.url));
const WINDOWS = fileURLToPath(new URL('../bin/connect-windows.ps1', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../scripts/bootstrap-manifest.mjs', import.meta.url));

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

it('names the container choice beside the workspace argument for the linux host alone', async () => {
  const root = await temporaryHome();
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.2.1-alpha.1' }));
  await writeFile(join(root, 'scripts', 'bootstrap-manifest.mjs'), await readFile(MANIFEST, 'utf8'));

  expect(spawnSync(process.execPath, [join(root, 'scripts', 'bootstrap-manifest.mjs')]).status).toBe(0);

  const { hosts } = JSON.parse(await readFile(join(root, 'dist', 'bootstrap.json'), 'utf8')) as {
    hosts: Record<string, Record<string, unknown>>;
  };
  expect(hosts.linux).toMatchObject({
    workspace: { argument: '--workspace', quoting: 'posix' },
    container: { argument: '--container' },
  });
  expect(hosts.windows).not.toHaveProperty('container');
});

import { KIT_WIRE } from '@agentshouse/kit-wire';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { published } from './host.ts';
import { temporaryDirectory } from './kit.ts';
import { ENGINES, MODEL } from '../src/transcription.ts';

const LINUX = fileURLToPath(new URL('../bin/connect-linux.sh', import.meta.url));
const WINDOWS = fileURLToPath(new URL('../bin/connect-windows.ps1', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../scripts/bootstrap-manifest.mjs', import.meta.url));

function bootstrap(script: string, argv: string[]) {
  const ran = spawnSync('bash', [script, ...argv], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent' } });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

it('leaves the release exactly one Kit release, one Kit archive digest and one list of adapter digests to fill, and nothing in the Windows script', async () => {
  const linux = await readFile(LINUX, 'utf8');
  const windows = await readFile(WINDOWS, 'utf8');

  expect(spawnSync('bash', ['-n', LINUX]).status).toBe(0);
  expect(linux).not.toContain('__IMAGE_DIGEST__');
  expect(linux.split('__KIT_RELEASE__')).toHaveLength(2);
  expect(linux.split('__KIT_SHA256__')).toHaveLength(2);
  expect(linux.split('__ADAPTERS__')).toHaveLength(2);
  expect(windows).not.toMatch(/__[A-Z_]+__/);
  expect(windows).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
  expect(linux).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
});

it('installs the Node.js release the package runs on', async () => {
  const { engines } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    engines: { node: string };
  };

  expect(await readFile(LINUX, 'utf8')).toContain(`\nNODE_VERSION=${engines.node}\n`);
});

it('refuses to run before the release fills it, its adapter digests included', async () => {
  const refused = {
    status: 1,
    stderr: 'kit_bootstrap_refused: this bootstrap has not been published with an immutable release\n',
  };
  const unpinned = join(await temporaryDirectory(), 'connect-linux.sh');
  await writeFile(unpinned, (await readFile(await published(), 'utf8')).replace(/^ADAPTERS='[^']*'$/m, "ADAPTERS='__ADAPTERS__'"));

  expect(bootstrap(LINUX, [])).toMatchObject(refused);
  expect(bootstrap(unpinned, [])).toMatchObject(refused);
});

it.each([
  [['--linux']],
  [['--container']],
  [['--workspace', '/srv/agents']],
  [['--rooms', 'r_k2v.4']],
  [['--no-private']],
  [['--no-skills']],
  [['--enroll', 'environment-one']],
  [['kit', 'login']],
  [['house', 'push', '--owner']],
])('refuses %j as an unknown argument before it reads the host', async (argv) => {
  expect(bootstrap(await published(), ['--house', 'https://agents.house', ...argv])).toMatchObject({
    status: 1,
    stdout: '',
    stderr: `kit_bootstrap_refused: unknown argument ${argv[0]}\n`,
  });
});

const PROXIES = {
  HTTP_PROXY: 'http://forwarder:3128',
  HTTPS_PROXY: 'http://forwarder:3128',
  http_proxy: 'http://forwarder:3128',
  https_proxy: 'http://forwarder:3128',
};

function direct(linux: string): string {
  return /^DIRECT=.*\n.*DIRECT=.*$/m.exec(linux)![0];
}

it.each([
  ['with the proxy variables and from House itself when no Kit relay is set', {}, 'http://forwarder:3128', 'https://agents.house'],
  ['without the proxy variables and through the Kit relay a Sandbox sets', { HOUSE_KIT_RELAY: 'https://kit-relay.example' }, '', 'https://kit-relay.example/agents.house'],
] as const)('downloads its packages, Node.js and the Kit %s', async (_case, relay, proxy, served) => {
  const home = await temporaryDirectory();
  const linux = await readFile(LINUX, 'utf8');
  const steps = ['host_of', 'served_from', 'download', 'named', 'establish_native_packages', 'trust_extra_authorities', 'place_release'].map(
    (step) => new RegExp(`^${step}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(linux)![0],
  );
  const bin = join(home, 'bin');
  await mkdir(bin);
  for (const tool of ['apt-get', 'curl', 'sha256sum', 'tar']) {
    const logged = ['sha256sum', 'tar'].includes(tool)
      ? ''
      : `printf '%s %s %s\\n' ${tool} "\${HTTP_PROXY-}\${HTTPS_PROXY-}\${http_proxy-}\${https_proxy-}" "\$(eval printf %s "\\\${\$#}")" >> "$LOG"\n`;
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
absent_native_packages() { ABSENT=(ca-certificates curl git); }
${direct(linux)}
HOUSE=https://agents.house
VERSION=0.2.1-alpha.1
KIT_SHA256=${'1'.repeat(64)}
ADAPTERS='codex-acp-2.5.0.tar.gz=${'2'.repeat(64)}'
NODE_VERSION=24.22.1
NODE_PLATFORM=linux-x64
NODE_SHA256=${'0'.repeat(64)}
NODE_BYTES=58290700
CHECKSUM=(sha256sum)
${steps.join('')}
establish_native_packages
place_release "$TMPDIR/prefix" "$TMPDIR/prefix/bin"`,
    ],
    {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, LOG: join(home, 'downloads.log'), TMPDIR: home, ...PROXIES, ...relay },
    },
  );

  expect(ran.stderr).toBe('');
  const repeated = proxy.repeat(4);
  expect((await readFile(join(home, 'downloads.log'), 'utf8')).split('\n').filter(Boolean)).toEqual([
    `apt-get ${repeated} -qq`,
    `apt-get ${repeated} git`,
    `curl ${repeated} ${served}/kit-installer/node-v24.22.1-linux-x64.tar.gz`,
    `curl ${repeated} ${served}/kit-installer/kit-0.2.1-alpha.1.tar.gz`,
    `curl ${repeated} ${served}/kit-installer/codex-acp-2.5.0.tar.gz`,
  ]);
});

function staging(linux: string, house: string, bytes: number): string {
  const defined = ['host_of', 'served_from', 'download', 'trust_extra_authorities', 'place_release'].map(
    (step) => new RegExp(`^${step}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(linux)![0],
  );
  return `set -u
refuse() { printf 'refused: %s\\n' "$1" >&2; exit 1; }
${direct(linux)}
HOUSE=${house}
VERSION=0.2.1-alpha.1
KIT_SHA256=${'1'.repeat(64)}
ADAPTERS=''
NODE_VERSION=24.22.1
NODE_PLATFORM=linux-x64
NODE_SHA256=${'0'.repeat(64)}
NODE_BYTES=${bytes}
CHECKSUM=(sha256sum)
${defined.join('')}
place_release "$TMPDIR/prefix" "$TMPDIR/prefix/bin"`;
}

it('stops a Node.js download larger than its pinned size and downloads nothing more', async () => {
  const home = await temporaryDirectory();
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'curl'),
    '#!/bin/sh\nfor last; do :; done\nprintf "%s\\n" "$last" >> "$TMPDIR/curl.log"\nwhile [ "$1" != -o ]; do shift; done\nhead -c 1048576 /dev/zero 2>/dev/null > "$2"\n',
    { mode: 0o755 },
  );

  const ran = spawnSync(
    'bash',
    ['-c', staging(await readFile(LINUX, 'utf8'), 'https://agents.house', 4096)],
    // An install step still running after twenty seconds has hung, so the spec ends it rather than waiting on it.
    { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: home }, timeout: 20_000 },
  );

  expect(ran).toMatchObject({ status: 1, stderr: 'refused: the Node.js download is larger than its pinned 4096 bytes\n' });
  expect(await readFile(join(home, 'curl.log'), 'utf8')).toBe('https://agents.house/kit-installer/node-v24.22.1-linux-x64.tar.gz\n');
});

it('ends a Node.js download that has not arrived within its deadline and downloads nothing more', async () => {
  const held = new Set<Socket>();
  const stalled = createServer((socket) => held.add(socket));
  await new Promise<void>((listening) => stalled.listen(0, '127.0.0.1', listening));
  onTestFinished(() => {
    for (const socket of held) socket.destroy();
    return new Promise<void>((closed) => stalled.close(() => closed()));
  });
  const { port } = stalled.address() as AddressInfo;
  const home = await temporaryDirectory();
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nfor last; do :; done\nprintf "%s\\n" "$last" >> "$TMPDIR/curl.log"\nexec /usr/bin/curl "$@"\n', { mode: 0o755 });

  const ran = spawnSync(
    'bash',
    ['-c', staging(await readFile(LINUX, 'utf8'), `http://127.0.0.1:${port}`, 250000)],
    // An install step still running after twenty seconds has hung, so the spec ends it rather than waiting on it.
    { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: home }, timeout: 20_000 },
  );

  expect(ran).toMatchObject({ status: 1, stderr: expect.stringMatching(/\nrefused: the Node\.js download did not arrive within 3 seconds\n$/) });
  expect(await readFile(join(home, 'curl.log'), 'utf8')).toBe(`http://127.0.0.1:${port}/kit-installer/node-v24.22.1-linux-x64.tar.gz\n`);
});

it('writes the release manifest naming the Kit wire the release was built for, every file Kit installs by name and sha256, the image by digest and where a deploy takes each file the release does not carry', async () => {
  const release = await temporaryDirectory();
  const own: Record<string, string> = {
    'connect-linux.sh': '#!/usr/bin/env bash\n',
    'connect-windows.ps1': "$ErrorActionPreference = 'Stop'\n",
    'kit-0.2.1.tar.gz': 'the Kit archive',
    'codex-acp-2.5.0.tar.gz': 'the Codex adapter archive',
    'claude-agent-acp-0.100.0.tar.gz': 'the Claude Code adapter archive',
  };
  for (const [name, content] of Object.entries(own)) await writeFile(join(release, name), content);
  const image = `sha256:${'c'.repeat(64)}`;
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  if (version !== '0.2.1') await writeFile(join(release, `kit-${version}.tar.gz`), 'the Kit archive');

  expect(spawnSync(process.execPath, [MANIFEST, release, image], { encoding: 'utf8' })).toMatchObject({ status: 0, stderr: '' });

  const written = JSON.parse(await readFile(join(release, 'bootstrap.json'), 'utf8')) as { files: Record<string, { sha256: string; from?: string }> };
  const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
  expect(written).toMatchObject({
    schemaVersion: 3,
    version,
    wire: KIT_WIRE,
    hosts: { linux: 'connect-linux.sh', macos: 'connect-linux.sh', windows: 'connect-windows.ps1' },
    image,
  });
  for (const [name, content] of Object.entries(own)) expect(written.files[name]).toEqual({ sha256: sha256(content) });
  expect(written.files['node-v24.22.1-linux-x64.tar.gz']).toEqual({
    sha256: 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
    from: 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz',
  });
  expect(Object.keys(written.files).filter((name) => name.startsWith('node-')).sort()).toEqual(
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((platform) => `node-v24.22.1-${platform}.tar.gz`),
  );
  for (const artifact of [...Object.values(ENGINES).flatMap(({ decoder, engine }) => [decoder, engine]), MODEL]) {
    expect(written.files[artifact.name]).toEqual({ sha256: artifact.sha256, from: artifact.from });
  }
  expect(Object.values(written.files).filter((file) => file.from?.includes('github.com/agentshouse/kit/releases/download/v'))).toEqual([]);
});

it('refuses to write a release manifest for a release directory without its Kit archive', async () => {
  const release = await temporaryDirectory();
  await writeFile(join(release, 'connect-linux.sh'), '#!/usr/bin/env bash\n');
  await writeFile(join(release, 'connect-windows.ps1'), "$ErrorActionPreference = 'Stop'\n");

  const ran = spawnSync(process.execPath, [MANIFEST, release, `sha256:${'c'.repeat(64)}`], { encoding: 'utf8' });

  expect(ran.status).not.toBe(0);
  expect(ran.stderr).toContain(`${release} holds no kit-`);
});

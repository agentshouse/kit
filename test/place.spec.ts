import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, readdir, readFile, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { fakeHost, PUBLISHED_VERSION, type Host, type Platform } from './host.ts';
import { temporaryHome } from './kit.ts';

const LINUX = fileURLToPath(new URL('../bin/connect-linux.sh', import.meta.url));
const NEWER = '0.2.1-alpha.2';

interface Released {
  version: string;
  kit: Buffer;
  node: Buffer;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function released(version: string): Promise<Released> {
  const work = await temporaryHome();
  const node = join(work, 'node-v24.22.1-linux-x64');
  await mkdir(join(node, 'bin'), { recursive: true });
  await writeFile(
    join(node, 'bin', 'node'),
    '#!/bin/sh\nkit=$(sed -n 2p "$1")\nshift\nprintf \'%s|%s|%s|%s\\n\' "$0" "$kit" "$*" "$NODE_USE_SYSTEM_CA"\n',
    { mode: 0o755 },
  );
  const tree = join(work, 'kit');
  const dist = join(tree, 'lib', 'node_modules', '@agentshouse', 'kit', 'dist');
  await mkdir(dist, { recursive: true });
  await mkdir(join(tree, 'bin'));
  for (const command of ['kit', 'house']) {
    await writeFile(join(dist, `${command}-main.js`), `#!/usr/bin/env node\n// ${command} ${version}\n`, { mode: 0o755 });
    await symlink(`../lib/node_modules/@agentshouse/kit/dist/${command}-main.js`, join(tree, 'bin', command));
  }
  const packed = (directory: string, ...entries: string[]) => spawnSync('tar', ['-czf', '-', '-C', directory, ...entries]).stdout;
  return { version, kit: packed(tree, 'lib', 'bin'), node: packed(work, 'node-v24.22.1-linux-x64') };
}

async function placing(release: Released, kitSha256 = sha256(release.kit)): Promise<string> {
  const script = join(await temporaryHome(), 'connect-linux.sh');
  await writeFile(
    script,
    (await readFile(LINUX, 'utf8'))
      .replace('__IMAGE_DIGEST__', 'a'.repeat(64))
      .replace('__KIT_RELEASE__', release.version)
      .replace('__KIT_SHA256__', kitSha256)
      .replace(/NODE_SHA256=[0-9a-f]{64}/g, `NODE_SHA256=${sha256(release.node)}`)
      .replace(/NODE_BYTES=\d+/g, `NODE_BYTES=${release.node.length}`),
  );
  return script;
}

interface Served {
  origin: string;
  requests: string[];
}

async function building(files: Record<string, Buffer>, secure?: { key: Buffer; cert: Buffer }): Promise<Served> {
  const requests: string[] = [];
  const answer = (request: IncomingMessage, response: ServerResponse) => {
    requests.push(request.url!);
    const bytes = files[request.url!.replace('/kit-installer/', '')];
    if (bytes === undefined) response.writeHead(404).end();
    else response.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
  };
  const server = secure === undefined ? createHttpServer(answer) : createHttpsServer(secure, answer);
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  onTestFinished(() => new Promise<void>((closed) => server.close(() => closed())));
  const { port } = server.address() as AddressInfo;
  return { origin: `${secure === undefined ? 'http' : 'https'}://127.0.0.1:${port}`, requests };
}

function served(...releases: Released[]): Record<string, Buffer> {
  return Object.fromEntries(
    releases.flatMap((release) => [
      [`kit-${release.version}.tar.gz`, release.kit],
      ['node-v24.22.1-linux-x64.tar.gz', release.node],
      ['node-v24.22.1-linux-arm64.tar.gz', release.node],
    ]),
  );
}

function place(script: string, house: string, prefix: string, added: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((settled) =>
    execFile('bash', [script, '--house', house, '--place', prefix], { encoding: 'utf8', env: { ...process.env, ...added } }, (error, stdout, stderr) =>
      settled({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr }),
    ),
  );
}

function started(prefix: string, command = 'kit') {
  return spawnSync(join(prefix, 'bin', command), ['status'], { encoding: 'utf8', env: { PATH: process.env.PATH! } }).stdout;
}

async function snapshot(directory: string): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const found = await lstat(path);
    entries.push(`${path} ${found.mtimeMs} ${found.isFile() ? sha256(await readFile(path)) : ''}`);
  }
  return entries.sort();
}

it('places a release in a directory of its own beside the launchers that start it, and places it again only when another release runs', async () => {
  const one = await released('0.2.1-c000000000001');
  const house = await building(served(one));
  const prefix = join(await temporaryHome(), 'house-kit');

  const ran = await place(await placing(one), house.origin, prefix);

  expect(ran).toEqual({ status: 0, stdout: `Downloading Node.js 24.22.1 and Kit ${one.version} from ${house.origin}.\n`, stderr: '' });
  expect(await readFile(join(prefix, 'current'), 'utf8')).toBe(`${one.version}\n`);
  expect((await readdir(prefix)).sort()).toEqual(['bin', 'current', 'releases']);
  expect(started(prefix)).toBe(`${prefix}/releases/${one.version}/bin/node|// kit ${one.version}|status|1\n`);
  expect(started(prefix, 'house')).toBe(`${prefix}/releases/${one.version}/bin/node|// house ${one.version}|status|1\n`);
  house.requests.length = 0;

  expect(await place(await placing(one), house.origin, prefix)).toEqual({ status: 0, stdout: '', stderr: '' });
  expect(house.requests).toEqual([]);
});

it('places a newer release beside the one that runs without writing into its directory, and keeps that one until a later placement', async () => {
  const [one, two, three] = await Promise.all(['0.2.1-c000000000001', '0.2.1-c000000000002', '0.2.1-c000000000003'].map(released));
  const house = await building(served(one!, two!, three!));
  const prefix = join(await temporaryHome(), 'house-kit');
  expect(await place(await placing(one!), house.origin, prefix)).toMatchObject({ status: 0 });
  const running = join(prefix, 'releases', one!.version);
  const before = await snapshot(running);
  spawnSync('chmod', ['-R', 'a-w', running]);
  onTestFinished(() => void spawnSync('chmod', ['-R', 'u+w', running]));

  expect(await place(await placing(two!), house.origin, prefix)).toMatchObject({ status: 0, stderr: '' });

  expect(await snapshot(running)).toEqual(before);
  expect(started(prefix)).toBe(`${prefix}/releases/${two!.version}/bin/node|// kit ${two!.version}|status|1\n`);
  spawnSync('chmod', ['-R', 'u+w', running]);
  expect(await place(await placing(three!), house.origin, prefix)).toMatchObject({ status: 0, stderr: '' });
  expect((await readdir(join(prefix, 'releases'))).sort()).toEqual([two!.version, three!.version]);
  expect(started(prefix)).toBe(`${prefix}/releases/${three!.version}/bin/node|// kit ${three!.version}|status|1\n`);
});

it.each([
  ['a Kit archive that does not match its digest', 'kit_bootstrap_refused: the Kit download does not match its pinned checksum\n', true],
  ['a Building that does not serve the Kit archive', 'kit_bootstrap_refused: Kit could not be downloaded from %s\n', false],
] as const)('leaves the running release and its launchers as they were after %s', async (_name, refusal, servesTwo) => {
  const [one, two] = await Promise.all(['0.2.1-c000000000001', '0.2.1-c000000000002'].map(released));
  const house = await building(servesTwo ? served(one!, two!) : served(one!));
  const prefix = join(await temporaryHome(), 'house-kit');
  expect(await place(await placing(one!), house.origin, prefix)).toMatchObject({ status: 0 });

  const ran = await place(await placing(two!, servesTwo ? sha256(Buffer.from('another archive')) : sha256(two!.kit)), house.origin, prefix);

  expect(ran.status).toBe(1);
  expect(ran.stderr).toContain(refusal.replace('%s', house.origin));
  expect(await readFile(join(prefix, 'current'), 'utf8')).toBe(`${one!.version}\n`);
  expect(await readdir(join(prefix, 'releases'))).toEqual([one!.version]);
  expect(started(prefix)).toBe(`${prefix}/releases/${one!.version}/bin/node|// kit ${one!.version}|status|1\n`);
});

it("downloads through the authorities NODE_EXTRA_CA_CERTS names beside the computer's own, as a container's Kit trusts them", async () => {
  const work = await temporaryHome();
  const made = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(work, 'key.pem'), '-out', join(work, 'certificate.pem'),
  ]);
  expect(made.status).toBe(0);
  const one = await released('0.2.1-c000000000001');
  const house = await building(served(one), { key: await readFile(join(work, 'key.pem')), cert: await readFile(join(work, 'certificate.pem')) });
  const script = await placing(one);

  const untrusted = await place(script, house.origin, join(work, 'untrusted'));
  const trusted = await place(script, house.origin, join(work, 'trusted'), { NODE_EXTRA_CA_CERTS: join(work, 'certificate.pem') });

  expect(untrusted).toMatchObject({ status: 1, stderr: expect.stringContaining(`kit_bootstrap_refused: Node.js could not be downloaded from ${house.origin}\n`) });
  expect(trusted).toMatchObject({ status: 0, stderr: '' });
  expect(await readFile(join(work, 'trusted', 'current'), 'utf8')).toBe(`${one.version}\n`);
});

const DOCKERFILE = fileURLToPath(new URL('../Dockerfile', import.meta.url));

type Route = 'desktop' | 'server' | 'container';

const ROUTES: ReadonlyArray<readonly [string, Platform, readonly string[], Route]> = [
  ['the native desktop placement on Linux', { system: 'Linux', machine: 'x86_64' }, [], 'desktop'],
  ['the native desktop placement on macOS', { system: 'Darwin', machine: 'arm64' }, [], 'desktop'],
  ['native-host mode', { system: 'Linux', machine: 'x86_64', server: true, systemd: true }, ['--linux'], 'server'],
  ['the container route on Linux', { system: 'Linux', machine: 'x86_64' }, ['--container'], 'container'],
  ['the container route on macOS', { system: 'Darwin', machine: 'x86_64', appleSilicon: false }, ['--container'], 'container'],
];

function acts(host: Host): string[] {
  return [...host.calls('systemctl'), ...host.calls('launchctl')].filter((call) => !/^((--user )?(is-(active|enabled)|show)|print) /.test(call));
}

function placedInImage(host: Host): number {
  return host.calls('docker').findIndex((call) => /^run -i --entrypoint bash .* -s - --house https:\/\/agents\.house --place \/kit-home\/kit$/.test(call));
}

async function holds(prefix: string, version: string): Promise<void> {
  expect(await readFile(join(prefix, 'current'), 'utf8')).toBe(`${version}\n`);
  await access(join(prefix, 'releases', version, 'bin', 'node'));
  await access(join(prefix, 'releases', version, 'lib', 'node_modules', '@agentshouse', 'kit', 'dist'));
}

it.each(ROUTES)('places the Building’s Kit release and its Node runtime through the one placement in %s, and its launcher starts that release', async (_name, platform, placement, route) => {
  const host = await fakeHost(platform);

  expect(host.run([...placement])).toMatchObject({ status: 0, stderr: '' });

  await holds(host.prefixes[route], PUBLISHED_VERSION);
  const node = route === 'container' || platform.system === 'Linux' ? 'linux-x64' : 'darwin-arm64';
  expect(host.calls('curl')).toEqual([
    expect.stringMatching(new RegExp(` https://agents\\.house/kit-installer/node-v24\\.22\\.1-${node}\\.tar\\.gz$`)),
    expect.stringMatching(/ https:\/\/agents\.house\/kit-installer\/kit-0\.2\.1-alpha\.1\.tar\.gz$/),
  ]);
  if (route === 'container') {
    expect(placedInImage(host)).toBeGreaterThan(-1);
    expect(placedInImage(host)).toBeLessThan(host.calls('docker').findIndex((call) => call.startsWith('run -d ')));
  }
  await host.forget();
  expect(host.shell(`${join(host.prefixes[route], 'bin', 'kit')} status`)).toMatchObject({ status: 0, stderr: '' });
  expect(host.calls('kit')).toEqual([expect.stringMatching(/^status /)]);
});

it.each([
  ['the native desktop placement on Linux', { system: 'Linux', machine: 'x86_64' }, [], 'desktop', ['--user stop house-kit.service', '--user start house-kit.service']],
  ['the native desktop placement on macOS', { system: 'Darwin', machine: 'arm64' }, [], 'desktop', [`bootout gui/${process.getuid!()}/house-kit`, `enable gui/${process.getuid!()}/house-kit`, expect.stringMatching(/^bootstrap /)]],
  ['native-host mode', { system: 'Linux', machine: 'x86_64', server: true, systemd: true }, ['--linux'], 'server', ['stop house-kit.service', 'daemon-reload', '--quiet enable --now house-kit.service']],
] as const)('places a newer release beside the old one when the install command runs again in %s, starts it and writes nothing into the old one', async (_name, platform, placement, route, started) => {
  const host = await fakeHost(platform);
  expect(host.run([...placement])).toMatchObject({ status: 0 });
  const old = join(host.prefixes[route], 'releases', PUBLISHED_VERSION);
  const before = await snapshot(old);
  spawnSync('chmod', ['-R', 'a-w', old]);
  onTestFinished(() => void spawnSync('chmod', ['-R', 'u+w', old]));
  await host.publish(NEWER);
  await host.forget();

  const ran = host.run([...placement]);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').at(-2)).toBe('Kit updated.');
  await holds(host.prefixes[route], NEWER);
  expect(await snapshot(old)).toEqual(before);
  expect(acts(host)).toEqual(started);
});

it('places the native-host release owned by the account its Kit service runs as, elevating only to make its directory that account’s', async () => {
  const host = await fakeHost({ system: 'Linux', machine: 'x86_64', server: true, systemd: true });
  const prefix = host.prefixes.server;

  expect(host.run(['--linux'])).toMatchObject({ status: 0, stderr: '' });

  expect((await host.serverUnit()).split('\n')).toContain('User=owner');
  for (const placed of ['', 'current', 'bin/kit', 'bin/house', `releases/${PUBLISHED_VERSION}`, `releases/${PUBLISHED_VERSION}/bin/node`]) {
    expect((await stat(join(prefix, placed))).uid).toBe(process.getuid!());
  }
  expect(host.calls('sudo').filter((call) => call.split(' ').some((word) => word === prefix || word.startsWith(`${prefix}/`)))).toEqual([`rm -rf ${prefix}`, `install -d -m 0755 -o ${process.getuid!()} -g ${process.getgid!()} ${prefix}`]);
});

const CONTAINERS = [
  ['Linux', { system: 'Linux', machine: 'x86_64' }],
  ['macOS', { system: 'Darwin', machine: 'x86_64', appleSilicon: false }],
] as const;

it('builds the image as a base system that carries no Kit release and no Node runtime and starts the release Kit home holds', async () => {
  const dockerfile = await readFile(DOCKERFILE, 'utf8');

  expect(/^FROM (\S+)$/m.exec(dockerfile)?.[1]).toMatch(/^mirror\.gcr\.io\/library\/debian:trixie-slim@sha256:[0-9a-f]{64}$/);
  expect(dockerfile).not.toMatch(/^(COPY|ADD) /m);
  expect(dockerfile).not.toMatch(/\bnpm\b/);
  expect(dockerfile).toContain("dpkg --compare-versions \"$(dpkg-query -W -f='${Version}' libbrotli1)\" ge 1.1.0-2+deb13u1");
  expect(JSON.parse(/^ENTRYPOINT (.+)$/m.exec(dockerfile)![1]!)).toEqual(['tini', '--', '/kit-home/kit/bin/kit']);
  expect(/^ +PATH=(\S+)$/m.exec(dockerfile)?.[1]?.split(':')[0]).toBe('/kit-home/kit/bin');
  const profile = /printf '([^']*)' > \/etc\/profile\.d\/kit\.sh/.exec(dockerfile)?.[1];
  expect(spawnSync('sh', ['-c', `${profile!.replace('\\n', '\n')}printf %s "$PATH"`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout).toBe('/kit-home/kit/bin:/usr/bin:/bin');
});

it.each(CONTAINERS)("starts the release Kit home holds in a container created again on %s, placing nothing", async (_name, platform) => {
  const host = await fakeHost(platform);
  expect(host.run(['--container'])).toMatchObject({ status: 0 });
  await host.clear('container');
  await host.forget();

  expect(host.run(['--container'])).toMatchObject({ status: 0, stderr: '' });

  expect(placedInImage(host)).toBe(-1);
  expect(host.calls('curl')).toEqual([]);
  expect(host.calls('docker').filter((call) => call.startsWith('run -d '))).toHaveLength(1);
  await host.forget();
  const [, , command] = JSON.parse(/^ENTRYPOINT (.+)$/m.exec(await readFile(DOCKERFILE, 'utf8'))![1]!) as string[];
  expect(host.shell(`HOUSE_KIT_HOME=/kit-home ${command!.replace('/kit-home/kit', host.prefixes.container)} resident`)).toMatchObject({ status: 0, stderr: '' });
  expect(host.calls('kit')).toEqual(['resident HOUSE_KIT_HOME=/kit-home']);
});

it.each(CONTAINERS)('places a newer release in Kit home when the install command runs again on %s and creates the container again, keeping the workspace and the credential, checking authority, configuring and logging in through it', async (_name, platform) => {
  const host = await fakeHost(platform);
  expect(host.run(['--container'])).toMatchObject({ status: 0 });
  const kitHome = join(host.home, '.house-kit');
  await writeFile(join(host.home, 'AgentsHouse', 'notes.md'), 'kept\n');
  const credential = await readFile(join(kitHome, 'credential.json'), 'utf8');
  await host.publish(NEWER);
  await host.forget();

  const ran = host.run(['--container', '--no-private']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout).toContain('Kit updated.\n');
  await holds(host.prefixes.container, NEWER);
  const node = `/kit-home/kit/releases/${NEWER}/bin/node`;
  const dist = `/kit-home/kit/releases/${NEWER}/lib/node_modules/@agentshouse/kit/dist`;
  expect(host.calls('docker').filter((call) => /^(run|rm) /.test(call))).toEqual([
    expect.stringMatching(/ --place \/kit-home\/kit$/),
    expect.stringMatching(new RegExp(`^run --entrypoint ${node} .* ${dist}/authority-main\\.js$`)),
    expect.stringMatching(new RegExp(`^run --entrypoint ${node} .* ${dist}/configure-main\\.js$`)),
    'rm -f house-kit',
    expect.stringMatching(/^run -d --name house-kit --restart on-failure .* resident$/),
    expect.stringMatching(/^run --rm .* login --no-private$/),
  ]);
  expect(await readFile(join(host.home, 'AgentsHouse', 'notes.md'), 'utf8')).toBe('kept\n');
  expect(await readFile(join(kitHome, 'credential.json'), 'utf8')).toBe(credential);
});

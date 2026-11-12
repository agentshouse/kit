import { execFile, spawnSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { CLIS, adapterArchive } from '../src/clis.ts';
import { temporaryHome } from './kit.ts';
import { ADAPTED, placing, released, releasedOnNode, served, sha256 } from './release.ts';

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
  expect(started(prefix)).toBe(`${prefix}/releases/${one.version}/bin/node|// kit ${one.version}|status|1|${prefix}\n`);
  expect(started(prefix, 'house')).toBe(`${prefix}/releases/${one.version}/bin/node|// house ${one.version}|status|1|${prefix}\n`);
  for (const kind of ADAPTED) {
    const adapter = join(prefix, 'releases', one.version, 'adapters', kind, 'node_modules', '.bin', CLIS[kind]!.adapter!.bin);
    expect(spawnSync(adapter, { encoding: 'utf8' }).stdout).toBe(`${adapterArchive(kind)}\n`);
  }
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
  expect(started(prefix)).toBe(`${prefix}/releases/${two!.version}/bin/node|// kit ${two!.version}|status|1|${prefix}\n`);
  spawnSync('chmod', ['-R', 'u+w', running]);
  expect(await place(await placing(three!), house.origin, prefix)).toMatchObject({ status: 0, stderr: '' });
  expect((await readdir(join(prefix, 'releases'))).sort()).toEqual([two!.version, three!.version]);
  expect(started(prefix)).toBe(`${prefix}/releases/${three!.version}/bin/node|// kit ${three!.version}|status|1|${prefix}\n`);
});

it('places a newer release on the Node.js the running release holds while the release pins the same Node.js, downloading only the Kit and its adapters', async () => {
  const one = await released('0.2.1-c000000000001');
  const two = await released('0.2.1-c000000000002');
  const house = await building(served(one, two));
  const prefix = join(await temporaryHome(), 'house-kit');
  expect(await place(await placing(one), house.origin, prefix)).toMatchObject({ status: 0 });
  house.requests.length = 0;

  const ran = await place(await placing(two), house.origin, prefix);

  expect(ran).toEqual({ status: 0, stdout: `Downloading Kit ${two.version} from ${house.origin}.\n`, stderr: '' });
  expect(house.requests).toEqual([`/kit-installer/kit-${two.version}.tar.gz`, ...ADAPTED.map((kind) => `/kit-installer/${adapterArchive(kind)}`)]);
  expect(started(prefix)).toBe(`${prefix}/releases/${two.version}/bin/node|// kit ${two.version}|status|1|${prefix}\n`);
  expect(started(prefix, 'house')).toBe(`${prefix}/releases/${two.version}/bin/node|// house ${two.version}|status|1|${prefix}\n`);
});

it('downloads Node.js again for a newer release that pins another Node.js than the running release holds', async () => {
  const one = await released('0.2.1-c000000000001');
  const two = await releasedOnNode('0.2.1-c000000000002', 'rebuilt');
  const prefix = join(await temporaryHome(), 'house-kit');
  expect(await place(await placing(one), (await building(served(one))).origin, prefix)).toMatchObject({ status: 0 });
  const house = await building(served(two));

  const ran = await place(await placing(two), house.origin, prefix);

  expect(ran).toEqual({ status: 0, stdout: `Downloading Node.js 24.22.1 and Kit ${two.version} from ${house.origin}.\n`, stderr: '' });
  expect(house.requests[0]).toBe('/kit-installer/node-v24.22.1-linux-x64.tar.gz');
  expect(await readFile(join(prefix, 'releases', two.version, 'bin', 'node'), 'utf8')).toContain('rebuilt');
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
  expect(started(prefix)).toBe(`${prefix}/releases/${one!.version}/bin/node|// kit ${one!.version}|status|1|${prefix}\n`);
});

it('leaves the running release and its launchers as they were after an adapter archive that does not match its digest', async () => {
  const [one, two] = await Promise.all(['0.2.1-c000000000001', '0.2.1-c000000000002'].map(released));
  const house = await building(served(one!, two!));
  const prefix = join(await temporaryHome(), 'house-kit');
  expect(await place(await placing(one!), house.origin, prefix)).toMatchObject({ status: 0 });
  const [mismatched] = ADAPTED;

  const ran = await place(
    await placing(two!, sha256(two!.kit), (kind) => (kind === mismatched ? sha256(Buffer.from('another archive')) : sha256(two!.adapters[kind]!))),
    house.origin,
    prefix,
  );

  expect(ran.status).toBe(1);
  expect(ran.stderr).toContain(`kit_bootstrap_refused: the ${adapterArchive(mismatched!)} download does not match its pinned checksum\n`);
  expect(await readFile(join(prefix, 'current'), 'utf8')).toBe(`${one!.version}\n`);
  expect(await readdir(join(prefix, 'releases'))).toEqual([one!.version]);
  expect(started(prefix)).toBe(`${prefix}/releases/${one!.version}/bin/node|// kit ${one!.version}|status|1|${prefix}\n`);
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

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ENGINES, MODEL } from '../src/transcription.ts';

const MANIFEST = 'bootstrap.json';
const HOSTS = { linux: 'connect-linux.sh', macos: 'connect-linux.sh', windows: 'connect-windows.ps1' };
const NODE_PIN = /NODE_PLATFORM=(\S+)\s+NODE_SHA256=([0-9a-f]{64})/g;

const [given, image] = process.argv.slice(2);
if (given === undefined || !/^sha256:[0-9a-f]{64}$/.test(image ?? '')) {
  process.stderr.write('usage: node scripts/bootstrap-manifest.mjs <release directory> sha256:<image index digest>\n');
  process.exit(2);
}
const release = resolve(given);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const bootstrap = await readFile(new URL('../bin/connect-linux.sh', import.meta.url), 'utf8');
const node = /^NODE_VERSION=(\S+)$/m.exec(bootstrap)[1];

const files = {};
for (const name of (await readdir(release)).filter((name) => name !== MANIFEST).sort()) {
  files[name] = { sha256: createHash('sha256').update(await readFile(join(release, name))).digest('hex') };
}
for (const [, platform, sha256] of bootstrap.matchAll(NODE_PIN)) {
  const name = `node-v${node}-${platform}.tar.gz`;
  files[name] = { sha256, from: `https://nodejs.org/dist/v${node}/${name}` };
}
for (const artifact of [...Object.values(ENGINES).flatMap(({ decoder, engine }) => [decoder, engine]), MODEL]) {
  files[artifact.name] = { sha256: artifact.sha256, from: artifact.from };
}
for (const name of new Set([...Object.values(HOSTS), `kit-${version}.tar.gz`])) {
  if (files[name]?.from !== undefined || files[name] === undefined) throw new Error(`${release} holds no ${name}`);
}
await writeFile(join(release, MANIFEST), `${JSON.stringify({ schemaVersion: 3, version, hosts: HOSTS, image, files }, null, 2)}\n`);

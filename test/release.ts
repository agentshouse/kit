import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIS, adapterArchive } from '../src/clis.ts';
import type { Hosted } from './environment.ts';
import { temporaryHome } from './kit.ts';

const LINUX = fileURLToPath(new URL('../bin/connect-linux.sh', import.meta.url));

export const ADAPTED = Object.keys(CLIS).filter((kind) => CLIS[kind]!.adapter !== null);

export interface Released {
  version: string;
  kit: Buffer;
  node: Buffer;
  adapters: Record<string, Buffer>;
}

const adapterArchives = new Map<string, Buffer>();

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function released(version: string): Promise<Released> {
  const work = await temporaryHome();
  const node = join(work, 'node-v24.22.1-linux-x64');
  await mkdir(join(node, 'bin'), { recursive: true });
  await writeFile(
    join(node, 'bin', 'node'),
    '#!/bin/sh\nkit=$(sed -n 2p "$1")\nshift\nprintf \'%s|%s|%s|%s|%s\\n\' "$0" "$kit" "$*" "$NODE_USE_SYSTEM_CA" "$HOUSE_KIT_PREFIX"\n',
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
  const adapters: Record<string, Buffer> = {};
  for (const kind of ADAPTED) {
    if (!adapterArchives.has(kind)) {
      const adapter = join(work, 'adapters', kind);
      await mkdir(join(adapter, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(adapter, 'node_modules', '.bin', CLIS[kind]!.adapter!.bin), `#!/bin/sh\necho ${adapterArchive(kind)}\n`, { mode: 0o755 });
      adapterArchives.set(kind, packed(adapter, 'node_modules'));
    }
    adapters[kind] = adapterArchives.get(kind)!;
  }
  return { version, kit: packed(tree, 'lib', 'bin'), node: packed(work, 'node-v24.22.1-linux-x64'), adapters };
}

export async function placing(release: Released, kitSha256 = sha256(release.kit), adapterSha256 = (kind: string) => sha256(release.adapters[kind]!)): Promise<string> {
  const script = join(await temporaryHome(), 'connect-linux.sh');
  await writeFile(
    script,
    (await readFile(LINUX, 'utf8'))
      .replace('__IMAGE_DIGEST__', 'a'.repeat(64))
      .replace('__KIT_RELEASE__', release.version)
      .replace('__KIT_SHA256__', kitSha256)
      .replace('__ADAPTERS__', ADAPTED.map((kind) => `${adapterArchive(kind)}=${adapterSha256(kind)}`).join(' '))
      .replace(/NODE_SHA256=[0-9a-f]{64}/g, `NODE_SHA256=${sha256(release.node)}`)
      .replace(/NODE_BYTES=\d+/g, `NODE_BYTES=${release.node.length}`),
  );
  return script;
}

export function served(...releases: Released[]): Record<string, Buffer> {
  return Object.fromEntries(
    releases.flatMap((release) => [
      [`kit-${release.version}.tar.gz`, release.kit],
      ['node-v24.22.1-linux-x64.tar.gz', release.node],
      ['node-v24.22.1-linux-arm64.tar.gz', release.node],
      ...ADAPTED.map((kind) => [adapterArchive(kind), release.adapters[kind]!] as const),
    ]),
  );
}

export interface ServedBuilding {
  answers: boolean;
}

export async function serveRelease(hosted: Hosted, release: Released, installer?: string): Promise<ServedBuilding> {
  const files: Record<string, Buffer> = { ...served(release), 'connect-linux.sh': await readFile(installer ?? (await placing(release))) };
  const manifest = {
    schemaVersion: 3,
    version: release.version,
    hosts: { linux: 'connect-linux.sh', macos: 'connect-linux.sh', windows: 'connect-windows.ps1' },
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes) }])),
  };
  const building = { answers: true };
  hosted.house.route('GET', '/kit-installer/:name', ({ params }) => {
    if (!building.answers) return { drop: true };
    if (params.name === 'bootstrap.json') return { body: manifest };
    const bytes = files[params.name!];
    if (bytes === undefined) return { status: 404, body: { error: { code: 'not_found', retryable: false } } };
    return { bytes: { type: 'application/octet-stream', content: bytes } };
  });
  return building;
}

export function callUpdate(hosted: Hosted, id: string, release: string): void {
  hosted.house.connections.findLast((connection) => connection.transport.readyState === connection.transport.OPEN)!.send({
    type: 'input',
    input_id: id,
    kind: 'update',
    conversation_id: null,
    agent_id: null,
    provider_session_id: null,
    release,
  });
}

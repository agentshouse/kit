import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIS, adapterArchive } from '../src/clis.ts';
import { ENGINES, MODEL, type Artifact } from '../src/transcription.ts';
import { placeAdapter } from './adapters.ts';
import type { Answer, House } from './double.ts';

const CACHE = fileURLToPath(new URL('../tmp/transcription-cache/', import.meta.url));
const PINNED = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { peerDependencies: Record<string, string> })
  .peerDependencies;

export const KIT_FILE_HOLD = 'kit-file-hold';
export const KIT_FILE_MISSING = 'kit-file-missing';
export const KIT_FILE_STALL = 'kit-file-stall';
export const KIT_FILE_CORRUPT = 'kit-file-corrupt';
export const KIT_FILE_OVERSIZE = 'kit-file-oversize';
export const KIT_FILE_DROPPED_ONCE = 'kit-file-dropped-once';

export function pinnedArtifacts(platform = `${process.platform}-${process.arch}`): Artifact[] {
  const engine = ENGINES[platform]!;
  return [engine.decoder, engine.engine, MODEL];
}

export function cacheArtifacts(platform?: string): void {
  mkdirSync(CACHE, { recursive: true });
  for (const artifact of pinnedArtifacts(platform)) {
    const cached = join(CACHE, artifact.sha256);
    if (existsSync(cached)) continue;
    // Three retries ride out a dropped download of a pinned artifact before the suite fails on it.
    const fetched = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', `${cached}.part`, artifact.from], { stdio: 'inherit' });
    if (fetched.status !== 0) throw new Error(`${artifact.from} did not download`);
    if (createHash('sha256').update(readFileSync(`${cached}.part`)).digest('hex') !== artifact.sha256) {
      throw new Error(`${artifact.from} does not match its sha256`);
    }
    renameSync(`${cached}.part`, cached);
  }
}

const archives = new Map<string, Buffer>();

export function adapterArchiveBytes(kind: string): Buffer {
  const held = archives.get(kind);
  if (held !== undefined) return held;
  const prefix = mkdtempSync(join(tmpdir(), 'kit-adapter-archive-'));
  try {
    placeAdapter(prefix, kind, PINNED[CLIS[kind]!.adapter!.package]!);
    const packed = spawnSync('tar', ['-czf', '-', '-C', prefix, 'node_modules']);
    if (packed.status !== 0) throw new Error(`the ${kind} adapter archive could not be packed: ${packed.stderr}`);
    archives.set(kind, packed.stdout);
    return packed.stdout;
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function listed(home: string, name: string, file: string): boolean {
  const list = join(home, name);
  return existsSync(list) && readFileSync(list, 'utf8').split('\n').includes(file);
}

function artifacts(): Artifact[] {
  return [...Object.values(ENGINES).flatMap(({ decoder, engine }) => [decoder, engine]), MODEL];
}

function manifest(home: string): Record<string, { sha256: string }> {
  const files: Record<string, { sha256: string }> = {};
  for (const kind of Object.keys(CLIS)) {
    if (CLIS[kind]!.adapter !== null) files[adapterArchive(kind)] = { sha256: sha256(adapterArchiveBytes(kind)) };
  }
  for (const artifact of artifacts()) files[artifact.name] = { sha256: artifact.sha256 };
  for (const name of Object.keys(files)) if (listed(home, KIT_FILE_MISSING, name)) delete files[name];
  return files;
}

function served(home: string, name: string): Answer | null {
  const kind = Object.keys(CLIS).find((candidate) => CLIS[candidate]!.adapter !== null && adapterArchive(candidate) === name);
  const artifact = artifacts().find((candidate) => candidate.name === name);
  if (listed(home, KIT_FILE_MISSING, name) || (kind === undefined && artifact === undefined)) return null;
  if (listed(home, KIT_FILE_CORRUPT, name)) return { bytes: { type: 'application/octet-stream', content: 'not the file the release names' } };
  if (listed(home, KIT_FILE_DROPPED_ONCE, name) && !listed(home, `${KIT_FILE_DROPPED_ONCE}.done`, name)) {
    appendFileSync(join(home, `${KIT_FILE_DROPPED_ONCE}.done`), `${name}\n`);
    return { drop: true };
  }
  if (listed(home, KIT_FILE_STALL, name)) return { partial: Buffer.from('the start of a download that never ends') };
  if (artifact !== undefined && listed(home, KIT_FILE_OVERSIZE, name)) {
    return { bytes: { type: 'application/octet-stream', content: Buffer.concat([readFileSync(join(CACHE, artifact.sha256)), Buffer.alloc(1_048_576)]) } };
  }
  if (kind !== undefined) return { bytes: { type: 'application/octet-stream', content: adapterArchiveBytes(kind) } };
  return { file: join(CACHE, artifact!.sha256) };
}

export function serveKitFiles(house: House, home: string): void {
  house.route('GET', '/kit-installer/:name', async ({ params }) => {
    // Fifty milliseconds lets a held download go on as soon as the spec removes the hold file.
    while (existsSync(join(home, KIT_FILE_HOLD))) await new Promise((resolve) => setTimeout(resolve, 50));
    if (params.name === 'bootstrap.json') return { body: { schemaVersion: 3, files: manifest(home) } };
    return served(home, params.name!) ?? { status: 404, body: { error: { code: 'not_found', retryable: false } } };
  });
}

export function kitFileRequests(house: House): string[] {
  return house.requests
    .filter((request) => request.path.startsWith('/kit-installer/') && request.path !== '/kit-installer/bootstrap.json')
    .map((request) => request.path.slice('/kit-installer/'.length));
}

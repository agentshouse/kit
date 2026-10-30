import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES, MODEL, type Artifact } from '../src/transcription.ts';
import type { Answer, House } from './double.ts';

const CACHE = fileURLToPath(new URL('../tmp/transcription-cache/', import.meta.url));

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

function listed(home: string, name: string, file: string): boolean {
  const list = join(home, name);
  return existsSync(list) && readFileSync(list, 'utf8').split('\n').includes(file);
}

function artifacts(): Artifact[] {
  return [...Object.values(ENGINES).flatMap(({ decoder, engine }) => [decoder, engine]), MODEL];
}

function served(home: string, name: string): Answer | null {
  const artifact = artifacts().find((candidate) => candidate.name === name);
  if (artifact === undefined) return null;
  if (listed(home, KIT_FILE_CORRUPT, name)) return { bytes: { type: 'application/octet-stream', content: 'not the file the release names' } };
  if (listed(home, KIT_FILE_DROPPED_ONCE, name) && !listed(home, `${KIT_FILE_DROPPED_ONCE}.done`, name)) {
    appendFileSync(join(home, `${KIT_FILE_DROPPED_ONCE}.done`), `${name}\n`);
    return { drop: true };
  }
  if (listed(home, KIT_FILE_STALL, name)) return { partial: Buffer.from('the start of a download that never ends') };
  if (listed(home, KIT_FILE_OVERSIZE, name)) {
    return { bytes: { type: 'application/octet-stream', content: Buffer.concat([readFileSync(join(CACHE, artifact.sha256)), Buffer.alloc(1_048_576)]) } };
  }
  return { file: join(CACHE, artifact.sha256) };
}

export function serveKitFiles(house: House, home: string): void {
  house.route('GET', '/kit-installer/:name', ({ params }) => {
    return served(home, params.name!) ?? { status: 404, body: { error: { code: 'not_found', retryable: false } } };
  });
}

export function kitFileRequests(house: House): string[] {
  return house.requests.filter((request) => request.path.startsWith('/kit-installer/')).map((request) => request.path.slice('/kit-installer/'.length));
}

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readEnrolment } from './home.ts';
import { relayed } from './relay.ts';

const MANIFEST = 'bootstrap.json';

async function served(name: string, signal?: AbortSignal): Promise<Response> {
  const enrolment = await readEnrolment();
  if (enrolment === null) throw new Error('this Kit is connected to no House');
  const answer = await fetch(relayed(new URL(`/kit-installer/${encodeURIComponent(name)}`, enrolment.house)), { signal });
  if (answer.status === 200 && answer.body !== null) return answer;
  await answer.body?.cancel();
  throw new Error(`House answered ${answer.status} for ${name}`);
}

export interface ServedRelease {
  version: string;
  installer: string;
  sha256: string;
}

export async function servedRelease(signal?: AbortSignal): Promise<ServedRelease> {
  const manifest = (await (await served(MANIFEST, signal)).json()) as {
    version?: unknown;
    hosts?: { linux?: unknown };
    files?: Record<string, { sha256?: unknown }>;
  };
  const installer = manifest.hosts?.linux;
  const sha256 = typeof installer === 'string' ? manifest.files?.[installer]?.sha256 : undefined;
  if (typeof manifest.version !== 'string' || typeof installer !== 'string' || typeof sha256 !== 'string') {
    throw new Error(`House serves no Kit release in ${MANIFEST}`);
  }
  return { version: manifest.version, installer, sha256 };
}

export async function downloadServed(name: string, sha256: string, destination: string, signal?: AbortSignal, most = Infinity): Promise<void> {
  const answer = await served(name, signal);
  const digest = createHash('sha256');
  let bytes = 0;
  const hashed = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > most) return done(new Error(`${name} is larger than its pinned ${most} bytes`));
      digest.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(answer.body!, hashed, createWriteStream(destination), { signal });
    if (digest.digest('hex') !== sha256) throw new Error(`${name} does not match its sha256`);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

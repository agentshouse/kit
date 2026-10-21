import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseDocument } from 'yaml';
import { retryDelay } from './api.ts';
import { Unsettled } from './mcp.ts';
import { relayed } from './relay.ts';

export interface UploadParts {
  id: string;
  part_bytes: number;
  parts: { part: number; url: string }[];
}

export type Finished<T> = { upload: UploadParts } | { checking: true } | T;

export interface Uploading<T> {
  bytes: number;
  send(url: string, start: number, end: number): Promise<void>;
  finish(upload: string): Promise<Finished<T>>;
}

export interface Address {
  download: string;
  sha256: string;
}

export interface InspectedFile extends Address {
  media_type: string | null;
}

export interface Answered {
  status: number;
  body: AsyncIterable<Uint8Array>;
}

const STALLED_ROUNDS = 8;

const LINK = /\]\((\/rooms\/[^/)\s]+\/[^)\s]+)\)/gu;

export function linkedPaths(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(LINK), (link) => link[1]!))];
}

export function inspectedFile(answer: string): InspectedFile | null {
  const document = parseDocument(answer);
  if (document.errors.length > 0) return null;
  const inspected = document.toJS() as { download?: unknown; sha256?: unknown; media_type?: unknown } | null;
  if (typeof inspected?.download !== 'string') return null;
  return {
    download: inspected.download,
    sha256: String(inspected.sha256),
    media_type: typeof inspected.media_type === 'string' ? inspected.media_type : null,
  };
}

function paused(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function storeRefusal(act: 'upload' | 'download', status: number): Error {
  return new Error(`the ${act} answered ${status}; ${act} the file again`);
}

export async function uploaded<T extends object>(declared: UploadParts, uploading: Uploading<T>): Promise<T> {
  let upload = declared;
  let idle = 0;
  let stalled = 0;
  for (;;) {
    let sent = 0;
    let failure: unknown = null;
    for (const { part, url } of upload.parts) {
      const start = (part - 1) * upload.part_bytes;
      try {
        await uploading.send(url, start, Math.min(start + upload.part_bytes, uploading.bytes));
        sent++;
      } catch (error) {
        failure = error;
        break;
      }
    }
    if (sent > 0) {
      idle = 0;
      stalled = 0;
    } else {
      if (failure !== null && ++stalled >= STALLED_ROUNDS) throw failure;
      // A round that sent no part, its store unreachable or not yet started, is followed by the next finishing call on the jittered curve.
      await paused(retryDelay(idle++));
    }
    let answer = await finishing(uploading, upload.id);
    while ('checking' in answer) {
      // A finishing call that finds House still checking the stored bytes is sent again after five seconds, the cadence at which House takes up a check it handed over.
      await paused(5_000);
      answer = await finishing(uploading, upload.id);
    }
    if (!('upload' in answer)) return answer;
    upload = answer.upload;
  }
}

async function finishing<T extends object>(uploading: Uploading<T>, upload: string): Promise<Finished<T>> {
  for (let unsettled = 1; ; unsettled++) {
    try {
      return await uploading.finish(upload);
    } catch (error) {
      if (!(error instanceof Unsettled) || unsettled === STALLED_ROUNDS) throw error;
    }
    // A finishing call House did not settle, unreached or refused short of final, is sent again on the jittered curve as a conversation resends it, so a dropped connection or a House restart resumes the upload instead of ending it.
    await paused(retryDelay(unsettled - 1));
  }
}

async function drained(body: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of body);
}

export async function downloaded(
  address: () => Promise<Address>,
  fetching: (url: string) => Promise<Answered>,
  destination: string,
  name: string,
): Promise<void> {
  for (let asked = 1; ; asked++) {
    const { download, sha256 } = await address();
    const answer = await fetching(download);
    if (answer.status === 403 && asked === 1) {
      await drained(answer.body);
      continue;
    }
    if (answer.status !== 200) {
      await drained(answer.body);
      throw storeRefusal('download', answer.status);
    }
    await mkdir(dirname(destination), { recursive: true });
    const partial = join(dirname(destination), `.${basename(destination)}.${randomUUID()}`);
    const digest = createHash('sha256');
    const hashed = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        digest.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(answer.body, hashed, createWriteStream(partial, { flags: 'wx' }));
      if (digest.digest('hex') !== sha256) throw new Error(`${name} did not arrive whole; download it again`);
      await rename(partial, destination);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    return;
  }
}

export async function fetched(url: string, signal: AbortSignal): Promise<Answered> {
  const answer = await fetch(relayed(url), { signal });
  return { status: answer.status, body: answer.body ?? Readable.from([]) };
}

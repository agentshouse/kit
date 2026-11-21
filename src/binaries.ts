import { randomUUID } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import { downloaded, fetched, fileRange, mediaTypeOf, sentPart, uploaded, type Address, type Finished, type Way } from './files.ts';
import { hashed } from './manifest.ts';

export interface StagedUpload {
  sha256: string;
  id: string;
  part_bytes: number;
}

export interface Staged {
  staged: true;
}

export interface Part {
  bytes: number;
  sha256: string;
}

export class Changed extends Error {}

const SENT_AT_ONCE = 10;

const OCTET_STREAM = 'application/octet-stream';

const MARKDOWN = /\.md$/i;

const STORE: Way = {
  unreached: (error) => new Error(`the store did not answer (${error.code ?? error.message})`),
  refused: (status) => new Error(`the store answered ${status}`),
};

export function isDocument(path: string): boolean {
  return MARKDOWN.test(path);
}

export function mediaType(path: string): string {
  return mediaTypeOf(path) ?? OCTET_STREAM;
}

export async function eachAtOnce<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const working = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(SENT_AT_ONCE, items.length) }, working));
}

export async function sentBinary(
  staging: string,
  file: string,
  name: string,
  part: Part,
  upload: StagedUpload,
  finish: (upload: string, partSha256: string[]) => Promise<Finished<Staged>>,
): Promise<void> {
  const copy = `${staging}${randomUUID()}`;
  try {
    await copyFile(file, copy).catch(() => {
      throw new Changed(`${name} is gone since house upload read it`);
    });
    const held = await hashed(copy);
    if (held?.sha256 !== part.sha256 || held.bytes !== part.bytes) throw new Changed(`${name} changed since house upload read it`);
    await uploaded(
      { id: upload.id, part_bytes: upload.part_bytes },
      {
        name,
        bytes: part.bytes,
        sha256: part.sha256,
        read: (start, end) => fileRange(copy, start, end, (error) => error as Error),
        send: (url, start, end, headers) => sentPart(url, copy, start, end, headers, STORE),
        finish,
      },
    );
  } finally {
    await rm(copy, { force: true });
  }
}

export async function receivedBinary(staging: string, name: string, address: () => Promise<Address>): Promise<string> {
  const file = `${staging}${randomUUID()}`;
  try {
    await downloaded(address, (url) => fetched(url), file, name);
    return file;
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}

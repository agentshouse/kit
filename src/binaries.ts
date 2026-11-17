import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { downloaded, fetched, fileRange, mediaTypeOf, sentPart, uploaded, type Address, type Finished, type Way } from './files.ts';
import { blobBytes, blobSizes, isText, storedFile } from './git.ts';

export interface Described {
  bytes: number;
  sha256: string;
  media_type: string;
}

export interface StagedUpload {
  sha256: string;
  id: string;
  part_bytes: number;
}

export interface Staged {
  staged: true;
}

const SENT_AT_ONCE = 10;

const UPLOADS = 'house-uploads';

const DOWNLOADS = 'house-downloads';

const OCTET_STREAM = 'application/octet-stream';

const MARKDOWN = /\.md$/i;

const STORE: Way = {
  unreached: (error) => new Error(`the store did not answer (${error.code ?? error.message})`),
  refused: (status) => new Error(`the store answered ${status}`),
};

async function sha256Of(repository: string, object: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of blobBytes(repository, object)) digest.update(chunk);
  return digest.digest('hex');
}

export function isDocument(path: string): boolean {
  return MARKDOWN.test(path);
}

export async function untext(repository: string, documents: readonly (readonly [string, string])[], maxBytes: number): Promise<string[]> {
  const sizes = await blobSizes(repository, documents.map(([, object]) => object));
  const refused: string[] = [];
  for (const [path, object] of documents) {
    if (!(await isText(repository, object, sizes.get(object)!, maxBytes))) refused.push(path);
  }
  return refused;
}

export async function attachments(repository: string, arriving: readonly (readonly [string, string])[]): Promise<Map<string, Described>> {
  const sizes = await blobSizes(repository, arriving.map(([, object]) => object));
  const described = new Map<string, Described>();
  for (const [path, object] of arriving) {
    described.set(path, { bytes: sizes.get(object)!, sha256: await sha256Of(repository, object), media_type: mediaTypeOf(path) ?? OCTET_STREAM });
  }
  return described;
}

export async function holds(repository: string, object: string, file: { bytes: number; sha256: string }): Promise<boolean> {
  const sizes = await blobSizes(repository, [object]);
  return sizes.get(object) === file.bytes && (await sha256Of(repository, object)) === file.sha256;
}

export async function eachAtOnce<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const working = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(SENT_AT_ONCE, items.length) }, working));
}

export async function sentBinary(
  repository: string,
  object: string,
  name: string,
  file: Described,
  upload: StagedUpload,
  finish: (upload: string, partSha256: string[]) => Promise<Finished<Staged>>,
): Promise<void> {
  const directory = join(repository, '.git', UPLOADS);
  await mkdir(directory, { recursive: true });
  const copy = join(directory, randomUUID());
  try {
    await pipeline(Readable.from(blobBytes(repository, object)), createWriteStream(copy, { flags: 'wx' }));
    await uploaded(
      { id: upload.id, part_bytes: upload.part_bytes },
      {
        name,
        bytes: file.bytes,
        sha256: file.sha256,
        read: (start, end) => fileRange(copy, start, end, (error) => error as Error),
        send: (url, start, end, headers) => sentPart(url, copy, start, end, headers, STORE),
        finish,
      },
    );
  } finally {
    await rm(copy, { force: true });
  }
}

export async function receivedBinary(repository: string, name: string, address: () => Promise<Address>): Promise<string> {
  const file = join(repository, '.git', DOWNLOADS, randomUUID());
  try {
    await downloaded(address, (url) => fetched(url), file, name);
    return await storedFile(repository, file);
  } finally {
    await rm(file, { force: true });
  }
}

export async function sweptTransfers(repository: string): Promise<void> {
  for (const directory of [UPLOADS, DOWNLOADS]) await rm(join(repository, '.git', directory), { recursive: true, force: true });
}

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { downloaded, fetched } from './files.ts';

const DOWNLOADS_AT_ONCE = 6;

// A chunk is about one megabyte, so a download still unfinished after two minutes holds every Room behind it on a dead connection.
const CHUNK_DOWNLOAD_MS = 120_000;

export interface Chunk {
  hash: string;
  download: string;
}

export interface Text {
  path: string;
  content: string;
  revision: string;
  provenance?: string;
}

class AddressExpired extends Error {
  constructor() {
    super("House's store refused every chunk it asked for");
  }
}

function once(chunk: Chunk): () => Promise<{ download: string; sha256: string }> {
  let asked = false;
  return async () => {
    if (asked) throw new AddressExpired();
    asked = true;
    return { download: chunk.download, sha256: chunk.hash };
  };
}

export async function stagedChunks(directory: string, chunks: readonly Chunk[]): Promise<unknown> {
  let next = 0;
  let failure: unknown;
  const downloading = async () => {
    while (next < chunks.length && failure === undefined) {
      const chunk = chunks[next++]!;
      const reading = (url: string) => fetched(url, AbortSignal.timeout(CHUNK_DOWNLOAD_MS));
      await downloaded(once(chunk), reading, join(directory, chunk.hash), 'A Room chunk').catch((error: unknown) => {
        failure ??= error;
      });
    }
  };
  await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, downloading));
  return failure;
}

export async function* chunkTexts(directory: string, chunks: readonly Chunk[], models: readonly Text[]): AsyncGenerator<Text> {
  yield* models;
  for (const { hash } of chunks) {
    const file = join(directory, hash);
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (line === '') continue;
      const entry = JSON.parse(line) as Text | { content?: never };
      if (entry.content !== undefined) yield entry;
    }
    await rm(file);
  }
}

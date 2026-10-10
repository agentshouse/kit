import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HouseRefusal, retrying, type House } from './api.ts';
import { relayed } from './relay.ts';

export interface MessageFile {
  version: string;
  name: string;
  media_type: string | null;
}

interface Original {
  message: string;
  download: { url: string };
}

export async function placeFiles(
  house: House,
  directory: string,
  files: MessageFile[],
  signal: AbortSignal,
): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    const original = await house.post<Original>(
      '/kit/conversation/originals/get',
      { version: file.version, download: true },
      signal,
    );
    const answer = await fetch(relayed(original.download.url), { signal });
    if (!answer.ok) throw new Error(`${file.name} did not download: ${answer.status}`);
    const folder = join(directory, '.house', 'files', original.message, file.version);
    await mkdir(join(directory, '.house')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await mkdir(folder, { recursive: true });
    const path = join(folder, file.name);
    await writeFile(path, Buffer.from(await answer.arrayBuffer()));
    paths.push(path);
  }
  return paths;
}

export interface SavedFile {
  version: string;
  save: { status: string; failure: string | null };
  upload?: { url: string; operation: string };
}

export function uploadBytes(upload: { url: string; operation: string }, bytes: Buffer): Promise<SavedFile> {
  return retrying(async () => {
    const answer = await fetch(relayed(upload.url), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-house-byte-operation': upload.operation },
      body: bytes,
    });
    const text = await answer.text();
    if (!answer.ok) throw new HouseRefusal(upload.url, answer.status, text);
    return JSON.parse(text) as SavedFile;
  });
}

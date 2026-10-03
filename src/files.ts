import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { House } from './api.ts';

export interface MessageFile {
  version: string;
  name: string;
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
    const answer = await fetch(original.download.url, { signal });
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

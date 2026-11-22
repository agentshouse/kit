import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const MANIFEST = '.house';

const UNREAD = '.git';

const MARKER = /^(?:<{7}|={7}|>{7})(?: .*)?$/m;

export interface Entry {
  revision: string;
  sha256: string;
  bytes: number;
  read_only?: true;
  skipped?: true;
  conflicted?: true;
}

export interface Manifest {
  room_ref: string;
  files: Record<string, Entry>;
  kit?: string[];
}

export interface Present {
  name: string;
  sha256: string;
  bytes: number;
}

export function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function fileDigest(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export async function hashed(file: string): Promise<{ sha256: string; bytes: number } | null> {
  try {
    return await fileDigest(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EISDIR') return null;
    throw error;
  }
}

export async function holding(repository: string, name: string, sha256: string): Promise<boolean> {
  return (await hashed(join(repository, name)))?.sha256 === sha256;
}

export async function readManifest(repository: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(repository, MANIFEST), 'utf8')) as Manifest;
}

export async function placed(staging: string, target: string, content: Buffer | string): Promise<void> {
  const temporary = `${staging}${randomUUID()}`;
  await writeFile(temporary, content);
  await mkdir(dirname(target), { recursive: true });
  await rename(temporary, target);
}

export async function writeManifest(repository: string, staging: string, manifest: Manifest): Promise<void> {
  const files = Object.fromEntries(Object.entries(manifest.files).sort(([left], [right]) => (left < right ? -1 : 1)));
  const kit = manifest.kit === undefined ? {} : { kit: manifest.kit };
  await placed(staging, join(repository, MANIFEST), `${JSON.stringify({ room_ref: manifest.room_ref, files, ...kit })}\n`);
}

export async function removed(repository: string, name: string): Promise<void> {
  await rm(join(repository, name), { force: true });
  for (let folder = dirname(name); folder !== '.'; folder = dirname(folder)) {
    if (!(await rmdir(join(repository, folder)).then(() => true, () => false))) return;
  }
}

export async function scanned(repository: string): Promise<Map<string, Present>> {
  const present = new Map<string, Present>();
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(join(repository, folder), { withFileTypes: true })) {
      const name = folder === '' ? entry.name : `${folder}/${entry.name}`;
      if (folder === '' && (entry.name === MANIFEST || entry.name === UNREAD)) continue;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const file = await hashed(join(repository, name));
        if (file !== null) present.set(name.normalize('NFC'), { name, ...file });
      }
    }
  };
  await walk('');
  return present;
}

export async function marked(repository: string, name: string): Promise<boolean> {
  const text = await readFile(join(repository, name), 'utf8').catch(() => null);
  return text !== null && MARKER.test(text);
}

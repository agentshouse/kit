import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RoomSkillsRecord } from './skills.ts';

export const MANIFEST = '.house';

const GIT = '.git';

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
  skills?: RoomSkillsRecord;
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
  const skills = manifest.skills === undefined ? {} : { skills: manifest.skills };
  await placed(staging, join(repository, MANIFEST), `${JSON.stringify({ room_ref: manifest.room_ref, files, ...kit, ...skills })}\n`);
}

export async function removed(repository: string, name: string): Promise<void> {
  await rm(join(repository, name), { force: true });
  for (let folder = dirname(name); folder !== '.'; folder = dirname(folder)) {
    if (!(await rmdir(join(repository, folder)).then(() => true, () => false))) return;
  }
}

export interface Scan {
  present: Map<string, Present>;
  left: string[];
  within?: string[];
}

export function covered(scan: Scan, path: string): boolean {
  return scan.within === undefined || scan.within.some((root) => path === root || path.startsWith(`${root}/`));
}

export function leaves(left: readonly string[], path: string): boolean {
  return left.some((folder) => path.startsWith(`${folder}/`));
}

async function walked(repository: string, file: (name: string) => Promise<void>, from = ''): Promise<string[]> {
  const left: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    const entries = await readdir(join(repository, folder), { withFileTypes: true });
    if (folder !== '' && entries.some((entry) => entry.name === GIT)) {
      left.push(folder.normalize('NFC'));
      return;
    }
    for (const entry of entries) {
      const name = folder === '' ? entry.name : `${folder}/${entry.name}`;
      if (folder === '' && (entry.name === MANIFEST || entry.name === GIT)) continue;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) await file(name);
    }
  };
  await walk(from);
  return left.sort();
}

export async function scanned(repository: string): Promise<Scan> {
  const present = new Map<string, Present>();
  const left = await walked(repository, async (name) => {
    const file = await hashed(join(repository, name));
    if (file !== null) present.set(name.normalize('NFC'), { name, ...file });
  });
  return { present, left };
}

async function workTreeOn(repository: string, name: string): Promise<string | null> {
  const segments = name.split('/');
  for (let count = 1; count < segments.length; count++) {
    const folder = segments.slice(0, count).join('/');
    if ((await lstat(join(repository, folder, GIT)).catch(() => null)) !== null) return folder;
  }
  return null;
}

export async function scannedAt(repository: string, names: Iterable<string>): Promise<Scan> {
  const present = new Map<string, Present>();
  const left = new Set<string>();
  const within = new Set<string>();
  const file = async (name: string) => {
    const held = await hashed(join(repository, name));
    if (held !== null) present.set(name.normalize('NFC'), { name, ...held });
  };
  for (const name of new Set(names)) {
    const root = name.normalize('NFC');
    if (root === MANIFEST || root === GIT || root.startsWith(`${GIT}/`)) continue;
    within.add(root);
    const holder = await workTreeOn(repository, name);
    if (holder !== null) {
      left.add(holder.normalize('NFC'));
      continue;
    }
    const found = await lstat(join(repository, name)).catch(() => null);
    if (found?.isFile()) await file(name);
    else if (found?.isDirectory()) for (const folder of await walked(repository, file, name)) left.add(folder);
  }
  return { present, left: [...left].sort(), within: [...within] };
}

export function leftIn(repository: string): Promise<string[]> {
  return walked(repository, async () => undefined);
}

export async function marked(repository: string, name: string): Promise<boolean> {
  const text = await readFile(join(repository, name), 'utf8').catch(() => null);
  return text !== null && MARKER.test(text);
}

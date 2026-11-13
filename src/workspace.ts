import type { Dirent } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function present(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function listed(path: string): Promise<string[]> {
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  const shown = await Promise.all(
    entries.map(async (entry) => {
      const at = join(entry.parentPath, entry.name);
      return `${at.slice(path.length)} ${entry.isFile() ? (await lstat(at)).size : entry.isDirectory() ? 'folder' : 'link'}`;
    }),
  );
  return shown.sort();
}

async function moved(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  const copy = `${target}.moving`;
  await rm(copy, { recursive: true, force: true });
  try {
    await cp(source, copy, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    const folder = (await lstat(source)).isDirectory();
    if (folder && JSON.stringify(await listed(source)) !== JSON.stringify(await listed(copy))) {
      throw new Error(`${source} could not be copied to ${target} whole`);
    }
  } catch (error) {
    await rm(copy, { recursive: true, force: true });
    throw error;
  }
  await rename(copy, target);
  await rm(source, { recursive: true, force: true });
}

export type Placement = 'stays' | 'opens' | 'moves';

export async function merged(
  from: string,
  to: string,
  placed: (source: string, entry: Dirent) => Placement = () => 'moves',
): Promise<void> {
  const found = await present(from);
  if (found === null || !found.isDirectory()) return;
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const placement = placed(source, entry);
    if (placement === 'stays') continue;
    const target = join(to, entry.name);
    const held = await present(target);
    if (held === null && placement === 'moves') await moved(source, target);
    else if (entry.isDirectory() && (held === null || held.isDirectory())) await merged(source, target, placed);
    else await rm(source, { recursive: true, force: true });
  }
  await removeFolder(from);
}

export async function removeFolder(path: string): Promise<void> {
  await rmdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
  });
}

export function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function rewritten(value: unknown, from: string, to: string, kept: readonly string[]): unknown {
  if (typeof value === 'string') {
    if (kept.some((folder) => within(value, folder)) || (within(to, from) && within(value, to)) || !within(value, from)) return value;
    return `${to}${value.slice(from.length)}`;
  }
  if (Array.isArray(value)) return value.map((item) => rewritten(item, from, to, kept));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, held]) => [name, rewritten(held, from, to, kept)]));
  }
  return value;
}

export async function followRoot(records: string, from: string, to: string, kept: readonly string[] = []): Promise<void> {
  if (from === to) return;
  for (const name of await readdir(records).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const path = join(records, name);
    const text = await readFile(path, 'utf8');
    const next = `${JSON.stringify(rewritten(JSON.parse(text), from, to, kept))}\n`;
    if (next.trim() === text.trim()) continue;
    await writeFile(`${path}.new`, next, { mode: 0o600 });
    await rename(`${path}.new`, path);
  }
}

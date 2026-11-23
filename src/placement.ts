import { readFileSync, readlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { kitHome, oneFolder } from './home.ts';

function recorded(name: string): string | null {
  try {
    return readFileSync(join(kitHome(), name), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function installCommand(): string | null {
  return recorded('install-command');
}

export function placedPrefix(): string {
  const prefix = process.env.HOUSE_KIT_PREFIX;
  if (prefix === undefined || prefix === '') throw new Error('this Kit process was not started by a launcher its installer placed');
  return resolve(prefix);
}

export function releaseDirectory(release: string): string {
  return join(placedPrefix(), 'releases', release);
}

export function placedLink(folder: string, command: string): boolean {
  try {
    return readlinkSync(join(folder, command)) === join(oneFolder(), 'bin', command);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EINVAL') return false;
    throw error;
  }
}

export async function removePlacedLinks(command: string): Promise<void> {
  for (const folder of ['/usr/local/bin', join(homedir(), '.local', 'bin')]) {
    if (placedLink(folder, command)) await rm(join(folder, command), { force: true });
  }
}

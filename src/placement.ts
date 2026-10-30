import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { kitHome } from './home.ts';

export type Machine = 'macos' | 'linux' | 'container' | 'server' | 'windows';

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

export function machine(): Machine {
  const placed = recorded('placement');
  if (placed === 'container' || placed === 'server' || placed === 'windows') return placed;
  return process.platform === 'darwin' ? 'macos' : 'linux';
}

export function placedPrefix(): string {
  const prefix = process.env.HOUSE_KIT_PREFIX;
  if (prefix === undefined || prefix === '') throw new Error('this Kit process was not started by a launcher its installer placed');
  return resolve(prefix);
}

export function releaseDirectory(release: string): string {
  return join(placedPrefix(), 'releases', release);
}

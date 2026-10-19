import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './clis.ts';
import { kitHome } from './home.ts';

type Service = 'user' | 'system';

export function service(): Service | null {
  if (process.platform !== 'linux' || !process.env.INVOCATION_ID) return null;
  return process.env.MANAGERPID ? 'user' : 'system';
}

export function throughSudo(): boolean {
  return service() === 'system' && process.getuid!() !== 0;
}

export async function updatesItself(): Promise<boolean> {
  if (service() === null) return false;
  if (!throughSudo()) return true;
  // sudo answers at once, so ten seconds only bounds a stuck sudo.
  return (await run('sudo', ['-n', 'true'], 10_000)).status === 0;
}

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

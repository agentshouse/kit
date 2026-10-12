import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './clis.ts';
import { kitHome } from './home.ts';
import { relayOrigin } from './relay.ts';

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

function installed(): string | null {
  try {
    return readFileSync(join(kitHome(), 'placement'), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function entries(house: string): [shell: string, windows: string] {
  const host = new URL(house).host;
  const relay = relayOrigin();
  if (relay === undefined) return [`curl -fsSL ${host}/kit | sh`, `irm ${host}/kit.ps1 | iex`];
  const entry = `${relay}/${host}/kit`;
  return [`curl -fsSL ${entry} | HOUSE_KIT_RELAY=${relay} sh`, `$env:HOUSE_KIT_RELAY='${relay}'; irm ${entry}.ps1 | iex`];
}

export function installCommand(house: string): string {
  const [shell, windows] = entries(house);
  const placement = installed();
  if (placement === 'native') return shell;
  if (placement === 'server') return `${shell} -s -- --linux`;
  return `${shell} -s -- --container, or ${windows} on Windows`;
}

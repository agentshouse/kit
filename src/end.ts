import { forgetRejected, recordPlannedRestart } from './home.ts';
import { installCommand } from './placement.ts';
import { killDescendants } from './kill.ts';

export const REPLACED = 'another Kit process started for this Environment';

function exit(reason: string, status: number): never {
  process.stderr.write(`kit: ${reason}\n`);
  killDescendants();
  process.exit(status);
}

export function end(reason: string): never {
  exit(reason, process.env.HOUSE_KIT_RESIDENT === String(process.pid) ? 0 : 1);
}

export function restart(reason: string): never {
  exit(reason, 1);
}

export function restartPlaced(release: string): never {
  recordPlannedRestart();
  restart(`Kit ${release} is placed; its supervisor starts it`);
}

export function updateLine(lead: string): string {
  const command = installCommand();
  return command === null ? `${lead}; install it again.` : `${lead}. Update it: ${command}`;
}

export function updateRequired(): never {
  end(updateLine("House does not serve this Kit's wire"));
}

export async function signInAgain(rejected: string): Promise<never> {
  await forgetRejected(rejected);
  restart('sign in again');
}

import { KIT_RELEASE } from './clis.ts';
import { forgetRejected } from './home.ts';
import { installCommand } from './placement.ts';
import { killDescendants } from './scope.ts';

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

export function updateRequired(): never {
  const command = installCommand();
  end(command === null ? 'This Kit is too old for House; install it again.' : `This Kit is too old for House. Update it: ${command}`);
}

export function newerThanHouse(release: string, command: string): never {
  end(`Kit ${KIT_RELEASE} is newer than this Building supports (Kit ${release}). Install Kit ${release}: ${command}`);
}

export async function signInAgain(rejected: string): Promise<never> {
  await forgetRejected(rejected);
  restart('sign in again');
}

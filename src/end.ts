import { forgetRejected } from './home.ts';
import { installCommand } from './placement.ts';
import { killDescendants } from './scope.ts';

export const REPLACED = 'another Kit started for this Environment';

function exit(reason: string, status: number): never {
  process.stderr.write(`kit: ${reason}\n`);
  killDescendants();
  process.exit(status);
}

export function end(reason: string): never {
  exit(reason, 0);
}

export function restart(reason: string): never {
  exit(reason, 1);
}

export function updateRequired(house: string): never {
  end(`This Kit is too old for House. Update it: ${installCommand(house)}`);
}

export async function signInAgain(rejected: string): Promise<never> {
  await forgetRejected(rejected);
  restart('sign in again');
}

import { forgetRejected } from './home.ts';
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

export async function signInAgain(rejected: string): Promise<never> {
  await forgetRejected(rejected);
  restart('sign in again');
}

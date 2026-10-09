import { killDescendants } from './acp.ts';

export const REPLACED = 'another Kit started for this Environment';
export const SIGN_IN_AGAIN = 'sign in again';

export function end(reason: string): never {
  process.stderr.write(`kit: ${reason}\n`);
  killDescendants();
  process.exit(0);
}

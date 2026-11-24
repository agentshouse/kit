import type { KitOneWayCallOf } from '@agentshouse/kit-wire';
import { realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scope } from './scope.ts';
import type { Work } from './work.ts';

export type Judgment = Omit<KitOneWayCallOf<'judgment'>, 'type' | 'conversation_id'>;

export const IDLE: Judgment = { turn: 'ended', secret: false, background: false };

export interface Judged {
  turns: number;
  asking: { secret: boolean } | null;
  running: { work: Work; scope: Scope } | null;
  leftovers: Iterable<Scope>;
}

const HOUSE = realpathSync(fileURLToPath(new URL(`./house-main${extname(fileURLToPath(import.meta.url))}`, import.meta.url)));

function waitsOnRuns(command: string): boolean {
  const [, entry, verb, act] = command.split(' ');
  if (entry === undefined || verb !== 'agent' || act !== 'run') return false;
  try {
    return realpathSync(entry) === HOUSE;
  } catch {
    return false;
  }
}

function background({ running, leftovers }: Judged, turn: Judgment['turn']): Judgment['background'] {
  if (turn === 'running') return true;
  if ([...leftovers].some((scope) => scope.working())) return true;
  if (running === null) return false;
  const shown = running.work.shown();
  if (shown === 'work') return true;
  if (!running.scope.working()) return shown === 'shells';
  return running.scope.waiting(waitsOnRuns) ? 'runs' : true;
}

export function judged(process: Judged): Judgment {
  const asking = process.turns === 1 ? process.asking : null;
  const turn = process.turns === 0 ? 'ended' : asking !== null ? 'asking' : 'running';
  return { turn, secret: asking?.secret ?? false, background: background(process, turn) };
}

export function idle(judgment: Judgment): boolean {
  return judgment.turn === 'ended' && judgment.background === false;
}

export function stoppable(judgment: Judgment): boolean {
  return judgment.background === false && (judgment.turn === 'ended' || (judgment.turn === 'asking' && !judgment.secret));
}

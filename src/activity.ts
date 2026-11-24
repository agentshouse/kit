import type { KitOneWayCallOf } from '@agentshouse/kit-wire';
import { realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scope } from './scope.ts';
import type { Work } from './work.ts';

export type Activity = Omit<KitOneWayCallOf<'activity'>, 'type' | 'conversation_id'>;

export const IDLE: Activity = { turn: 'ended', secret: false, background: false };

export interface Observed {
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

function background({ running, leftovers }: Observed, turn: Activity['turn']): Activity['background'] {
  if (turn === 'running') return true;
  if ([...leftovers].some((scope) => scope.working())) return true;
  if (running === null) return false;
  const shown = running.work.shown();
  if (shown === 'work') return true;
  if (!running.scope.working()) return shown === 'shells';
  return running.scope.waiting(waitsOnRuns) ? 'runs' : true;
}

export function activityOf(process: Observed): Activity {
  const asking = process.turns === 1 ? process.asking : null;
  const turn = process.turns === 0 ? 'ended' : asking !== null ? 'asking' : 'running';
  return { turn, secret: asking?.secret ?? false, background: background(process, turn) };
}

export function idle(activity: Activity): boolean {
  return activity.turn === 'ended' && activity.background === false;
}

export function stoppable(activity: Activity): boolean {
  return activity.background === false && (activity.turn === 'ended' || (activity.turn === 'asking' && !activity.secret));
}

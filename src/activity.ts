import type { KitOneWayCallOf } from '@agentshouse/kit-wire';
import type { Work } from './work.ts';

export type Activity = Omit<KitOneWayCallOf<'activity'>, 'type' | 'conversation_id'>;

export const IDLE: Activity = { turn: 'ended', secret: false, background: false };

export interface Observed {
  turns: number;
  asking: { secret: boolean } | null;
  work: Work | null;
}

function background({ work }: Observed, turn: Activity['turn']): Activity['background'] {
  if (turn === 'running') return true;
  const shown = work?.shown() ?? 'none';
  return shown === 'none' ? false : shown === 'runs' ? 'runs' : true;
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

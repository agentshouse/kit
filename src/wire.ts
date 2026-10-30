import { newerThanHouse, updateRequired } from './end.ts';
import { machine, type Machine } from './placement.ts';
import { refusalOf } from './refusals.ts';

export const KIT_WIRE = 4;
export const KIT_WIRE_HEADER = 'x-house-kit-wire';

interface Unserved {
  code: string;
  release: string;
  commands: Record<Machine, string>;
}

let take: ((release: string) => void) | null = null;
let taken = false;

function unservedBy(text: string): Unserved | null {
  let body: { error?: Unserved } | null;
  try {
    body = JSON.parse(text) as { error?: Unserved } | null;
  } catch {
    return null;
  }
  const error = body?.error;
  if (error?.code !== 'kit_update_required' && error?.code !== 'kit_newer_than_house') return null;
  return typeof error.release === 'string' ? error : null;
}

export function takeUnservedRelease(taking: (release: string) => void): void {
  take = taking;
}

export function unserved(): boolean {
  return taken;
}

export function endUnserved(text: string): void {
  const refused = unservedBy(text);
  if (refused !== null && take !== null) {
    if (!taken) {
      taken = true;
      take(refused.release);
    }
    return;
  }
  if (refusalOf(text)?.code === 'kit_update_required') updateRequired();
  if (refused?.code === 'kit_newer_than_house') newerThanHouse(refused.release, refused.commands[machine()]);
}

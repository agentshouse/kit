import type { BuildingKit } from '@agentshouse/kit-wire';
import { updateRequired } from './end.ts';
import { refusalOf } from './refusals.ts';

let take: ((release: string) => void) | null = null;
let taken = false;

function unservedBy(text: string): BuildingKit | null {
  let body: { error?: { code?: string } & BuildingKit } | null;
  try {
    body = JSON.parse(text) as { error?: { code?: string } & BuildingKit } | null;
  } catch {
    return null;
  }
  return body?.error?.code === 'kit_update_required' ? body.error : null;
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
}

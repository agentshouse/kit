import { newerThanHouse, updateRequired } from './end.ts';
import { machine, type Machine } from './placement.ts';
import { refusalOf } from './refusals.ts';

export const KIT_WIRE = 4;
export const KIT_WIRE_HEADER = 'x-house-kit-wire';

interface NewerThanHouse {
  code: string;
  release: string;
  commands: Record<Machine, string>;
}

function newer(text: string): NewerThanHouse | null {
  let body: { error?: NewerThanHouse } | null;
  try {
    body = JSON.parse(text) as { error?: NewerThanHouse } | null;
  } catch {
    return null;
  }
  return body?.error?.code === 'kit_newer_than_house' ? body.error : null;
}

export function endUnserved(text: string): void {
  if (refusalOf(text)?.code === 'kit_update_required') updateRequired();
  const refused = newer(text);
  if (refused !== null) newerThanHouse(refused.release, refused.commands[machine()]);
}

import { refusalOf } from './refusals.ts';

export const KIT_WIRE = 1;
export const KIT_WIRE_HEADER = 'x-house-kit-wire';

export function tooOld(text: string): boolean {
  return refusalOf(text)?.code === 'kit_update_required';
}

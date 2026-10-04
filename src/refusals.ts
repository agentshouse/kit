import { parse } from 'yaml';

export interface Refusal {
  code: string;
  text: string;
  conflicts: string[];
}

const HEAD = /^([a-z][a-z0-9_]*): \S/;

function conflictCodes(detail: string): string[] {
  let parsed: unknown;
  try {
    parsed = parse(detail);
  } catch {
    return [];
  }
  const conflicts = (parsed as { conflicts?: unknown } | null)?.conflicts;
  if (!Array.isArray(conflicts)) return [];
  return conflicts.flatMap((conflict: { code?: unknown } | null) =>
    typeof conflict?.code === 'string' ? [conflict.code] : [],
  );
}

function spoken(text: string): Refusal | null {
  const head = HEAD.exec(text);
  if (head === null) return null;
  const said = text.replace(/\n+$/, '');
  const detail = said.indexOf('\n');
  return { code: head[1]!, text: said, conflicts: detail === -1 ? [] : conflictCodes(said.slice(detail + 1)) };
}

export function refusalOf(text: string): Refusal | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return spoken(text);
  }
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error !== 'object' || error === null) return null;
  const { code, message, data } = error as { code?: unknown; message?: unknown; data?: { code?: unknown } };
  const said = typeof message === 'string' ? spoken(message) : null;
  if (said !== null) return said;
  const named = typeof code === 'string' ? code : typeof data?.code === 'string' ? data.code : null;
  return named === null ? null : { code: named, text: named, conflicts: [] };
}

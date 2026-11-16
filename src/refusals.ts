import { parse } from 'yaml';

export interface Conflict {
  code: string;
  path: string;
}

export interface Refusal {
  code: string;
  text: string;
  conflicts: Conflict[];
  detail: Record<string, unknown>;
}

const HEAD = /^([a-z][a-z0-9_]*): \S/;

const PUSH_STOPS = new Set(['limit_reached', 'cap_reached']);

function detailOf(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return {};
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function conflictsOf(detail: Record<string, unknown>): Conflict[] {
  if (!Array.isArray(detail.conflicts)) return [];
  return detail.conflicts.flatMap((conflict: { code?: unknown; path?: unknown } | null) =>
    typeof conflict?.code === 'string' ? [{ code: conflict.code, path: typeof conflict.path === 'string' ? conflict.path : '' }] : [],
  );
}

function spoken(text: string): Refusal | null {
  const head = HEAD.exec(text);
  if (head === null) return null;
  const said = text.replace(/\n+$/, '');
  const line = said.indexOf('\n');
  const detail = line === -1 ? {} : detailOf(said.slice(line + 1));
  return { code: head[1]!, text: said, conflicts: conflictsOf(detail), detail };
}

export function stopsPush(refusal: Refusal | null): boolean {
  return refusal !== null && PUSH_STOPS.has(refusal.code);
}

export function firstLine(refusal: Refusal): string {
  return refusal.text.split('\n')[0]!;
}

export function retryable(text: string): boolean | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const error = (body as { error?: { retryable?: unknown; data?: { retryable?: unknown } | null } | null } | null)?.error;
  const verdict = error?.retryable ?? error?.data?.retryable;
  return typeof verdict === 'boolean' ? verdict : null;
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
  return named === null ? null : { code: named, text: named, conflicts: [], detail: {} };
}

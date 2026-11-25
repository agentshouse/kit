import { parse } from 'yaml';

export interface Conflict {
  code: string;
  path: string;
  revision?: string;
  content?: string;
}

export interface Refusal {
  code: string;
  text: string;
  conflicts: Conflict[];
  detail: Record<string, unknown>;
  retryable?: boolean;
}

interface Answered {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  retry_after?: unknown;
  data?: { code?: unknown; retryable?: unknown; retry_after?: unknown } | null;
}

export class PlaceRefused extends Error {}

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
  return detail.conflicts.flatMap((conflict: { code?: unknown; path?: unknown; revision?: unknown; content?: unknown; cut?: unknown } | null) =>
    typeof conflict?.code === 'string'
      ? [
          {
            code: conflict.code,
            path: typeof conflict.path === 'string' ? conflict.path : '',
            ...(typeof conflict.revision === 'string' ? { revision: conflict.revision } : {}),
            ...(typeof conflict.content === 'string' && conflict.cut === undefined ? { content: conflict.content } : {}),
          },
        ]
      : [],
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
  return refusal !== null && PUSH_STOPS.has(refusal.code) && refusal.retryable === true;
}

export function firstLine(refusal: Refusal): string {
  return refusal.text.split('\n')[0]!;
}

export const REFUSAL_HEADER = 'x-house-refusal';

function parsed(text: string): { body: unknown } | null {
  try {
    return { body: JSON.parse(text) };
  } catch {
    return null;
  }
}

function errorIn(body: unknown): Answered | null {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'object' && error !== null ? (error as Answered) : null;
}

function verdictOf(error: Answered | null): boolean | null {
  const verdict = error?.retryable ?? error?.data?.retryable;
  return typeof verdict === 'boolean' ? verdict : null;
}

export function retryable(text: string): boolean | null {
  const answer = parsed(text);
  return answer === null ? null : verdictOf(errorIn(answer.body));
}

export function namedWait(text: string): number | null {
  const answer = parsed(text);
  const error = answer === null ? null : errorIn(answer.body);
  if (verdictOf(error) === null) return null;
  const seconds = error?.retry_after ?? error?.data?.retry_after;
  return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : null;
}

export function refusalOf(text: string): Refusal | null {
  const answer = parsed(text);
  if (answer === null) return spoken(text);
  const error = errorIn(answer.body);
  if (error === null) return null;
  const { code, message, data, retryable: _retryable, ...fields } = error as Answered & Record<string, unknown>;
  const verdict = verdictOf(error);
  const judged = verdict === null ? {} : { retryable: verdict };
  const said = typeof message === 'string' ? spoken(message) : null;
  if (said !== null) {
    const detail = { ...said.detail, ...fields };
    return { ...said, detail, conflicts: conflictsOf(detail), ...judged };
  }
  const named = typeof code === 'string' ? code : typeof data?.code === 'string' ? data.code : null;
  return named === null ? null : { code: named, text: named, conflicts: [], detail: {}, ...judged };
}

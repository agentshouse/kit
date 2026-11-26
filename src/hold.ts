import { relayed } from './relay.ts';
import { retryable } from './refusals.ts';

export interface Pass {
  readonly round: number;
  readonly probe: boolean;
  readonly held: boolean;
}

export interface Answer {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly own: boolean;
}

export class Superseded extends Error {}

export function judgement(status: number, retryAfter: string | null, said: string | null): Answer {
  return { status, retryAfter, own: status < 400 || (said !== null && retryable(said) !== null) };
}

export const THROUGH = judgement(200, null, null);

// A 429 that names no time first holds the Kit's calls for two minutes, about as long as a rate limit of what carries them lasts.
const FIRST_HOLD_MS = 120_000;
// Each further such answer doubles the hold up to a quarter hour, so a limit that lasts the day, as the Kit relay's daily allowance does, costs four requests an hour and one that lifts is found within fifteen minutes.
const HOLD_CAP_MS = 900_000;

let until = 0;
let steps = 0;
let round = 0;
let probing = false;
let waiters: (() => void)[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function wake(): void {
  const woken = waiters;
  waiters = [];
  timer?.unref();
  for (const resume of woken) resume();
}

function ended(): void {
  timer = null;
  const left = until - Date.now();
  if (left <= 0) {
    wake();
    return;
  }
  // A hold looks again at the time it names, since an answer that came meanwhile may have moved that time.
  timer = setTimeout(ended, left);
  if (waiters.length === 0) timer.unref();
}

function holdUntil(at: number): void {
  if (at <= until) return;
  until = at;
  round++;
  if (timer !== null) clearTimeout(timer);
  ended();
}

export function retryAt(value: string | null): number | null {
  if (value === null) return null;
  const at = /^\s*\d+\s*$/u.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function waited(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      waiters = waiters.filter((waiter) => waiter !== resume);
      if (waiters.length === 0) timer?.unref();
      reject(signal!.reason);
    };
    const resume = () => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    };
    waiters.push(resume);
    timer?.ref();
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export function holding(): boolean {
  return Date.now() < until;
}

export async function held(signal?: AbortSignal): Promise<Pass> {
  let waiting = false;
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() >= until && !(steps > 0 && probing)) break;
    waiting = true;
    await waited(signal);
  }
  if (steps > 0) probing = true;
  return { round, probe: steps > 0, held: waiting };
}

export function answered(pass: Pass, answer: Answer | null): void {
  if (pass.probe) probing = false;
  if (answer?.own === true) {
    if (pass.round === round) steps = 0;
  } else if (answer !== null) {
    const at = retryAt(answer.retryAfter);
    if (at !== null) holdUntil(at);
    else if (answer.status === 429 && pass.round === round) {
      holdUntil(Date.now() + Math.min(HOLD_CAP_MS, FIRST_HOLD_MS * 2 ** steps));
      steps++;
    }
  }
  wake();
}

export function passed(pass: Pass): void {
  if (!pass.probe) return;
  probing = false;
  wake();
}

export async function judged(answer: Response): Promise<Answer> {
  return judgement(answer.status, answer.headers.get('retry-after'), answer.ok ? null : await answer.clone().text());
}

export async function carried(target: string | URL, init: RequestInit = {}, current: () => boolean = () => true): Promise<Response> {
  const signal = init.signal ?? undefined;
  const pass = await held(signal);
  if (pass.held && !current()) {
    passed(pass);
    throw new Superseded(`${new URL(target).pathname} is no longer current once House can be called again`);
  }
  let answer: Response;
  try {
    answer = await fetch(relayed(target), init);
  } catch (error) {
    if (signal?.aborted === true) passed(pass);
    else answered(pass, null);
    throw error;
  }
  let judgement: Answer | null = null;
  try {
    judgement = await judged(answer);
  } finally {
    answered(pass, judgement);
  }
  return answer;
}

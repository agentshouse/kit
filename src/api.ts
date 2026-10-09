import { setTimeout as delay } from 'node:timers/promises';
import { end, SIGN_IN_AGAIN } from './end.ts';
import { readEnrolment } from './home.ts';
import { retryable } from './refusals.ts';
import { relayed } from './relay.ts';

export class HouseRefusal extends Error {
  readonly status: number;
  readonly text: string;

  constructor(path: string, status: number, text: string) {
    super(`House refused ${path} with ${status}: ${text}`);
    this.status = status;
    this.text = text;
  }
}

export function finalRefusal(error: unknown): error is HouseRefusal {
  return error instanceof HouseRefusal && retryable(error.text) === false;
}

export function retryDelay(attempt: number): number {
  // Full jitter, doubling from one second to a 30-second cap, spreads the Kits one outage dropped and retries within half a minute of House's return.
  return Math.random() * Math.min(30_000, 1000 * 2 ** attempt);
}

export async function retrying<T>(sent: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sent();
    } catch (error) {
      if (!(error instanceof HouseRefusal) || retryable(error.text) !== true) throw error;
    }
    // A request House refused as retryable is sent again on the jittered curve.
    await delay(retryDelay(attempt), undefined, { signal });
  }
}

export async function post<T>(
  house: string,
  path: string,
  body: unknown,
  credential?: string,
  signal?: AbortSignal,
): Promise<T> {
  const answer = await fetch(relayed(new URL(path, house)), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await answer.text();
  if (!answer.ok) throw new HouseRefusal(path, answer.status, text);
  return JSON.parse(text) as T;
}

export interface House {
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
  deliver<T>(path: string, body: unknown, current?: () => boolean): Promise<T>;
}

async function enrolledPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const { house, credential } = (await readEnrolment())!;
  try {
    return await post<T>(house, path, body, credential, signal);
  } catch (error) {
    if (error instanceof HouseRefusal && error.status === 401) end(SIGN_IN_AGAIN);
    throw error;
  }
}

export const house: House = {
  post: enrolledPost,
  deliver: async <T>(path: string, body: unknown, current = () => true): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await enrolledPost<T>(path, body);
      } catch (error) {
        if (finalRefusal(error)) throw error;
        process.stderr.write(`kit: ${path} did not reach House: ${(error as Error).message}\n`);
        // A delivery House did not take is sent again on the jittered curve for as long as it is still current.
        await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
        if (!current()) throw error;
      }
    }
  },
};

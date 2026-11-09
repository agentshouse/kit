import {
  KIT_WIRE,
  KIT_WIRE_HEADER,
  type KitActAnswer,
  type KitActName,
  type KitActRequest,
  type KitDoorAct,
} from '@agentshouse/kit-wire';
import { setTimeout as delay } from 'node:timers/promises';
import { signInAgain } from './end.ts';
import { readEnrolment } from './home.ts';
import { retryable } from './refusals.ts';
import { relayed } from './relay.ts';
import { endUnserved } from './wire.ts';

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
  // Full jitter, doubling from one second to a 30-second cap, spreads the Kit processes one outage dropped and retries within half a minute of House's return.
  return Math.random() * Math.min(30_000, 1000 * 2 ** attempt);
}

export async function retrying<T>(sent: () => Promise<T>, signal?: AbortSignal, pause = retryDelay): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sent();
    } catch (error) {
      if (!(error instanceof HouseRefusal) || retryable(error.text) !== true) throw error;
    }
    // A request House refused as retryable is sent again after the caller's pause, the jittered curve unless it names its own.
    await delay(pause(attempt), undefined, { signal });
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
      [KIT_WIRE_HEADER]: KIT_WIRE,
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await answer.text();
  if (!answer.ok) endUnserved(text);
  if (!answer.ok) throw new HouseRefusal(path, answer.status, text);
  return JSON.parse(text) as T;
}

export function kitAct<Name extends KitActName>(
  house: string,
  act: Name,
  request: KitActRequest<Name>,
  credential: string,
  signal?: AbortSignal,
): Promise<KitActAnswer<Name>> {
  return post(house, `/kit/${act}`, request, credential, signal);
}

export interface House {
  act<Name extends KitActName>(act: Name, request: KitActRequest<Name>, signal?: AbortSignal): Promise<KitActAnswer<Name>>;
  door<T>(act: KitDoorAct, body: object, signal?: AbortSignal): Promise<T>;
  deliver<Name extends KitActName>(act: Name, request: KitActRequest<Name>, current?: () => boolean): Promise<KitActAnswer<Name>>;
}

async function enrolledPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const { house, credential } = (await readEnrolment())!;
  try {
    return await post<T>(house, path, body, credential, signal);
  } catch (error) {
    if (error instanceof HouseRefusal && error.status === 401) await signInAgain(credential);
    throw error;
  }
}

export const house: House = {
  act: (act, request, signal) => enrolledPost(`/kit/${act}`, request, signal),
  door: (act, body, signal) => enrolledPost(`/kit/door/${act}`, body, signal),
  deliver: async (act, request, current = () => true) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await enrolledPost(`/kit/${act}`, request);
      } catch (error) {
        if (finalRefusal(error)) throw error;
        process.stderr.write(`kit: /kit/${act} did not reach House: ${(error as Error).message}\n`);
        // A delivery House did not take is sent again on the jittered curve for as long as it is still current.
        await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
        if (!current()) throw error;
      }
    }
  },
};

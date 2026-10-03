import { readEnrolment } from './home.ts';

export class HouseRefusal extends Error {
  readonly status: number;

  constructor(path: string, status: number, text: string) {
    super(`House refused ${path} with ${status}: ${text}`);
    this.status = status;
  }
}

export async function post<T>(house: string, path: string, body: unknown, credential?: string): Promise<T> {
  const answer = await fetch(new URL(path, house), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await answer.text();
  if (!answer.ok) throw new HouseRefusal(path, answer.status, text);
  return JSON.parse(text) as T;
}

export interface House {
  post<T>(path: string, body: unknown): Promise<T>;
  deliver<T>(path: string, body: unknown, current?: () => boolean): Promise<T>;
}

async function enrolledPost<T>(path: string, body: unknown): Promise<T> {
  const { house, credential } = (await readEnrolment())!;
  return post<T>(house, path, body, credential);
}

export const house: House = {
  post: enrolledPost,
  deliver: async <T>(path: string, body: unknown, current = () => true): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await enrolledPost<T>(path, body);
      } catch (error) {
        if (error instanceof HouseRefusal && error.status < 500) throw error;
        process.stderr.write(`kit: ${path} did not reach House: ${(error as Error).message}\n`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt)));
        if (!current()) throw error;
      }
    }
  },
};

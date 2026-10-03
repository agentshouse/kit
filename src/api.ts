export class HouseRefusal extends Error {
  readonly status: number;
  readonly answer: unknown;

  constructor(path: string, status: number, answer: unknown) {
    super(`House refused ${path} with ${status}: ${JSON.stringify(answer)}`);
    this.status = status;
    this.answer = answer;
  }
}

export async function post<T>(
  house: string,
  path: string,
  body: unknown,
  credential?: string,
): Promise<T> {
  const answer = await fetch(new URL(path, house), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await answer.text();
  let parsed: unknown = text;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {}
  if (!answer.ok) throw new HouseRefusal(path, answer.status, parsed);
  return parsed as T;
}

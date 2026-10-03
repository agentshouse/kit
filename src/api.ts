export async function post<T>(house: string, path: string, body: unknown): Promise<T> {
  const answer = await fetch(new URL(path, house), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await answer.text();
  if (!answer.ok) throw new Error(`House refused ${path} with ${answer.status}: ${text}`);
  return JSON.parse(text) as T;
}

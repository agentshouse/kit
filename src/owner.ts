import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { received } from './bridge.ts';
import { kitHome, ownerLock, ownerSocket } from './home.ts';

interface Running {
  pid: number;
  release?: string;
}

function claimed(lock: DatabaseSync): boolean {
  try {
    lock.exec('BEGIN EXCLUSIVE');
    return true;
  } catch (error) {
    if ((error as { errcode?: number }).errcode === 5) return false;
    throw error;
  }
}

export function askOwner<T>(path: string, body?: unknown): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const sent = request(
      { socketPath: ownerSocket(), path, method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' } },
      (answer) => {
        received(answer).then((text) => {
          if (answer.statusCode === 200) resolve(JSON.parse(text) as T);
          else reject(new Error(text));
        }, reject);
      },
    );
    sent.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(null);
      else reject(error);
    });
    sent.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function holdOwner(): Promise<DatabaseSync> {
  const lock = new DatabaseSync(ownerLock());
  if (claimed(lock)) return lock;
  lock.close();
  const running = (await askOwner<Running>('/resident'))?.pid ?? null;
  throw new Error(
    `${running === null ? 'another Kit process' : `Kit process ${running}`} already runs this Environment from Kit home ${kitHome()}; stop it first to run another Kit process here`,
  );
}

export async function runningRelease(): Promise<string | null> {
  const running = await askOwner<Running>('/resident');
  return running === null ? null : (running.release ?? '');
}

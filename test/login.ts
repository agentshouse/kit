import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { House } from './double.ts';
import { runKit } from './kit.ts';

export const LOGIN = '0199d0a1-6b2c-7e3f-8a4b-5c6d7e8f9a0b';

const REJECTED = { status: 400, body: { error: { code: 'kit_login_rejected', retryable: false } } };

export function loginLink(house: House): string {
  return `${house.origin}/kit/ahk_login_one`;
}

export interface Served {
  own?: string;
  user?: string;
  waiting?: boolean;
  busy?: number;
}

export function serveLogin(
  house: House,
  environment: string,
  credential: string,
  { own, user = 'user-one', waiting = false, busy = 0 }: Served = {},
) {
  let refusals = busy;
  let challenge = '';
  let confirmed = !waiting;
  let ended = false;
  house.route('POST', '/kit', ({ body }) => {
    if (refusals-- > 0) return { status: 503, body: { error: { code: 'kit_environment_unavailable', retryable: true } } };
    challenge = (body as { code_challenge: string }).code_challenge;
    return { body: { start_url: loginLink(house), login: LOGIN } };
  });
  house.route('POST', '/kit/token', ({ body }) => {
    const { login, code_verifier } = body as { login: string; code_verifier: string };
    const proved = createHash('sha256').update(code_verifier).digest('base64url') === challenge;
    if (login !== LOGIN || !proved || ended) return REJECTED;
    if (!confirmed) return { status: 400, body: { error: { code: 'kit_login_pending', retryable: true } } };
    ended = true;
    return {
      body: { credential, environment, user, ...(own === undefined ? {} : { headless_credential: own }) },
    };
  });
  return {
    confirm: () => {
      confirmed = true;
    },
    end: () => {
      ended = true;
    },
  };
}

export function answerOwnAgent(house: House, live: string) {
  house.route('POST', '/', ({ headers }) =>
    headers.authorization === `Bearer ${live}`
      ? { body: { jsonrpc: '2.0', id: 1, result: { tools: [] } } }
      : { status: 401, body: {} },
  );
}

export async function ownAgent(home: string): Promise<unknown> {
  return JSON.parse(await readFile(join(home, 'own-agent.json'), 'utf8'));
}

export async function opener(home: string, fails = false): Promise<{ path: string; opened: () => Promise<string | undefined> }> {
  const bin = join(home, 'opener');
  await mkdir(bin);
  const log = join(home, 'opened');
  await writeFile(join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${fails ? 'exit 1\n' : ''}`);
  await chmod(join(bin, 'xdg-open'), 0o755);
  return { path: `${bin}:${process.env.PATH}`, opened: () => readFile(log, 'utf8').catch(() => undefined) };
}

export async function logIn(house: House, home: string, environment: Record<string, string> = {}) {
  house.requests.length = 0;
  const login = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home, ...environment });
  const exit = await login.exited;
  const started = house.requests.find((request) => request.path === '/kit');
  return { started: started?.body as Record<string, unknown>, exit, login };
}

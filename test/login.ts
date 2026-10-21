import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { House } from './double.ts';
import { runKit } from './kit.ts';

export const LOGIN = '0199d0a1-6b2c-7e3f-8a4b-5c6d7e8f9a0b';

const REJECTED = { status: 400, body: { error: { code: 'kit_login_rejected', retryable: false } } };

const UNDECLARED = { status: 422, body: { error: { code: 'kit_declaration_invalid', retryable: false } } };

const START_FIELDS = ['act', 'environment_id', 'replaces', 'headless', 'rooms', 'code_challenge'];

const POLL_FIELDS = ['login', 'code_verifier'];

const ENTERED_NAME = 'Work laptop';

function undeclared(body: unknown, fields: string[]): boolean {
  return Object.keys(body as object).some((field) => !fields.includes(field));
}

export function loginLink(house: House): string {
  return `${house.origin}/kit/ahk_login_one`;
}

export interface Served {
  own?: string;
  user?: string;
  waiting?: boolean;
  busy?: number;
  gone?: string;
}

export function serveLogin(
  house: House,
  environment: string,
  credential: string,
  { own, user = 'user-one', waiting = false, busy = 0, gone }: Served = {},
) {
  let refusals = busy;
  let challenge = '';
  let act = '';
  let entered: string | null = waiting ? null : ENTERED_NAME;
  let ended = false;
  const settled: { act: string; environment: string; name?: string }[] = [];
  house.route('POST', '/kit', ({ body }) => {
    if (undeclared(body, START_FIELDS)) return UNDECLARED;
    if (refusals-- > 0) return { status: 503, body: { error: { code: 'kit_environment_unavailable', retryable: true } } };
    if (gone !== undefined && (body as { environment_id?: string }).environment_id === gone) {
      return { status: 404, body: { error: { code: 'kit_environment_not_found', retryable: false } } };
    }
    act = (body as { act: string }).act;
    challenge = (body as { code_challenge: string }).code_challenge;
    return { body: { start_url: loginLink(house), login: LOGIN } };
  });
  house.route('POST', '/kit/token', ({ body }) => {
    if (undeclared(body, POLL_FIELDS)) return UNDECLARED;
    const { login, code_verifier } = body as { login: string; code_verifier: string };
    const proved = createHash('sha256').update(code_verifier).digest('base64url') === challenge;
    if (login !== LOGIN || !proved || ended) return REJECTED;
    if (entered === null) return { status: 400, body: { error: { code: 'kit_login_pending', retryable: true } } };
    ended = true;
    settled.push(act === 'new_environment' ? { act, environment, name: entered } : { act, environment });
    return {
      body: { credential, environment, user, ...(own === undefined ? {} : { headless_credential: own }) },
    };
  });
  return {
    settled,
    confirm: (name = ENTERED_NAME) => {
      entered = name;
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

export async function logIn(house: House, home: string, environment: Record<string, string> = {}, argv: string[] = []) {
  house.requests.length = 0;
  const login = runKit(['login', '--house', house.origin, ...argv], { HOUSE_KIT_HOME: home, ...environment });
  const exit = await login.exited;
  const started = house.requests.find((request) => request.path === '/kit');
  return { started: started?.body as Record<string, unknown>, exit, login };
}

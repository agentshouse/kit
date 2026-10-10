import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { until, type House } from './double.ts';
import { runKit } from './kit.ts';

export function serveLogin(house: House, environment: string, credential: string, own?: string, user = 'user-one') {
  let challenge = '';
  house.route('POST', '/kit', ({ body }) => {
    challenge = (body as { code_challenge: string }).code_challenge;
    return { body: { start_url: `${house.origin}/kit/ahk_login_one` } };
  });
  house.route('POST', '/kit/token', ({ body }) => {
    const { code, code_verifier } = body as { code: string; code_verifier: string };
    const proved = createHash('sha256').update(code_verifier).digest('base64url') === challenge;
    if (code !== 'ahk_code_one' || !proved) {
      return { status: 400, body: { error: { code: 'kit_login_rejected', retryable: false } } };
    }
    return {
      body: { credential, environment, user, ...(own === undefined ? {} : { headless_credential: own }) },
    };
  });
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

export async function confirm(house: House, home: string, environment: Record<string, string> = {}) {
  house.requests.length = 0;
  const login = runKit(['login', '--house', house.origin], { HOUSE_KIT_HOME: home, ...environment });
  const started = await until(() => house.requests.find((request) => request.path === '/kit'));
  await until(() => login.stdout().includes(`${house.origin}/kit/ahk_login_one`));
  const { loopback_uri } = started.body as { loopback_uri: string };
  const browser = await (await fetch(`${loopback_uri}?code=ahk_code_one`)).text();
  return { started: started.body as Record<string, unknown>, browser, exit: await login.exited, login };
}

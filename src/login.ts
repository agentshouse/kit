import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { post } from './api.ts';
import { readEnrolment, writeEnrolment } from './home.ts';

const DEFAULT_HOUSE = 'https://agents.house';

interface Exchanged {
  credential: string;
  environment: string;
}

interface Callback {
  uri: string;
  code: Promise<string>;
}

function listen(): Promise<Callback> {
  return new Promise((resolve, reject) => {
    let deliver: (code: string) => void = () => undefined;
    const code = new Promise<string>((settle) => {
      deliver = settle;
    });
    const server = createServer((request, response) => {
      const received = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('code');
      if (received === null) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
        .end('This Environment is connected. You can close this tab.\n', () => {
          server.close();
          server.closeAllConnections();
        });
      deliver(received);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the login callback has no port'));
        return;
      }
      resolve({ uri: `http://127.0.0.1:${address.port}/callback`, code });
    });
  });
}

async function typed(question: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await reader.question(question)).trim();
  } finally {
    reader.close();
  }
}

export async function login(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      house: { type: 'string' },
      environment: { type: 'string' },
      manual: { type: 'boolean', default: false },
    },
  });
  const enrolled = await readEnrolment();
  const house = values.house ?? enrolled?.house ?? DEFAULT_HOUSE;
  const environment =
    values.environment ?? (enrolled?.house === house ? enrolled.environment : undefined);
  const verifier = randomBytes(32).toString('base64url');
  const act =
    environment === undefined
      ? { act: 'new_environment', label: hostname() }
      : { act: 'existing_environment', environment_id: environment };
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  let code: string;
  if (values.manual) {
    const { start_url } = await post<{ start_url: string }>(house, '/kit', {
      ...act,
      code_challenge: challenge,
      presentation: 'manual',
    });
    process.stdout.write(`Open this link and confirm: ${start_url}\n`);
    code = await typed('Code: ');
  } else {
    const callback = await listen();
    const { start_url } = await post<{ start_url: string }>(house, '/kit', {
      ...act,
      code_challenge: challenge,
      presentation: 'loopback',
      loopback_uri: callback.uri,
    });
    process.stdout.write(`Open this link and confirm: ${start_url}\n`);
    code = await callback.code;
  }

  const exchanged = await post<Exchanged>(house, '/kit/token', {
    code,
    code_verifier: verifier,
  });
  await writeEnrolment({
    house,
    environment: exchanged.environment,
    credential: exchanged.credential,
  });
  process.stdout.write(`Environment ${exchanged.environment} is connected to ${house}.\n`);
}

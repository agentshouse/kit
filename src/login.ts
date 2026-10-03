import { createHash, randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
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
  answer(text: string): Promise<void>;
  close(): void;
}

function listen(): Promise<Callback> {
  return new Promise((resolve, reject) => {
    let deliver: (code: string) => void = () => undefined;
    let held: ServerResponse | null = null;
    const code = new Promise<string>((settle) => {
      deliver = settle;
    });
    const server = createServer((request, response) => {
      const received = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('code');
      if (received === null || held !== null) {
        response.writeHead(404).end();
        return;
      }
      held = response;
      deliver(received);
    });
    const close = () => {
      server.close();
      server.closeAllConnections();
    };
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the login callback has no port'));
        return;
      }
      resolve({
        uri: `http://127.0.0.1:${address.port}/callback`,
        code,
        answer: (text) =>
          new Promise((written) => {
            if (held === null) return written();
            held
              .writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
              .end(`${text}\n`, written);
          }),
        close,
      });
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
  const started = {
    ...(environment === undefined
      ? { act: 'new_environment', label: hostname() }
      : { act: 'existing_environment', environment_id: environment }),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  };

  const exchange = async (code: string) => {
    const exchanged = await post<Exchanged>(house, '/kit/token', { code, code_verifier: verifier });
    await writeEnrolment({ house, environment: exchanged.environment, credential: exchanged.credential });
    process.stdout.write(`Environment ${exchanged.environment} is connected to ${house}.\n`);
  };

  if (values.manual) {
    const { start_url } = await post<{ start_url: string }>(house, '/kit', {
      ...started,
      presentation: 'manual',
    });
    process.stdout.write(`Open this link and confirm: ${start_url}\n`);
    await exchange(await typed('Code: '));
    return;
  }

  const callback = await listen();
  try {
    const { start_url } = await post<{ start_url: string }>(house, '/kit', {
      ...started,
      presentation: 'loopback',
      loopback_uri: callback.uri,
    });
    process.stdout.write(`Open this link and confirm: ${start_url}\n`);
    try {
      await exchange(await callback.code);
    } catch (error) {
      await callback.answer(`This Environment was not connected: ${(error as Error).message}`);
      throw error;
    }
    await callback.answer('This Environment is connected. You can close this tab.');
  } finally {
    callback.close();
  }
}

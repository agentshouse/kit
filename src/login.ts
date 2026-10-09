import { createHash, randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { post } from './api.ts';
import { forgetOwnAgent, readDisconnected, readEnrolment, readOwnAgent, writeEnrolment, writeOwnAgent } from './home.ts';
import { callHouse, rpc } from './mcp.ts';

const DEFAULT_HOUSE = 'https://agents.house';

interface Exchanged {
  credential: string;
  environment: string;
  user: string;
  headless_credential?: string;
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
    const port = Number(process.env.HOUSE_KIT_LOGIN_PORT ?? 0);
    server.once('error', reject);
    server.listen(port, port === 0 ? '127.0.0.1' : '0.0.0.0', () => {
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
            if (held === null || held.destroyed || !held.socket || held.socket.destroyed) return written();
            held.once('close', () => written());
            held.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(`${text}\n`);
          }),
        close,
      });
    });
  });
}

async function accepted(house: string, credential: string): Promise<boolean> {
  const checked = await callHouse(house, credential, rpc('tools/list', {}));
  if (checked.status === 200) return true;
  if (checked.status === 401) return false;
  throw new Error(`House answered ${checked.status} when Kit checked this computer's own agent's connection: ${checked.text}`);
}

async function typed(question: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<never>((_, reject) => {
    reader.once('close', () => reject(new Error('no code was typed')));
  });
  try {
    return (await Promise.race([reader.question(question), closed])).trim();
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
  const enrolled = (await readEnrolment()) ?? (await readDisconnected());
  const house = values.house ?? enrolled?.house ?? DEFAULT_HOUSE;
  const replaces = process.env.HOUSE_KIT_REPLACES;
  const environment =
    replaces === undefined ? (values.environment ?? (enrolled?.house === house ? enrolled.environment : undefined)) : undefined;
  const ownAgent = await readOwnAgent();
  const held = ownAgent !== null && ownAgent.house === house && (await accepted(house, ownAgent.credential));
  const verifier = randomBytes(32).toString('base64url');
  const started = {
    ...(environment === undefined
      ? { act: 'new_environment', label: hostname(), ...(replaces === undefined ? {} : { replaces }) }
      : { act: 'existing_environment', environment_id: environment }),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ...(held ? {} : { headless: true }),
  };

  const exchange = async (code: string) => {
    const exchanged = await post<Exchanged>(house, '/kit/token', { code, code_verifier: verifier });
    await writeEnrolment({ house, environment: exchanged.environment, credential: exchanged.credential });
    process.stdout.write(`Environment ${exchanged.environment} is connected to ${house}.\n`);
    if (exchanged.headless_credential !== undefined) {
      await writeOwnAgent({ house, user: exchanged.user, credential: exchanged.headless_credential });
    } else if (held && ownAgent.user !== exchanged.user) {
      await forgetOwnAgent();
      process.stdout.write("This computer's own agent was another User's; run kit login again to connect it to you.\n");
    }
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

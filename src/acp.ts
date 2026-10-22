import {
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientApp,
  type ClientConnection,
  type InitializeResponse,
} from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { CLIS, KIT_RELEASE, adapterCommand } from './clis.ts';
import type { Message } from './events.ts';
import { childEnvironment } from './relay.ts';
import { killTree, type Scope } from './scope.ts';

export interface Adapter {
  connection: ClientConnection;
  initialized: InitializeResponse;
  exited: Promise<string>;
  lost: Promise<string>;
  retire(): void;
}

const RETIRED = 'the CLI was retired';

export async function startAdapter(
  kind: string,
  cli: string,
  cwd: string,
  app: ClientApp,
  events: (message: Message) => void = () => undefined,
  added: Record<string, string> = {},
  signal?: AbortSignal,
  scope: Scope | null = null,
): Promise<Adapter> {
  const adapter = CLIS[kind]!.adapter;
  const started: [string, string[]] = [adapter === null ? cli : adapterCommand(kind), CLIS[kind]!.args];
  const [command, args] = scope?.command(...started) ?? started;
  const child = spawn(command, args, {
    cwd,
    env: { ...childEnvironment(), ...(adapter === null ? {} : { ...adapter.env, [adapter.executable]: cli }), ...added },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let owned = true;
  let retired = false;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect({
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          const read = message as Message;
          if (owned) events(read);
          if (read.id !== undefined || (read.method !== 'session/update' && !read.method!.startsWith('_'))) {
            controller.enqueue(message);
          }
        },
      }),
    ),
  });
  const { promise: lost, resolve: lose } = Promise.withResolvers<string>();
  const exited = new Promise<string>((resolve) => {
    const end = (cause: string) => {
      if (owned) lose(cause);
      owned = false;
      connection.close(new Error(cause));
      resolve(cause);
    };
    child.on('error', (error) => end(`the CLI did not start: ${error.message}`));
    child.on('exit', (code, signal) => {
      const last = stderr.trim().split('\n').at(-1);
      end(`the CLI exited with ${code ?? signal}${last ? `: ${last}` : ''}`);
    });
  });
  const retire = () => {
    owned = false;
    if (retired) return;
    retired = true;
    if (child.pid !== undefined) killTree(child);
    scope?.kill();
    connection.close(new Error(RETIRED));
  };
  signal?.addEventListener('abort', retire, { once: true });
  child.on('exit', () => signal?.removeEventListener('abort', retire));
  try {
    const initialized = await connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
        session: { compaction: {}, notices: {} },
        _meta: { jetbrains: { air: { version: 1, capabilities: CLIS[kind]!.air } } },
      },
      clientInfo: { name: '@agentshouse/kit', version: KIT_RELEASE },
    });
    scope?.entered(child.pid!);
    return { connection, initialized, exited, lost, retire };
  } catch (error) {
    retire();
    throw error;
  }
}

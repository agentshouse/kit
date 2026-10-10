import {
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientApp,
  type ClientConnection,
  type InitializeResponse,
} from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { CLIS, KIT_VERSION, adapterCommand, withoutProxy } from './clis.ts';
import type { Message } from './events.ts';
import { killTree, type Scope } from './scope.ts';

export interface Adapter {
  child: ChildProcess;
  connection: ClientConnection;
  initialized: InitializeResponse;
  exited: Promise<string>;
}

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
    env: { ...withoutProxy(), ...(adapter === null ? {} : { ...adapter.env, [adapter.executable]: cli }), ...added },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const stop = () => killTree(child);
  signal?.addEventListener('abort', stop, { once: true });
  child.on('exit', () => signal?.removeEventListener('abort', stop));
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  const exited = new Promise<string>((resolve) => {
    child.on('error', (error) => resolve(`the CLI did not start: ${error.message}`));
    child.on('exit', (code, signal) => {
      const last = stderr.trim().split('\n').at(-1);
      resolve(`the CLI exited with ${code ?? signal}${last ? `: ${last}` : ''}`);
    });
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
          events(read);
          if (read.id !== undefined || (read.method !== 'session/update' && !read.method!.startsWith('_'))) {
            controller.enqueue(message);
          }
        },
      }),
    ),
  });
  void exited.then((cause) => connection.close(new Error(cause)));
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
      clientInfo: { name: '@agentshouse/kit', version: KIT_VERSION },
    });
    scope?.entered(child.pid!);
    return { child, connection, initialized, exited };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

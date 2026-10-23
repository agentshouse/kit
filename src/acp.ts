import {
  ndJsonStream,
  PROTOCOL_VERSION,
  type AnyMessage,
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
import { Silence } from './silence.ts';

export interface Adapter {
  connection: ClientConnection;
  initialized: InitializeResponse;
  exited: Promise<string>;
  lost: Promise<string>;
  silent(): boolean;
  turn(open: boolean): void;
  retire(): void;
}

const RETIRED = 'the CLI was retired';

// Claude Code ends a shell command or a model request after ten minutes, so a CLI that owes the Kit an answer and sends nothing for half an hour has hung.
export const CLI_SILENCE_MS = 30 * 60_000;

const SILENT = `the CLI sent nothing for ${CLI_SILENCE_MS / 60_000} minutes`;

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
  let silent = false;
  let over = false;
  let open = false;
  let stderr = '';
  const owed = new Set<unknown>();
  const asked = new Set<unknown>();
  const silence = new Silence(CLI_SILENCE_MS, () => {
    silent = true;
    connection.close(new Error(SILENT));
    if (child.pid !== undefined) killTree(child);
  });
  const watch = () => (!over && (owed.size > 0 || open) && asked.size === 0 ? silence.heard() : silence.stop());
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const output = stream.writable.getWriter();
  const connection = app.connect({
    writable: new WritableStream<AnyMessage>({
      write(message) {
        const sent = message as Message;
        if (sent.id !== undefined) {
          if (sent.method === undefined) asked.delete(sent.id);
          else owed.add(sent.id);
          watch();
        }
        return output.write(message);
      },
      close: () => output.close(),
      abort: (reason) => output.abort(reason),
    }),
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          const read = message as Message;
          if (read.id !== undefined) {
            if (read.method === undefined) owed.delete(read.id);
            else asked.add(read.id);
          }
          watch();
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
      over = true;
      silence.stop();
      if (owned) lose(cause);
      owned = false;
      connection.close(new Error(cause));
      resolve(cause);
    };
    child.on('error', (error) => end(`the CLI did not start: ${error.message}`));
    child.on('exit', (code, signal) => {
      const last = stderr.trim().split('\n').at(-1);
      end(silent ? SILENT : `the CLI exited with ${code ?? signal}${last ? `: ${last}` : ''}`);
    });
  });
  const retire = () => {
    owned = false;
    over = true;
    silence.stop();
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
    const turn = (opened: boolean) => {
      open = opened;
      watch();
    };
    return { connection, initialized, exited, lost, silent: () => silent, turn, retire };
  } catch (error) {
    retire();
    throw error;
  }
}

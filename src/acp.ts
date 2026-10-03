import {
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientApp,
  type ClientConnection,
  type InitializeResponse,
} from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { CLIS, KIT_VERSION, cliCommand, type Job, type Notice } from './clis.ts';

export interface Adapter {
  child: ChildProcess;
  connection: ClientConnection;
  initialized: InitializeResponse;
  exited: Promise<string>;
}

export const TURN_STARTED = 'kit/turn_started';
export const TURN_ENDED = 'kit/turn_ended';

export async function startAdapter(
  kind: string,
  cwd: string,
  app: ClientApp,
  jobs: (job: Job) => void = () => undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Adapter> {
  const child = spawn(cliCommand(kind), CLIS[kind]!.args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
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
          const notice = message as Notice;
          const job = CLIS[kind]!.job(notice);
          if (job !== null) jobs(job);
          if (!notice.params?.update?.sessionUpdate?.startsWith('async_task_')) controller.enqueue(message);
          if (CLIS[kind]!.turnStarted(notice)) controller.enqueue({ jsonrpc: '2.0', method: TURN_STARTED });
          if (CLIS[kind]!.turnEnded(notice)) controller.enqueue({ jsonrpc: '2.0', method: TURN_ENDED });
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
        _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } },
      },
      clientInfo: { name: '@agentshouse/kit', version: KIT_VERSION },
    });
    return { child, connection, initialized, exited };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

function parents(): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
    } catch {}
  }
  return children;
}

export function killTree(child: ChildProcess): void {
  const children = parents();
  const tree: number[] = [];
  const pending = [child.pid!];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    tree.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  try {
    process.kill(-child.pid!, 'SIGKILL');
  } catch {}
  for (const pid of tree) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

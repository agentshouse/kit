import {
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientApp,
  type ClientConnection,
  type InitializeResponse,
} from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { CLIS, KIT_VERSION, cliCommand } from './clis.ts';

export interface Adapter {
  child: ChildProcess;
  connection: ClientConnection;
  initialized: InitializeResponse;
  exited: Promise<string>;
}

export async function startAdapter(
  kind: string,
  cwd: string,
  app: ClientApp,
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
  const connection = app.connect(
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  );
  void exited.then((cause) => connection.close(new Error(cause)));
  try {
    const initialized = await connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: '@agentshouse/kit', version: KIT_VERSION },
    });
    return { child, connection, initialized, exited };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

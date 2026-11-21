import { spawn } from 'node:child_process';
import { childEnvironment } from './relay.ts';

export interface Ran {
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

export function run(cwd: string, args: string[], input?: string | Buffer, env: NodeJS.ProcessEnv = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...childEnvironment(), ...env } });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(stdout), stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

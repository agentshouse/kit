import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';

const KIT = fileURLToPath(new URL('../src/kit-main.ts', import.meta.url));

export interface KitRun {
  stdout(): string;
  stderr(): string;
  exited: Promise<number | null>;
}

export async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kit-home-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  return home;
}

export function runKit(argv: string[], environment: Record<string, string>): KitRun {
  const child = spawn(process.execPath, [KIT, ...argv], {
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { stdout: () => stdout, stderr: () => stderr, exited };
}

export async function fakeNpm(home: string): Promise<string> {
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  const npm = join(bin, 'npm');
  await writeFile(npm, `#!/bin/sh\nexec ${process.execPath} ${fileURLToPath(new URL('./npm.ts', import.meta.url))} "$@"\n`);
  await chmod(npm, 0o755);
  return `${bin}:${process.env.PATH}`;
}

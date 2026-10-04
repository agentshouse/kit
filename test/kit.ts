import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';

const KIT = fileURLToPath(new URL('../src/kit-main.ts', import.meta.url));
const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));

export interface KitRun {
  pid: number;
  input: Writable;
  stdout(): string;
  stderr(): string;
  exited: Promise<number | null>;
}

export async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kit-home-'));
  onTestFinished(() => rm(home, { recursive: true, force: true, maxRetries: 10 }));
  return home;
}

export function runKit(argv: string[], environment: Record<string, string>): KitRun {
  const child = spawn(process.execPath, [KIT, ...argv], {
    env: { ...process.env, HOME: environment.HOUSE_KIT_HOME ?? process.env.HOME, ...environment },
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
  return { pid: child.pid!, input: child.stdin, stdout: () => stdout, stderr: () => stderr, exited };
}

export async function fakeBin(home: string): Promise<string> {
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  const npm = join(bin, 'npm');
  await writeFile(npm, `#!/bin/sh\nexec ${process.execPath} ${fileURLToPath(new URL('./npm.ts', import.meta.url))} "$@"\n`);
  await chmod(npm, 0o755);
  await writeFile(join(bin, 'house'), `#!/bin/sh\nexec ${process.execPath} ${HOUSE} "$@"\n`);
  await chmod(join(bin, 'house'), 0o755);
  return `${bin}:${process.env.PATH}`;
}

export const HOST_KEY = 'SHA256:kOo3WBbkkD4lemUHYroV3Ndz9eyygFTzdlqlS/+yLlE';

export async function placeHostKey(home: string): Promise<void> {
  const keygen = join(home, 'bin', 'ssh-keygen');
  await writeFile(
    keygen,
    `#!/bin/sh\n[ "$*" = "-l -E sha256 -f /etc/ssh/ssh_host_ed25519_key.pub" ] || exit 1\necho "256 ${HOST_KEY} root@guest (ED25519)"\n`,
  );
  await chmod(keygen, 0o755);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stop(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

export async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

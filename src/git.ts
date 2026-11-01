import { spawn } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { workspaceRoot } from './home.ts';
import { childEnvironment } from './relay.ts';

export function localCopies(): string {
  return join(workspaceRoot(), 'local-copies');
}

export const HOUSE_REF = 'refs/house/received';

const COMMITTER = 'Kit <house-kit@localhost>';

export interface Ran {
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

type ImportedFile = readonly [string, string | null];

export interface Imported {
  message: string;
  from: string | null;
  merge?: string;
  replaces?: boolean;
  files: Iterable<ImportedFile> | AsyncIterable<ImportedFile>;
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

export async function git(cwd: string, args: string[], input?: string | Buffer, env?: NodeJS.ProcessEnv): Promise<string> {
  const ran = await run(cwd, args, input, env);
  if (ran.status !== 0) throw new Error(`git ${args[0]} failed: ${ran.stderr.trim()}`);
  return ran.stdout.toString('utf8');
}

export async function succeeded(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
  return (await run(cwd, args, undefined, env)).status === 0;
}

export async function revision(cwd: string, name: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--verify', `${name}^{commit}`])).trim();
}

export async function tree(repository: string, commit: string): Promise<Map<string, string>> {
  const listed = await git(repository, ['ls-tree', '-r', '-z', commit]);
  const entries = new Map<string, string>();
  for (const entry of listed.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, type, object] = entry.slice(0, tab).split(' ');
    if (type === 'blob') entries.set(entry.slice(tab + 1), object!);
  }
  return entries;
}

async function blob(repository: string, object: string): Promise<Buffer> {
  return (await run(repository, ['cat-file', 'blob', object])).stdout;
}

export async function blobText(repository: string, object: string): Promise<string> {
  return (await blob(repository, object)).toString('utf8');
}

export async function isText(repository: string, object: string, maxBytes: number): Promise<boolean> {
  const bytes = await blob(repository, object);
  return bytes.length <= maxBytes && isUtf8(bytes) && !bytes.includes(0);
}

export function blobId(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function quoted(path: string): string {
  return `"${path.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n')}"`;
}

function data(text: string): Buffer[] {
  const bytes = Buffer.from(text, 'utf8');
  return [Buffer.from(`data ${bytes.length}\n`), bytes, Buffer.from('\n')];
}

function written(stream: Writable, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

async function imported(stream: Writable, commits: readonly Imported[]): Promise<void> {
  await written(stream, Buffer.from('feature done\n'));
  for (const [index, commit] of commits.entries()) {
    await written(
      stream,
      Buffer.concat([
        Buffer.from(`commit ${HOUSE_REF}\nmark :${index + 1}\ncommitter ${COMMITTER} ${Math.floor(Date.now() / 1000)} +0000\n`),
        ...data(commit.message),
        ...(commit.from === null ? [] : [Buffer.from(`from ${commit.from}\n`)]),
        ...(commit.merge === undefined ? [] : [Buffer.from(`merge ${commit.merge}\n`)]),
        ...(commit.replaces === true ? [Buffer.from('deleteall\n')] : []),
      ]),
    );
    for await (const [path, content] of commit.files) {
      await written(
        stream,
        content === null
          ? Buffer.from(`D ${quoted(path)}\n`)
          : Buffer.concat([Buffer.from(`M 100644 inline ${quoted(path)}\n`), ...data(content)]),
      );
    }
    await written(stream, Buffer.from('\n'));
  }
  await written(stream, Buffer.from('done\n'));
}

export async function importCommits(repository: string, commits: readonly Imported[]): Promise<string> {
  const child = spawn('git', ['fast-import', '--quiet', '--force'], { cwd: repository, env: childEnvironment() });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.stdin.on('error', () => undefined);
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  try {
    await imported(child.stdin, commits);
    child.stdin.end();
  } catch (error) {
    child.stdin.destroy();
    await closed;
    throw (error as NodeJS.ErrnoException).code === 'EPIPE' ? new Error(`git fast-import failed: ${stderr.trim()}`) : error;
  }
  if ((await closed) !== 0) throw new Error(`git fast-import failed: ${stderr.trim()}`);
  return revision(repository, HOUSE_REF);
}

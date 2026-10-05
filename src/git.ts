import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { withoutProxy } from './clis.ts';
import { agentBase } from './home.ts';

export function workingCopies(): string {
  return join(agentBase(), 'working-copies');
}
export const HOUSE_REF = 'refs/house/received';

const COMMITTER = 'House Kit <house-kit@localhost>';

export interface Ran {
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface Imported {
  message: string;
  from: string | null;
  merge?: string;
  replaces?: boolean;
  files: ReadonlyMap<string, string | null>;
}

export function run(cwd: string, args: string[], input?: string | Buffer, env: NodeJS.ProcessEnv = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...withoutProxy(), ...env } });
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

export async function blobText(repository: string, object: string, path: string): Promise<string> {
  const bytes = (await run(repository, ['cat-file', 'blob', object])).stdout;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${path} is binary and House stores only text; remove it from the commit`);
  }
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

export async function importCommits(repository: string, commits: readonly Imported[]): Promise<string> {
  const stream: Buffer[] = [];
  for (const [index, commit] of commits.entries()) {
    stream.push(
      Buffer.from(`commit ${HOUSE_REF}\nmark :${index + 1}\ncommitter ${COMMITTER} ${Math.floor(Date.now() / 1000)} +0000\n`),
      ...data(commit.message),
      ...(commit.from === null ? [] : [Buffer.from(`from ${commit.from}\n`)]),
      ...(commit.merge === undefined ? [] : [Buffer.from(`merge ${commit.merge}\n`)]),
      ...(commit.replaces === true ? [Buffer.from('deleteall\n')] : []),
    );
    for (const [path, content] of commit.files) {
      if (content === null) stream.push(Buffer.from(`D ${quoted(path)}\n`));
      else stream.push(Buffer.from(`M 100644 inline ${quoted(path)}\n`), ...data(content));
    }
    stream.push(Buffer.from('\n'));
  }
  await git(repository, ['fast-import', '--quiet', '--force'], Buffer.concat(stream));
  return revision(repository, HOUSE_REF);
}

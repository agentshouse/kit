import type { KitRun } from '@agentshouse/kit-wire';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run, type Ran } from './git.ts';
import { repositoriesFolder } from './home.ts';
import { PlaceRefused } from './refusals.ts';

export type Repository = NonNullable<KitRun['repository']>;

export const REPOSITORIES = 'settings/repositories.md';

const SCHEMED = /^[a-z][a-z0-9+.-]*:\/\//iu;
const SCP = /^(?:[^@/]+@)?([^:/]+):(.*)$/u;
const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/u;

function located(url: string): { host: string; path: string } {
  let host = '';
  let path = url;
  if (SCHEMED.test(url) && URL.canParse(url)) {
    const parsed = new URL(url);
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } else {
    const scp = url.startsWith('/') ? null : SCP.exec(url);
    if (scp !== null) {
      host = scp[1]!;
      path = scp[2]!;
    }
  }
  return { host: host.toLowerCase(), path: path.replace(/\/+$/u, '').replace(/\.git$/u, '').replace(/^\/+/u, '') };
}

export function sameRepository(one: string, other: string): boolean {
  const [a, b] = [located(one), located(other)];
  return a.host === b.host && a.path === b.path;
}

export function cloneOf(url: string): string {
  return join(repositoriesFolder(), located(url).path.split('/').at(-1)!);
}

function answer(ran: Ran, verb: string): string {
  return ran.stderr.trim() || `git ${verb} exited with ${ran.status ?? 'a signal'}`;
}

async function git(folder: string, args: string[]): Promise<string> {
  const ran = await run(folder, args);
  if (ran.status !== 0) throw new PlaceRefused(answer(ran, args[0]!));
  return ran.stdout.toString('utf8');
}

async function cloned(clone: string, url: string): Promise<void> {
  const folder = await stat(clone).catch(() => null);
  if (folder === null || !folder.isDirectory()) throw new PlaceRefused(`${clone} is missing; clone ${url} there`);
  const origin = await run(clone, ['config', '--get', 'remote.origin.url']);
  if (origin.status !== 0 || !sameRepository(origin.stdout.toString('utf8').trim(), url)) {
    throw new PlaceRefused(`${clone} is not a clone of ${url}`);
  }
}

async function worktreeOf(clone: string, path: string, branch: string): Promise<void> {
  const physical = await realpath(path).catch(() => null);
  const listed = (await git(clone, ['worktree', 'list', '--porcelain'])).split('\n\n');
  for (const block of listed) {
    const lines = block.split('\n');
    const folder = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (folder === undefined || !lines.includes(`branch refs/heads/${branch}`)) continue;
    if (physical !== null && (await realpath(folder).catch(() => folder)) === physical) return;
  }
  throw new PlaceRefused(`${path} is not a worktree of ${clone} on ${branch}`);
}

export function listedRef(document: string | null, url: string): string | null {
  const front = document === null ? null : FRONTMATTER.exec(document);
  const fields = (front === null ? null : parse(front[1]!, { schema: 'failsafe' })) as { repositories?: unknown } | null;
  const entries = Array.isArray(fields?.repositories) ? (fields.repositories as unknown[]) : [];
  const entry = entries.find((one): one is { url: string; ref?: unknown } => typeof one === 'object' && one !== null && (one as { url?: unknown }).url === url);
  if (entry === undefined) throw new PlaceRefused(`the Room's ${REPOSITORIES} lists no repository ${url}`);
  return typeof entry.ref === 'string' && entry.ref !== '' ? entry.ref : null;
}

export async function codeFolder(
  { url, code }: Repository,
  name: string,
  listed: () => Promise<string | null>,
  serial: (key: string, work: () => Promise<string>) => Promise<string>,
): Promise<string> {
  const clone = cloneOf(url);
  await cloned(clone, url);
  if (code.kind === 'main') return clone;
  if (code.kind === 'existing') {
    await worktreeOf(clone, code.path, code.branch);
    return code.path;
  }
  const ref = await listed();
  const branch = code.branch ?? name;
  const folder = join(`${clone}.worktrees`, branch);
  return serial(`repository:${clone}`, async () => {
    await git(clone, ['fetch', 'origin', ref ?? 'HEAD']);
    await git(clone, ['worktree', 'add', '-b', branch, folder, 'FETCH_HEAD']);
    return folder;
  });
}

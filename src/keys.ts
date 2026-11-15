import type { ReportedAgentKind } from '@agentshouse/kit-wire';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { readHome, writeHome } from './home.ts';
import { childEnvironment } from './relay.ts';

type Keyed = Pick<ReportedAgentKind, 'api_key' | 'provider'>;

export interface KeySettings {
  read(): Promise<Keyed>;
  write(key: string, endpoint: string | null, cli: string, signal: AbortSignal): Promise<void>;
  environment?(): Promise<Record<string, string>>;
}

type Table = Record<string, unknown>;

function table(value: unknown): Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Table) : {};
}

function filled(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

function hostOf(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string') return undefined;
  try {
    return new URL(endpoint).host || undefined;
  } catch {
    return undefined;
  }
}

function keyed(apiKey: boolean, endpoint: unknown, maker: string): Keyed {
  const host = hostOf(endpoint);
  return { ...(apiKey ? { api_key: true } : {}), ...(host === undefined || host === maker ? {} : { provider: host }) };
}

function quietly(read: () => Promise<Keyed>): () => Promise<Keyed> {
  return () => read().catch(() => ({}));
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function replaceFile(file: string, text: string): Promise<void> {
  const target = await realpath(file).catch(() => file);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, target);
}

async function jsonSettings(file: string): Promise<Table> {
  const text = await readText(file);
  if (text === null) return {};
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    settings = null;
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new Error(`${file} holds no JSON object`);
  return settings as Table;
}

async function tomlSettings(file: string): Promise<Table> {
  return parse((await readText(file)) ?? '');
}

interface TomlEdit {
  table: string[];
  key: string;
  value: string | null;
  kept?: true;
}

interface Header {
  at: number;
  path: string[];
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function header(line: string, at: number): Header | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) return null;
  let value: unknown;
  try {
    value = parse(trimmed);
  } catch {
    return null;
  }
  const path: string[] = [];
  while (!Array.isArray(value)) {
    const [name, ...more] = Object.keys(table(value));
    if (name === undefined || more.length > 0) return { at, path };
    path.push(name);
    value = table(value)[name];
  }
  return { at, path: [...path, '[]'] };
}

function editLines(lines: string[], { table: path, key, value, kept }: TomlEdit): string[] {
  const headers = lines.flatMap((line, at) => header(line, at) ?? []);
  const found = path.length === 0 ? { at: -1, path } : headers.find((one) => isDeepStrictEqual(one.path, path));
  const assignment = `${key} = ${JSON.stringify(value)}`;
  if (found === undefined) {
    if (value === null) return lines;
    const kept = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    return [...kept, ...(kept.length === 0 ? [] : ['']), `[${path.map((name) => (BARE_KEY.test(name) ? name : JSON.stringify(name))).join('.')}]`, assignment, ''];
  }
  const end = headers.find((one) => one.at > found.at)?.at ?? lines.length;
  const assigned = new RegExp(`^\\s*${key}\\s*=`);
  const current = lines.findIndex((line, at) => at > found.at && at < end && assigned.test(line));
  if (current !== -1 && kept) return lines;
  if (current !== -1) return value === null ? lines.toSpliced(current, 1) : lines.toSpliced(current, 1, assignment);
  if (value === null) return lines;
  const last = lines.findLastIndex((line, at) => at > found.at && at < end && line.trim() !== '');
  return lines.toSpliced(Math.max(last, found.at) + 1, 0, assignment);
}

function editSettings(settings: Table, { table: path, key, value, kept }: TomlEdit): void {
  let at = settings;
  for (const name of path) {
    if (typeof at[name] !== 'object' || at[name] === null) at[name] = Object.create(null);
    at = at[name] as Table;
  }
  if (kept && key in at) return;
  if (value === null) delete at[key];
  else at[key] = value;
}

async function editToml(file: string, edits: TomlEdit[]): Promise<() => Promise<void>> {
  const text = (await readText(file)) ?? '';
  let expected: Table;
  try {
    expected = parse(text);
  } catch {
    throw new Error(`${file} is not TOML`);
  }
  for (const edit of edits) editSettings(expected, edit);
  const edited = edits.reduce(editLines, text === '' ? [] : text.split('\n')).join('\n');
  let written: Table | null;
  try {
    written = parse(edited);
  } catch {
    written = null;
  }
  if (!isDeepStrictEqual(written, expected)) throw new Error(`${file} could not take the key without changing its other settings`);
  if (edited === text) return async () => undefined;
  return () => replaceFile(file, edited.endsWith('\n') ? edited : `${edited}\n`);
}

function claudeSettings(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}

export const CLAUDE_KEY: KeySettings = {
  read: quietly(async () => {
    const env = table((await jsonSettings(claudeSettings())).env);
    return keyed(filled(env.ANTHROPIC_API_KEY) || filled(env.ANTHROPIC_AUTH_TOKEN), env.ANTHROPIC_BASE_URL, 'api.anthropic.com');
  }),
  write: async (key, endpoint) => {
    const file = claudeSettings();
    const settings = await jsonSettings(file);
    const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ANTHROPIC_BASE_URL: _endpoint, ...env } = table(settings.env);
    const written =
      endpoint === null
        ? { ...env, ANTHROPIC_API_KEY: key }
        : { ...env, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: endpoint };
    await replaceFile(file, `${JSON.stringify({ ...settings, env: written }, undefined, 2)}\n`);
  },
};

const CODEX_PROVIDER = 'model_provider';

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function codexLogin(cli: string, key: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['login', '--with-api-key'], { stdio: ['pipe', 'ignore', 'pipe'], env: childEnvironment(), signal });
    let output = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output = (output + chunk).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (status) => {
      const last = output.trim().split('\n').at(-1) ?? '';
      if (status === 0) resolve();
      else reject(new Error(`codex login --with-api-key exited with ${status ?? 'a signal'}${last === '' ? '' : `: ${last}`}`));
    });
    child.stdin.end(key);
  });
}

export const CODEX_KEY: KeySettings = {
  read: quietly(async () => {
    const config = await tomlSettings(join(codexHome(), 'config.toml'));
    const id = config[CODEX_PROVIDER];
    if (typeof id === 'string' && id !== 'openai') {
      const provider = table(table(config.model_providers)[id]);
      const fromEnvironment = typeof provider.env_key === 'string' && filled(process.env[provider.env_key]);
      return keyed(filled(provider.experimental_bearer_token) || fromEnvironment, provider.base_url, 'api.openai.com');
    }
    const auth = table(JSON.parse((await readText(join(codexHome(), 'auth.json'))) ?? '{}'));
    return keyed(filled(auth.OPENAI_API_KEY) && (auth.tokens === undefined || auth.tokens === null), undefined, 'api.openai.com');
  }),
  write: async (key, endpoint, cli, signal) => {
    const file = join(codexHome(), 'config.toml');
    if (endpoint === null) {
      const write = await editToml(file, [{ table: [], key: CODEX_PROVIDER, value: null }]);
      await codexLogin(cli, key, signal);
      await write();
      return;
    }
    const host = new URL(endpoint).host;
    const provider = ['model_providers', host];
    const write = await editToml(file, [
      { table: [], key: CODEX_PROVIDER, value: host },
      { table: provider, key: 'name', value: host, kept: true },
      { table: provider, key: 'base_url', value: endpoint },
      { table: provider, key: 'experimental_bearer_token', value: key },
    ]);
    await write();
  },
};

interface HeldKey {
  key: string;
  endpoint?: string;
}

const GROK_HELD_KEY = 'grok-key.json';

async function heldGrokKey(): Promise<HeldKey | null> {
  try {
    return await readHome<HeldKey>(GROK_HELD_KEY);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${GROK_HELD_KEY} in Kit home holds no JSON`);
    throw error;
  }
}

export const GROK_KEY: KeySettings = {
  read: quietly(async () => {
    const held = await heldGrokKey();
    if (held?.endpoint !== undefined) return keyed(true, held.endpoint, 'api.x.ai');
    const config = await tomlSettings(join(process.env.GROK_HOME || join(homedir(), '.grok'), 'config.toml'));
    return keyed(held !== null, table(config.endpoints).models_base_url, 'api.x.ai');
  }),
  write: (key, endpoint) => writeHome(GROK_HELD_KEY, { key, ...(endpoint === null ? {} : { endpoint }) } satisfies HeldKey),
  environment: async () => {
    const held = await heldGrokKey();
    if (held === null) return {};
    return { XAI_API_KEY: held.key, ...(held.endpoint === undefined ? {} : { GROK_MODELS_BASE_URL: held.endpoint }) };
  },
};

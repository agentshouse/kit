#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request, setGlobalProxyFromEnv } from 'node:http';
import { extname, join } from 'node:path';
import type { ToolResult } from './bridge.ts';
import { HOUSE_REF } from './git.ts';
import { kitHome, readEnrolment, readOwnAgent } from './home.ts';
import { callHouse, rpc, UNREACHABLE, type Message } from './mcp.ts';
import { refusalOf } from './refusals.ts';
import { relayed } from './relay.ts';
import { parse, stringify } from 'yaml';

interface Tool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

interface Declared {
  upload?: { url: string; operation: string };
}

const USAGE = "usage: house <tool> ['<arguments as JSON>']";
const PUSH_USAGE = 'usage: house push [commit] [--owner]';
const PUSH = "push [commit]: sends the Local copy's committed changes to House";
const FETCH_USAGE = 'usage: house fetch';
const FETCH = `fetch: records House's changes on each Local copy's ${HOUSE_REF}`;
const ARGUMENTS = `the arguments are one JSON object in single quotes, like house search '{"query":"invoice"}'`;
const CLOSED = "this conversation's House connection is closed; nothing to do from here";
const SANDBOXED = "your CLI's sandbox kept house from House; run house directly, not through another program";
const REVOKED = 'this conversation no longer has House access; nothing to do from here';
const UNCONNECTED = "this computer's own agent has no House connection; run kit login";
const DISCONNECTED = "House no longer accepts this computer's own agent; run kit login";
const socketPath = process.env.HOUSE_BRIDGE;
const MEDIA_TYPES = new Map([
  ['avif', 'image/avif'],
  ['csv', 'text/csv'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['gif', 'image/gif'],
  ['heic', 'image/heic'],
  ['html', 'text/html'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['json', 'application/json'],
  ['m4a', 'audio/mp4'],
  ['md', 'text/markdown'],
  ['mov', 'video/quicktime'],
  ['mp3', 'audio/mpeg'],
  ['mp4', 'video/mp4'],
  ['ogg', 'audio/ogg'],
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['svg', 'image/svg+xml'],
  ['txt', 'text/plain'],
  ['wav', 'audio/wav'],
  ['webm', 'video/webm'],
  ['webp', 'image/webp'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['zip', 'application/zip'],
]);

function refused(path: string, status: number, text: string): string {
  const refusal = refusalOf(text);
  if (refusal !== null) return refusal.text;
  if (status === 401) return REVOKED;
  if (URL.canParse(path)) return `the upload answered ${status}; upload the file again`;
  if (status === 502 && /^[A-Za-z]/.test(text)) return text;
  return `${path} answered ${status}`;
}

function bridged(
  path: string,
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
  to = socketPath,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sent = request({ socketPath: to, path, method: 'POST', headers }, (answer) => {
      let text = '';
      answer.setEncoding('utf8');
      answer.on('data', (chunk: string) => {
        text += chunk;
      });
      answer.on('end', () => {
        if (answer.statusCode === 200) resolve(text);
        else reject(new Error(refused(path, answer.statusCode!, text)));
      });
    });
    sent.on('error', (error: NodeJS.ErrnoException) =>
      reject(new Error(error.code === 'EPERM' || error.code === 'EACCES' ? SANDBOXED : CLOSED)),
    );
    sent.end(body instanceof Buffer ? body : JSON.stringify(body));
  });
}

async function direct(message: Message): Promise<string> {
  const ownAgent = await readOwnAgent();
  if (ownAgent === null) throw new Error(UNCONNECTED);
  await readEnrolment();
  setGlobalProxyFromEnv();
  const answer = await callHouse(ownAgent.house, ownAgent.credential, message).catch(() => {
    throw new Error(UNREACHABLE);
  });
  if (answer.status === 200) return answer.text;
  throw new Error(answer.status === 401 ? DISCONNECTED : (refusalOf(answer.text)?.text ?? `House answered ${answer.status}`));
}

async function mcp<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const message = rpc(method, params);
  const answer = JSON.parse(socketPath === undefined ? await direct(message) : await bridged('/', message)) as {
    result?: T;
    error?: { message: string };
  };
  if (answer.error !== undefined) throw new Error(answer.error.message);
  return answer.result!;
}

async function tools(): Promise<Tool[]> {
  return (await mcp<{ tools: Tool[] }>('tools/list', {})).tools;
}

async function localFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    throw new Error(
      (error as NodeJS.ErrnoException).code === 'EISDIR'
        ? `${path} is a folder; upload one file at a time`
        : `${path} is not a readable file`,
    );
  }
}

async function sent(url: string, bytes: Buffer, operation: string): Promise<string> {
  const headers = { 'content-type': 'application/octet-stream', 'x-house-byte-operation': operation };
  if (socketPath !== undefined) return bridged(url, bytes, headers);
  setGlobalProxyFromEnv();
  const answer = await fetch(relayed(url), { method: 'POST', headers, body: bytes }).catch(() => {
    throw new Error(UNREACHABLE);
  });
  const text = await answer.text();
  if (answer.status === 200) return text;
  throw new Error(refused(url, answer.status, text));
}

async function upload({ file, ...destination }: Record<string, unknown>): Promise<string> {
  if (typeof file !== 'string' || file === '') throw new Error('upload needs "file", a local file');
  const bytes = await localFile(file);
  const mediaType = MEDIA_TYPES.get(extname(file).slice(1).toLowerCase());
  const answer = await called('upload', {
    ...destination,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(mediaType === undefined ? {} : { media_type: mediaType }),
  });
  const declared = parse(answer) as Declared;
  if (declared.upload === undefined) return answer;
  const written: unknown = JSON.parse(await sent(declared.upload.url, bytes, declared.upload.operation));
  return stringify(written, { lineWidth: 0 }).trimEnd();
}

function unexpected(argument: string, usage: string): Error {
  return new Error(`unexpected argument ${argument}; ${usage}`);
}

function accepted(args: string[], flags: string[], positionals: number, usage: string): { flags: Set<string>; positionals: string[] } {
  const given = { flags: new Set<string>(), positionals: [] as string[] };
  for (const arg of args) {
    if (flags.includes(arg)) given.flags.add(arg);
    else if (!arg.startsWith('-') && given.positionals.length < positionals) given.positionals.push(arg);
    else throw unexpected(arg, usage);
  }
  return given;
}

async function push(args: string[]): Promise<string> {
  const { flags, positionals: [commit = 'HEAD'] } = accepted(args, ['--help', '--owner'], 1, PUSH_USAGE);
  if (flags.has('--help')) return PUSH_USAGE;
  const owner = flags.has('--owner');
  if (owner && socketPath !== undefined) throw new Error('--owner is not for Agent conversations; run house push without it');
  if (!owner && socketPath === undefined) throw new Error('outside an Agent conversation, house push needs --owner');
  const pushed = JSON.parse(
    await bridged('/git/push', { cwd: process.cwd(), commit }, undefined, owner ? join(kitHome(), 'owner.sock') : socketPath),
  ) as { refused: boolean; text: string };
  if (pushed.refused) throw new Error(pushed.text);
  return pushed.text;
}

async function fetched(args: string[]): Promise<string> {
  if (accepted(args, ['--help'], 0, FETCH_USAGE).flags.has('--help')) return FETCH_USAGE;
  const answer = JSON.parse(await bridged('/git/fetch', {}, undefined, socketPath ?? join(kitHome(), 'owner.sock'))) as {
    refused: boolean;
    text: string;
  };
  if (answer.refused) throw new Error(answer.text);
  return answer.text;
}

function argumentsOf(argument: string | undefined): Record<string, unknown> {
  if (argument === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(argument);
  } catch {
    throw new Error(ARGUMENTS);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(ARGUMENTS);
  return parsed as Record<string, unknown>;
}

async function house(args: string[]): Promise<string> {
  const { flags, positionals: [verb, argument] } = accepted(args, ['--help'], 2, USAGE);
  if (verb === 'help' && argument !== undefined) throw unexpected(argument, USAGE);
  if (flags.has('--help') && argument !== undefined) throw unexpected('--help', USAGE);
  if (verb === undefined || verb === 'help') {
    return [USAGE, 'help', PUSH, FETCH, ...(await tools()).map((tool) => (tool.description === undefined ? tool.name : `${tool.name}: ${tool.description}`))].join('\n');
  }
  if (flags.has('--help')) {
    const tool = (await tools()).find((listed) => listed.name === verb);
    if (tool === undefined) throw new Error(`${verb} is no Tool; house find_command '{"query":"${verb}"}' finds Commands`);
    return [...(tool.description === undefined ? [] : [tool.description]), JSON.stringify(tool.inputSchema)].join('\n');
  }
  const parsed = argumentsOf(argument);
  return verb === 'upload' ? upload(parsed) : called(verb, parsed);
}

async function called(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await mcp<ToolResult>('tools/call', { name, arguments: args });
  const text = result.content.map((content) => content.text).join('\n');
  if (result.isError === true) throw new Error(text.replace(/\n+$/, ''));
  return text;
}

const argv = process.argv.slice(2);
const named = argv.findIndex((arg) => !arg.startsWith('-'));
const rest = argv.filter((_arg, index) => index !== named);
(argv[named] === 'push' ? push(rest) : argv[named] === 'fetch' ? fetched(rest) : house(argv)).then(
  (text) => {
    process.stdout.write(`${text}\n`);
    if (argv[0] === 'shell') process.exitCode = Number(/^exit: (\d+)(?:\n|$)/.exec(text)?.[1] ?? 0);
  },
  (error: unknown) => {
    process.stderr.write(`house: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

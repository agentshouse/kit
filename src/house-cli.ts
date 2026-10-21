import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request, setGlobalProxyFromEnv, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ToolResult } from './bridge.ts';
import { downloaded, storeRefusal, uploaded, type UploadParts } from './files.ts';
import { HOUSE_REF } from './git.ts';
import { ownerSocket, readOwnAgent } from './home.ts';
import { callHouse, rpc, UNREACHABLE, Unreached, type Message } from './mcp.ts';
import { refusalOf } from './refusals.ts';
import { relayed, selectRelay } from './relay.ts';
import { parse } from 'yaml';

interface Tool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

interface Grant {
  url: string;
  operation: string;
}

interface Staged {
  upload?: Array<Grant & { sha256: string }>;
}

interface Description {
  bytes: number;
  sha256: string;
  media_type?: string;
}

type Finishing = { upload: UploadParts } | { checking: true } | { text: string };

const USAGE = "usage: house <tool> ['<arguments as JSON>']";
const PUSH_USAGE = 'usage: house push [commit] [--owner]';
const PUSH = "push [commit]: sends the Local copy's committed changes to House";
const FETCH_USAGE = 'usage: house fetch';
const FETCH = `fetch: records House's changes on each Local copy's ${HOUSE_REF}`;
const DOWNLOAD_USAGE = `usage: house download '{"path":"/rooms/<handle>/<path>","file":"<local file>"}', adding "ref" for a revision`;
const DOWNLOAD = 'download: writes a binary file of a Room to the local file named by file';
const ARGUMENTS = `the arguments are one JSON object in single quotes, like house search '{"query":"invoice"}'`;
const CLOSED = "this conversation's House connection is closed; nothing to do from here";
const SANDBOXED = "your CLI's sandbox kept house from House; run house directly, not through another program";
const REVOKED = 'this conversation no longer has House access; nothing to do from here';
const UNCONNECTED = "this computer's own agent has no House connection; run kit login, or kit chatgpt --key <key> with a script key";
const DISCONNECTED = "House no longer accepts this computer's own agent; run kit login, or kit chatgpt --key <key> with a script key";
const UNCONFIRMED = 'with no result; a write may or may not have taken effect, so read before you repeat it';
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

function refused(path: string, status: number, text: string, local: boolean): string {
  const refusal = refusalOf(text);
  if (refusal !== null) return refusal.text;
  if (status === 401) return REVOKED;
  if (status === 502 && local) return text;
  return path === '/' ? unconfirmed(status) : `${path} answered ${status}`;
}

function unconfirmed(status: number): string {
  return `House answered ${status} ${UNCONFIRMED}`;
}

function bridged(path: string, body: unknown, to = socketPath): Promise<string> {
  return new Promise((resolve, reject) => {
    const sent = request({ socketPath: to, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (answer) => {
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (answer.statusCode === 200) resolve(text);
        else reject(new Error(refused(path, answer.statusCode!, text, answer.headers['content-type'] === undefined)));
      });
    });
    sent.on('error', (error: NodeJS.ErrnoException) =>
      reject(new Error(error.code === 'EPERM' || error.code === 'EACCES' ? SANDBOXED : CLOSED)),
    );
    sent.end(JSON.stringify(body));
  });
}

async function direct(message: Message): Promise<string> {
  const ownAgent = await readOwnAgent();
  if (ownAgent === null) throw new Error(UNCONNECTED);
  selectRelay(process.env.HOUSE_KIT_RELAY || ownAgent.relay);
  setGlobalProxyFromEnv();
  const answer = await callHouse(ownAgent.house, ownAgent.credential, message).catch(() => {
    throw new Unreached();
  });
  if (answer.status === 200) return answer.text;
  throw new Error(answer.status === 401 ? DISCONNECTED : (refusalOf(answer.text)?.text ?? unconfirmed(answer.status)));
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

function unreadable(path: string, error: unknown): Error {
  return new Error(
    (error as NodeJS.ErrnoException).code === 'EISDIR'
      ? `${path} is a folder; upload one file at a time`
      : `${path} is not a readable file`,
  );
}

async function localFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    throw unreadable(path, error);
  }
}

function opened(url: string, method: string, headers: Record<string, string>, body?: Buffer | Readable): Promise<IncomingMessage> {
  return new Promise((answered, failed) => {
    const local = socketPath !== undefined;
    const target = local ? null : relayed(url);
    if (!local) setGlobalProxyFromEnv();
    const sent =
      target === null
        ? request({ socketPath, path: url, method, headers }, answered)
        : (target.protocol === 'https:' ? httpsRequest : request)(target, { method, headers }, answered);
    sent.on('error', (error: NodeJS.ErrnoException) =>
      failed(new Error(!local ? UNREACHABLE : error.code === 'EPERM' || error.code === 'EACCES' ? SANDBOXED : CLOSED)),
    );
    if (body instanceof Readable) pipeline(body, sent).catch(() => undefined);
    else sent.end(body);
  });
}

async function textOf(answer: IncomingMessage): Promise<string> {
  return Buffer.concat(await answer.toArray()).toString('utf8');
}

async function sent(url: string, bytes: Buffer, operation: string): Promise<string> {
  const headers = { 'content-type': 'application/octet-stream', 'x-house-byte-operation': operation };
  const answer = await opened(url, 'POST', headers, bytes);
  const text = await textOf(answer);
  if (answer.statusCode === 200) return text;
  throw new Error(refusalOf(text)?.text ?? storeRefusal('upload', answer.statusCode!).message);
}

async function sentPart(url: string, file: string, start: number, end: number): Promise<void> {
  const answer = await opened(
    url,
    'PUT',
    { 'content-length': String(end - start) },
    end === start ? undefined : createReadStream(file, { start, end: end - 1 }),
  );
  await answer.toArray();
  if (answer.statusCode !== 200) throw storeRefusal('upload', answer.statusCode!);
}

async function download(args: string[]): Promise<string> {
  const { flags, positionals: [argument] } = accepted(args, ['--help'], 1, DOWNLOAD_USAGE);
  if (flags.has('--help')) return DOWNLOAD_USAGE;
  const { file, ...selected } = argumentsOf(argument);
  if (typeof file !== 'string' || file === '') throw new Error('download needs "file", the local file to write');
  const written = resolve(file);
  await downloaded(
    async () => {
      const inspected = parse(await called('inspect', selected)) as { download?: unknown; sha256?: unknown } | null;
      if (typeof inspected?.download !== 'string') throw new Error(`${String(selected.path)} holds no binary file; shell reads its text`);
      return { download: inspected.download, sha256: String(inspected.sha256) };
    },
    async (url) => {
      const answer = await opened(url, 'GET', {});
      return { status: answer.statusCode!, body: answer };
    },
    written,
    String(selected.path),
  );
  return written;
}

async function described(file: string): Promise<Description> {
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
      digest.update(chunk);
      bytes += chunk.length;
    }
  } catch (error) {
    throw unreadable(file, error);
  }
  const mediaType = MEDIA_TYPES.get(extname(file).slice(1).toLowerCase());
  return { bytes, sha256: digest.digest('hex'), ...(mediaType === undefined ? {} : { media_type: mediaType }) };
}

async function finished(upload: string, room: unknown): Promise<Finishing> {
  const text = await called('upload', { upload, room_ref: room });
  const answer = parse(text) as object | null;
  return answer !== null && ('upload' in answer || 'checking' in answer) ? (answer as Finishing) : { text };
}

async function upload({ file, ...destination }: Record<string, unknown>): Promise<string> {
  if (typeof file !== 'string' || file === '') throw new Error('upload needs "file", a local file');
  const description = await described(file);
  const answer = await called('upload', { ...destination, ...description });
  const declared = parse(answer) as { upload?: UploadParts } | null;
  if (declared?.upload === undefined) return answer;
  const accepted = await uploaded(declared.upload, {
    bytes: description.bytes,
    send: (url, start, end) => sentPart(url, file, start, end),
    finish: (id) => finished(id, destination.room_ref),
  });
  return accepted.text;
}

async function appendRecord(args: Record<string, unknown>): Promise<string> {
  const held = new Map<string, string>();
  const attachments = Array.isArray(args.attachments)
    ? await Promise.all(
        args.attachments.map(async (attachment: unknown) => {
          if (typeof attachment !== 'string') return attachment;
          const description = await described(attachment);
          held.set(description.sha256, attachment);
          return { name: basename(attachment), ...description };
        }),
      )
    : args.attachments;
  const record = { ...args, attachments };
  for (;;) {
    const answer = await called('append_record', record);
    const { upload } = parse(answer) as Staged;
    if (upload === undefined) return answer;
    for (const grant of upload) await sent(grant.url, await localFile(held.get(grant.sha256)!), grant.operation);
  }
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
    await bridged('/git/push', { cwd: process.cwd(), commit }, owner ? ownerSocket() : socketPath),
  ) as { refused: boolean; text: string };
  if (pushed.refused) throw new Error(pushed.text);
  return pushed.text;
}

async function fetched(args: string[]): Promise<string> {
  if (accepted(args, ['--help'], 0, FETCH_USAGE).flags.has('--help')) return FETCH_USAGE;
  const answer = JSON.parse(await bridged('/git/fetch', {}, socketPath ?? ownerSocket())) as {
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
    return [USAGE, 'help', PUSH, FETCH, DOWNLOAD, ...(await tools()).map((tool) => (tool.description === undefined ? tool.name : `${tool.name}: ${tool.description}`))].join('\n');
  }
  if (flags.has('--help')) {
    const tool = (await tools()).find((listed) => listed.name === verb);
    if (tool === undefined) throw new Error(`${verb} is no Tool; house find_command '{"query":"${verb}"}' finds Commands`);
    return [...(tool.description === undefined ? [] : [tool.description]), JSON.stringify(tool.inputSchema)].join('\n');
  }
  const parsed = argumentsOf(argument);
  return verb === 'upload' ? upload(parsed) : verb === 'append_record' ? appendRecord(parsed) : called(verb, parsed);
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
(argv[named] === 'push'
  ? push(rest)
  : argv[named] === 'fetch'
    ? fetched(rest)
    : argv[named] === 'download'
      ? download(rest)
      : house(argv)
).then(
  (text) => {
    process.stdout.write(`${text}\n`);
    if (argv[0] === 'shell') process.exitCode = Number(/^exit: (\d+)(?:\n|$)/.exec(text)?.[1] ?? 0);
  },
  (error: unknown) => {
    process.stderr.write(`house: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ToolResult } from './bridge.ts';
import { downloaded, inspectedFile, storeRefusal, uploaded, type UploadParts } from './files.ts';
import { HOUSE_REF } from './git.ts';
import { ownerSocket, readOwnAgent } from './home.ts';
import { callHouse, rpc, UNREACHABLE, Unsettled, type Message } from './mcp.ts';
import { refusalOf, retryable } from './refusals.ts';
import { proxyUnlessRelayed, relayed, selectRelay } from './relay.ts';
import { parse } from 'yaml';

interface Tool {
  name: string;
  description?: string;
  inputSchema: Schema;
}

interface Schema {
  $ref?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  const?: unknown;
  enum?: unknown[];
}

interface Description {
  bytes: number;
  sha256: string;
  media_type?: string;
}

type Finishing = { upload: UploadParts } | { text: string };

const USAGE = "usage: house <tool> ['<arguments as JSON>']; house help <tool>: its arguments";
const HELP = 'help [tool]';
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
const UNCONNECTED = "this computer's own agent has no House connection; run kit login";
const DISCONNECTED = "House no longer accepts this computer's own agent; run kit login";
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
  const answer = await callHouse(ownAgent.house, ownAgent.credential, message).catch(() => {
    throw new Unsettled(UNREACHABLE);
  });
  if (answer.status === 200) return answer.text;
  if (answer.status === 401) throw new Error(DISCONNECTED);
  const refusal = refusalOf(answer.text)?.text ?? unconfirmed(answer.status);
  throw retryable(answer.text) === false ? new Error(refusal) : new Unsettled(refusal);
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

function opened(url: string, method: string, headers: Record<string, string>, body?: Readable): Promise<IncomingMessage> {
  return new Promise((answered, failed) => {
    const local = socketPath !== undefined;
    const target = local ? null : relayed(url);
    if (!local) proxyUnlessRelayed();
    const sent =
      target === null
        ? request({ socketPath, path: url, method, headers }, answered)
        : (target.protocol === 'https:' ? httpsRequest : request)(target, { method, headers }, answered);
    sent.on('error', (error: NodeJS.ErrnoException) =>
      failed(new Error(!local ? UNREACHABLE : error.code === 'EPERM' || error.code === 'EACCES' ? SANDBOXED : CLOSED)),
    );
    if (body === undefined) sent.end();
    else pipeline(body, sent).catch(() => undefined);
  });
}

function ranged(file: string, start: number, end: number): Readable | undefined {
  return end === start ? undefined : createReadStream(file, { start, end: end - 1 });
}

async function* read(file: string, start: number, end: number): AsyncIterable<Buffer> {
  try {
    yield* ranged(file, start, end) ?? [];
  } catch (error) {
    throw unreadable(file, error);
  }
}

async function sentPart(url: string, file: string, start: number, end: number, headers: Record<string, string>): Promise<void> {
  const answer = await opened(url, 'PUT', { ...headers, 'content-length': String(end - start) }, ranged(file, start, end));
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
      const file = inspectedFile(await called('inspect', selected));
      if (file === null) throw new Error(`${String(selected.path)} holds no binary file; shell reads its text`);
      return file;
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

async function finished(upload: string, room: unknown, partSha256: string[]): Promise<Finishing> {
  const text = await called('upload', { upload, room_ref: room, part_sha256: partSha256 });
  const answer = parse(text) as object | null;
  return answer !== null && 'upload' in answer ? (answer as Finishing) : { text };
}

async function upload({ file, ...destination }: Record<string, unknown>): Promise<string> {
  if (typeof file !== 'string' || file === '') throw new Error('upload needs "file", a local file');
  const description = await described(file);
  const answer = await called('upload', { ...destination, ...description });
  const declared = parse(answer) as { upload?: UploadParts } | null;
  if (declared?.upload === undefined) return answer;
  const accepted = await uploaded(declared.upload, {
    name: file,
    bytes: description.bytes,
    sha256: description.sha256,
    read: (start, end) => read(file, start, end),
    send: (url, start, end, headers) => sentPart(url, file, start, end, headers),
    finish: (id, partSha256) => finished(id, destination.room_ref, partSha256),
  });
  return accepted.text;
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

// The schema a $ref points to inside the Tool's own inputSchema, or an empty one when it points elsewhere.
function resolved(schema: Schema, root: Schema): Schema {
  if (schema.$ref === undefined) return schema;
  if (!schema.$ref.startsWith('#')) return {};
  let found: unknown = root;
  for (const key of schema.$ref.split('/').slice(1)) {
    found = typeof found === 'object' && found !== null ? (found as Record<string, unknown>)[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
  }
  return typeof found === 'object' && found !== null ? (found as Schema) : {};
}

// The schema a $ref resolves to, with that $ref added to the open ones, or null when it is open already,
// so a schema that holds itself is expanded once.
function expanded(schema: Schema, root: Schema, refs: ReadonlySet<string>): { schema: Schema; refs: ReadonlySet<string> } | null {
  if (schema.$ref === undefined) return { schema, refs };
  return refs.has(schema.$ref) ? null : { schema: resolved(schema, root), refs: new Set([...refs, schema.$ref]) };
}

// One line per argument: its name, its value when it has one or a few, whether it is required, and its
// description. When deep, the arguments its value holds follow it.
function argumentLines(schema: Schema, root: Schema, indent: string, deep: boolean, refs: ReadonlySet<string> = new Set()): string[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).flatMap(([name, property]) => {
    const value = resolved(property, root);
    const values = value.const !== undefined ? [value.const] : (value.enum ?? []);
    const words = [name, ...(values.length === 0 ? [] : [values.map((one) => JSON.stringify(one)).join(' | ')]), ...(required.has(name) ? ['(required)'] : [])];
    const description = property.description ?? value.description;
    const line = `${indent}${words.join(' ')}${description === undefined ? '' : `: ${description}`}`;
    return deep ? [line, ...held(property, root, `${indent}  `, refs)] : [line];
  });
}

// The arguments a value holds: its own, its items', and those of each alternative of a oneOf or anyOf,
// each alternative a "- " entry when more than one has arguments.
function held(schema: Schema, root: Schema, indent: string, refs: ReadonlySet<string>): string[] {
  const value = expanded(schema, root, refs);
  if (value === null) return [];
  const alternatives = (value.schema.oneOf ?? value.schema.anyOf ?? [])
    .map((alternative) => held(alternative, root, indent, value.refs))
    .filter((lines) => lines.length > 0);
  return [
    ...argumentLines(value.schema, root, indent, true, value.refs),
    ...(value.schema.items === undefined ? [] : held(value.schema.items, root, indent, value.refs)),
    ...(alternatives.length === 1
      ? alternatives[0]!
      : alternatives.flatMap((lines) => lines.map((line, index) => (index === 0 ? `${indent}- ${line.slice(indent.length)}` : `  ${line}`)))),
  ];
}

function listed(tool: Tool): string {
  return tool.description === undefined ? tool.name : `${tool.name}: ${tool.description}`;
}

async function toolHelp(name: string): Promise<string> {
  const tool = (await tools()).find((one) => one.name === name);
  if (tool === undefined) throw new Error(`${name} is no Tool; house find_command '{"query":"${name}"}' finds Commands`);
  return [listed(tool), ...argumentLines(tool.inputSchema, tool.inputSchema, '  ', true)].join('\n');
}

async function house(args: string[]): Promise<string> {
  const { flags, positionals: [verb, argument] } = accepted(args, ['--help'], 2, USAGE);
  if (flags.has('--help') && argument !== undefined) throw unexpected('--help', USAGE);
  // house help <name> runs as house <name> --help, so both forms answer alike.
  if (verb === 'help' && argument !== undefined) return run([argument, '--help']);
  if (verb === undefined || verb === 'help') {
    const listing = (await tools()).flatMap((tool) =>
      tool.description === undefined ? [tool.name, ...argumentLines(tool.inputSchema, tool.inputSchema, '  ', false)] : [listed(tool)],
    );
    return [USAGE, HELP, PUSH, FETCH, DOWNLOAD, ...listing].join('\n');
  }
  if (flags.has('--help')) return toolHelp(verb);
  const parsed = argumentsOf(argument);
  return verb === 'upload' ? upload(parsed) : called(verb, parsed);
}

async function called(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await mcp<ToolResult>('tools/call', { name, arguments: args });
  const text = result.content.map((content) => content.text).join('\n');
  if (result.isError === true) throw new Error(text.replace(/\n+$/, ''));
  return text;
}

function run(argv: string[]): Promise<string> {
  const named = argv.findIndex((arg) => !arg.startsWith('-'));
  const rest = argv.filter((_arg, index) => index !== named);
  if (argv[named] === 'push') return push(rest);
  if (argv[named] === 'fetch') return fetched(rest);
  if (argv[named] === 'download') return download(rest);
  return house(argv);
}

const argv = process.argv.slice(2);
run(argv).then(
  (text) => {
    process.stdout.write(`${text}\n`);
    if (argv[0] === 'shell') process.exitCode = Number(/^exit: (\d+)(?:\n|$)/.exec(text)?.[1] ?? 0);
  },
  (error: unknown) => {
    process.stderr.write(`house: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

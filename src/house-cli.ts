import { stat } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { text as textOf } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import {
  downloaded,
  fileInfo,
  fileRange,
  mediaTypeOf,
  opened,
  sentPart,
  storeRefusal,
  uploaded,
  type UploadParts,
  type Way,
} from './files.ts';
import { DEFAULT_MAX_SIZE, UPDATE_PATH } from './copies.ts';
import { ownerSocket } from './home.ts';
import { fileDigest, MANIFEST } from './manifest.ts';
import { DISCONNECTED, environmentCall, rpc, unconfirmed, UNREACHABLE, type ToolResult } from './mcp.ts';
import { refusalOf } from './refusals.ts';
import { proxyUnlessRelayed } from './relay.ts';
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

interface KitVerb {
  about: string;
  connection: boolean;
  run(args: string[]): Promise<void>;
}

const USAGE = "usage: house <tool> ['<arguments as JSON>'], or house <tool> - to read them from stdin; house help <tool>: its arguments";
const HELP = 'help [tool]';
const UPLOAD_USAGE = `usage: house upload, house upload '{"file":"<local file>","path":"/rooms/<handle>/<path>"}', adding "base", the revision it replaces, or house upload '{"path":"/rooms/<handle>/<folder>"}' for the link where your User picks the files`;
const UPLOAD =
  "upload: in a Room's Local copy, sends every file changed, added or deleted there since it last matched House, each .md file as document text and every other file as an attachment; with JSON, sends one local file to the Room path it names, or with no file prints the link where your User picks the files for that folder";
const DOWNLOAD_USAGE = `usage: house download [--with-attachments] [--max-size <MB>], or house download '{"path":"/rooms/<handle>/<path>","file":"<local file>"}', adding "ref" for a revision`;
const DOWNLOAD = `download: brings House's changes into every Room's Local copy, or, run in a conversation's copy, into that copy alone, leaving each file changed here for the next house upload; a copy holds the Room's documents and only the attachments asked for there, a conversation's copy linking each one already on this computer, and a download brings no attachment nobody asked for: one another writer changed it links where this computer holds it, or else removes its unchanged file and names it as left on House; --with-attachments brings each attachment the copy lacks up to --max-size megabytes, ${DEFAULT_MAX_SIZE} by default; with JSON, writes one attachment of a Room to the local file named by file`;
const AGENT_RUN =
  'agent run: starts each of "runs" by agent_update request_send, prints its name and reference, and waits until every Run is idle, failed, not started, declined, withdrawn or deleted, printing each one\'s state and never its message; exits 0 only when every Run is idle; with "refs" it starts nothing and waits again';
const MAX_SIZE = `--max-size takes a number of megabytes; ${DOWNLOAD_USAGE}`;
const MEGABYTES = /^\d+(?:\.\d+)?$/;
const ARGUMENTS = `the arguments are one JSON object, in single quotes or on stdin after -, like house search '{"query":"invoice"}'`;
const CLOSED = 'this House connection is closed; nothing to do from here';
const SANDBOXED = "your CLI's sandbox kept house from House; run house directly, not through another program";
const REVOKED = 'this conversation no longer has House access; nothing to do from here';
const NOT_LIVE = 'conversation_not_live';
const socketPath = process.env.HOUSE_BRIDGE;
const INSIDE = 'does not run inside an Agent conversation or a function run; run it in your own terminal';
const WAY: Way = {
  ...(socketPath === undefined ? {} : { socketPath }),
  unreached: (error) =>
    new Error(socketPath === undefined ? UNREACHABLE : error.code === 'EPERM' || error.code === 'EACCES' ? SANDBOXED : CLOSED),
  refused: (status) => storeRefusal('upload', status),
};

function said(text: string): string {
  return refusalOf(text)?.code === NOT_LIVE ? REVOKED : text;
}

function refused(path: string, status: number, text: string, local: boolean): string {
  if (status === 401) return DISCONNECTED;
  const refusal = refusalOf(text);
  if (refusal !== null) return said(refusal.text);
  if (status === 502 && local) return text;
  return path === '/' || path === UPDATE_PATH ? unconfirmed(status) : `${path} answered ${status}`;
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

async function mcp<T>(method: string, params: Record<string, unknown>, operation?: string): Promise<T> {
  const message = rpc(method, params);
  const answer = JSON.parse(socketPath === undefined ? await environmentCall(message, operation) : await bridged('/', message)) as {
    result?: T;
    error?: { message: string };
  };
  if (answer.error !== undefined) throw new Error(said(answer.error.message));
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


async function download(args: string[]): Promise<string> {
  const valued = args.indexOf('--max-size');
  const size = valued === -1 ? undefined : args[valued + 1];
  const rest = valued === -1 ? args : args.filter((_arg, index) => index !== valued && index !== valued + 1);
  const { flags, positionals: [argument] } = accepted(rest, ['--help', '--with-attachments'], 1, DOWNLOAD_USAGE);
  if (flags.has('--help')) return `${DOWNLOAD_USAGE}\n${DOWNLOAD}`;
  if (argument === undefined) {
    if (valued !== -1 && !MEGABYTES.test(size ?? '')) throw new Error(MAX_SIZE);
    const maxSize = size === undefined ? DEFAULT_MAX_SIZE : Number(size);
    return copyVerb('/copy/download', { attachments: flags.has('--with-attachments'), max_size: maxSize, cwd: process.cwd() });
  }
  if (valued !== -1 || flags.has('--with-attachments')) throw unexpected(valued !== -1 ? '--max-size' : '--with-attachments', DOWNLOAD_USAGE);
  const { file, ...selected } = await argumentsOf(argument);
  if (typeof file !== 'string' || file === '') throw new Error('download needs "file", the local file to write');
  const written = resolve(file);
  await downloaded(
    async () => {
      const file = fileInfo(await called('info', selected));
      if (file === null) throw new Error(`${String(selected.path)} holds no binary file; shell reads its text`);
      return file;
    },
    async (url) => {
      const answer = await opened(url, 'GET', {}, WAY);
      return { status: answer.statusCode!, body: answer };
    },
    written,
    String(selected.path),
  );
  return written;
}

async function described(file: string): Promise<Description> {
  let held: { sha256: string; bytes: number };
  try {
    held = await fileDigest(file);
  } catch (error) {
    throw unreadable(file, error);
  }
  const mediaType = mediaTypeOf(file);
  return { bytes: held.bytes, sha256: held.sha256, ...(mediaType === undefined ? {} : { media_type: mediaType }) };
}

async function finished(upload: string, path: unknown, partSha256: string[], operation: string): Promise<Finishing> {
  const text = await called('upload', { upload, path, part_sha256: partSha256 }, operation);
  const answer = parse(text) as object | null;
  return answer !== null && 'upload' in answer ? (answer as Finishing) : { text };
}

async function upload({ file, ...destination }: Record<string, unknown>): Promise<string> {
  if (file === undefined) return called('upload', destination);
  if (typeof file !== 'string' || file === '') throw new Error('upload needs "file", a local file');
  const description = await described(file);
  const answer = await called('upload', { ...destination, ...description });
  const declared = parse(answer) as { upload?: UploadParts } | null;
  if (declared?.upload === undefined) return answer;
  const accepted = await uploaded(declared.upload, {
    name: file,
    bytes: description.bytes,
    sha256: description.sha256,
    read: (start, end) => fileRange(file, start, end, (error) => unreadable(file, error)),
    send: (url, start, end, headers) => sentPart(url, file, start, end, headers, WAY),
    finish: (id, partSha256, operation) => finished(id, destination.path, partSha256, operation),
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
    else if ((arg === '-' || !arg.startsWith('-')) && given.positionals.length < positionals) given.positionals.push(arg);
    else throw unexpected(arg, usage);
  }
  return given;
}

async function copyVerb(path: string, body: Record<string, unknown>): Promise<string> {
  const answer = JSON.parse(await bridged(path, body, socketPath ?? ownerSocket())) as { refused: boolean; text: string };
  if (answer.refused) throw new Error(answer.text);
  return answer.text;
}

async function uploadVerb(args: string[]): Promise<string> {
  const { flags, positionals: [argument] } = accepted(args, ['--help'], 1, UPLOAD_USAGE);
  if (flags.has('--help')) return `${UPLOAD_USAGE}\n${UPLOAD}`;
  if (argument !== undefined) return upload(await argumentsOf(argument));
  return copyVerb('/copy/upload', { cwd: process.cwd() });
}

async function argumentsOf(argument: string | undefined): Promise<Record<string, unknown>> {
  if (argument === undefined) return {};
  const given = argument === '-' ? await textOf(process.stdin) : argument;
  let parsed: unknown;
  try {
    parsed = JSON.parse(given);
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
  if (tool === undefined) throw new Error(`${name} is no Tool; house --help lists the Tools`);
  return [listed(tool), ...argumentLines(tool.inputSchema, tool.inputSchema, '  ', true)].join('\n');
}

async function house(args: string[]): Promise<string | undefined> {
  const { flags, positionals: [verb, argument] } = accepted(args, ['--help'], 2, USAGE);
  if (flags.has('--help') && argument !== undefined) throw unexpected('--help', USAGE);
  // house help <name> runs as house <name> --help, so both forms answer alike.
  if (verb === 'help' && argument !== undefined) return run([argument, '--help']);
  if (verb === undefined || verb === 'help') {
    const listing = (await tools()).flatMap((tool) =>
      tool.description === undefined ? [tool.name, ...argumentLines(tool.inputSchema, tool.inputSchema, '  ', false)] : [listed(tool)],
    );
    return [USAGE, HELP, ...[...KIT_VERBS].map(([name, { about }]) => `${name}: ${about}`), UPLOAD, DOWNLOAD, AGENT_RUN, ...listing].join('\n');
  }
  if (flags.has('--help')) return toolHelp(verb);
  if (verb === 'update') return update(await argumentsOf(argument));
  return called(verb, await argumentsOf(argument));
}

async function called(name: string, args: Record<string, unknown>, operation?: string): Promise<string> {
  return toolText(await mcp<ToolResult>('tools/call', { name, arguments: args }, operation));
}

function toolText(result: ToolResult): string {
  const text = result.content.map((content) => content.text).join('\n');
  if (result.isError === true) throw new Error(said(text.replace(/\n+$/, '')));
  return text;
}

async function inLocalCopy(cwd: string): Promise<boolean> {
  for (let folder = cwd; ; folder = dirname(folder)) {
    if ((await stat(join(folder, MANIFEST)).catch(() => null))?.isFile() === true) return true;
    if (dirname(folder) === folder) return false;
  }
}

async function update(args: Record<string, unknown>): Promise<string> {
  const cwd = process.cwd();
  const through = socketPath ?? ((await inLocalCopy(cwd)) ? ownerSocket() : undefined);
  if (through === undefined) return called('update', args);
  const answer = JSON.parse(await bridged(UPDATE_PATH, { message: rpc('tools/call', { name: 'update', arguments: args }), cwd }, through)) as {
    result?: ToolResult;
    error?: { message: string };
  };
  if (answer.error !== undefined) throw new Error(said(answer.error.message));
  return toolText(answer.result!);
}

function counted(usage: string, about: string, operands: number, args: string[], verb: (operands: string[]) => Promise<void>): Promise<void> {
  const { values, positionals } = parseArgs({ args, options: { help: { type: 'boolean', default: false } }, allowPositionals: true });
  if (positionals.length > operands) throw unexpected(positionals[operands]!, usage);
  if (!values.help) return verb(positionals);
  process.stdout.write(`${usage}\n  ${about}\n`);
  return Promise.resolve();
}

const LOGOUT = 'disconnects this computer and stops the Kit process';
const RESIDENT = "keeps this Environment connected; Kit's service runs it";
const SETTINGS = "prints Kit's settings, or changes which skills Kit installs or where its workspace is";
const GIT_CREDENTIAL = "answers git with this computer's House credential; git runs it";
const KIT_VERBS = new Map<string, KitVerb>([
  [
    'login',
    {
      about: 'connects this computer to House as an Environment, by a link you confirm or a login code',
      connection: true,
      run: async (args) => (await import('./login.ts')).login(args),
    },
  ],
  [
    'logout',
    {
      about: LOGOUT,
      connection: true,
      run: async (args) => counted('usage: house logout', LOGOUT, 0, args, (await import('./logout.ts')).logout),
    },
  ],
  [
    'connect',
    {
      about: "connects this computer, keeping the Environment it has, and starts Kit's service; the install runs it",
      connection: true,
      run: async (args) => (await import('./connect.ts')).connect(args),
    },
  ],
  [
    'resident',
    {
      about: RESIDENT,
      connection: true,
      run: async (args) => counted('usage: house resident', RESIDENT, 0, args, (await import('./resident.ts')).resident),
    },
  ],
  [
    'settings',
    {
      about: SETTINGS,
      connection: true,
      run: async (args) => {
        const { kitSettings, SETTINGS_USAGE } = await import('./settings.ts');
        return counted(SETTINGS_USAGE, SETTINGS, Number.POSITIVE_INFINITY, args, kitSettings);
      },
    },
  ],
  [
    'git-credential',
    {
      about: GIT_CREDENTIAL,
      connection: false,
      run: async (args) => {
        const { answerGitCredential } = await import('./app-git.ts');
        return counted('usage: house git-credential <get|store|erase>', GIT_CREDENTIAL, 1, args, ([operation]) => answerGitCredential(operation));
      },
    },
  ],
]);

async function kitVerb(name: string, verb: KitVerb, args: string[]): Promise<undefined> {
  if (verb.connection && socketPath !== undefined && !args.includes('--help')) throw new Error(`house ${name} ${INSIDE}`);
  proxyUnlessRelayed();
  await verb.run(args);
  return undefined;
}

async function agentRunVerb(args: string[]): Promise<undefined> {
  const { agentRun } = await import('./agent-run.ts');
  await agentRun(args, { call: (name, args) => called(name, args), socket: socketPath ?? ownerSocket(), inside: socketPath !== undefined }, AGENT_RUN);
  return undefined;
}

function run(argv: string[]): Promise<string | undefined> {
  const named = argv.findIndex((arg) => !arg.startsWith('-'));
  const rest = argv.filter((_arg, index) => index !== named);
  const verb = KIT_VERBS.get(argv[named] ?? '');
  if (verb !== undefined) return kitVerb(argv[named]!, verb, rest);
  if (argv[named] === 'help' && argv[named + 1] === 'agent' && argv[named + 2] === 'run' && argv.length === 3) return agentRunVerb(['--help']);
  if (argv[named] === 'agent' && argv[named + 1] === 'run') return agentRunVerb(argv.filter((_arg, index) => index !== named && index !== named + 1));
  if (argv[named] === 'upload') return uploadVerb(rest);
  if (argv[named] === 'download') return download(rest);
  return house(argv);
}

const argv = process.argv.slice(2);
run(argv).then(
  (text) => {
    if (text === undefined) return;
    process.stdout.write(`${text}\n`);
    if (argv[0] === 'shell') process.exitCode = Number(/^exit: (\d+)(?:\n|$)/.exec(text)?.[1] ?? 0);
  },
  (error: unknown) => {
    process.stderr.write(`house: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

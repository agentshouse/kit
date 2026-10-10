#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request, setGlobalProxyFromEnv } from 'node:http';
import { basename, join } from 'node:path';
import type { ToolResult } from './bridge.ts';
import { kitHome, readOwnAgent } from './home.ts';
import { callHouse, rpc, UNREACHABLE, type Message } from './mcp.ts';
import { refusalOf } from './refusals.ts';

interface Tool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

interface Declared {
  attachment: string;
  upload?: { url: string; operation: string };
}

interface Saved {
  attachment: string;
  upload_failure?: string;
}

const USAGE = "usage: house <tool> ['<arguments as JSON>']";
const PUSH_USAGE = 'usage: house push [commit] [--owner]';
const PUSH = "push [commit]: sends the Local copy's committed changes to House";
const ARGUMENTS = `the arguments are one JSON object in single quotes, like house search '{"query":"invoice"}'`;
const CLOSED = "this conversation's House connection is closed; nothing to do from here";
const REVOKED = 'this conversation no longer has House access; nothing to do from here';
const UNCONNECTED = "this computer's own agent has no House connection; run kit login";
const DISCONNECTED = "House no longer accepts this computer's own agent; run kit login";
const socketPath = process.env.HOUSE_BRIDGE;

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
    sent.on('error', () => reject(new Error(CLOSED)));
    sent.end(body instanceof Buffer ? body : JSON.stringify(body));
  });
}

async function direct(message: Message): Promise<string> {
  const ownAgent = await readOwnAgent();
  if (ownAgent === null) throw new Error(UNCONNECTED);
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

async function upload(path: unknown, roomRef: unknown, missing: string): Promise<string> {
  if (typeof path !== 'string' || path === '') throw new Error(missing);
  const bytes = await localFile(path);
  const declared = JSON.parse(
    await bridged('/kit/attachments/upload', {
      ...(roomRef === undefined ? {} : { room_ref: roomRef }),
      name: basename(path),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  ) as Declared;
  if (declared.upload === undefined) return declared.attachment;
  const saved = JSON.parse(
    await bridged(declared.upload.url, bytes, {
      'content-type': 'application/octet-stream',
      'x-house-byte-operation': declared.upload.operation,
    }),
  ) as Saved;
  if (saved.upload_failure !== undefined) throw new Error(`${path} was not saved: ${saved.upload_failure}; call again later`);
  return saved.attachment;
}

async function push(args: string[]): Promise<string> {
  if (args.includes('--help')) return PUSH_USAGE;
  const owner = args.includes('--owner');
  const commit = args.find((arg) => arg !== '--owner') ?? 'HEAD';
  if (owner && socketPath !== undefined) throw new Error('--owner is not for Agent conversations; run house push without it');
  if (!owner && socketPath === undefined) throw new Error('outside an Agent conversation, house push needs --owner');
  const pushed = JSON.parse(
    await bridged('/git/push', { cwd: process.cwd(), commit }, undefined, owner ? join(kitHome(), 'owner.sock') : socketPath),
  ) as { refused: boolean; text: string };
  if (pushed.refused) throw new Error(pushed.text);
  return pushed.text;
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

async function house([verb, argument]: string[]): Promise<string> {
  if (verb === undefined || verb === '--help' || verb === 'help') {
    return [USAGE, 'help', PUSH, ...(await tools()).map((tool) => (tool.description === undefined ? tool.name : `${tool.name}: ${tool.description}`))].join('\n');
  }
  if (argument === '--help') {
    const tool = (await tools()).find((listed) => listed.name === verb);
    if (tool === undefined) throw new Error(`${verb} is no Tool; house find_command '{"query":"${verb}"}' finds Commands`);
    return [...(tool.description === undefined ? [] : [tool.description]), JSON.stringify(tool.inputSchema)].join('\n');
  }
  const args = argumentsOf(argument);
  if (socketPath !== undefined && verb === 'upload_attachment') {
    return JSON.stringify({ attachment: await upload(args.path, args.room_ref, 'upload_attachment needs "path", a local file') });
  }
  if (socketPath !== undefined && verb === 'append_record' && Array.isArray(args.attachments)) {
    const attachments: string[] = [];
    for (const path of args.attachments) {
      attachments.push(await upload(path, args.room_ref, 'each attachments entry is the path of a local file'));
    }
    args.attachments = attachments;
  }
  const result = await mcp<ToolResult>('tools/call', { name: verb, arguments: args });
  const text = result.content.map((content) => content.text).join('\n');
  if (result.isError === true) throw new Error(text.replace(/\n+$/, ''));
  return text;
}

const argv = process.argv.slice(2);
(argv[0] === 'push' ? push(argv.slice(1)) : house(argv)).then(
  (text) => {
    process.stdout.write(`${text}\n`);
    if (argv[0] === 'shell') process.exitCode = Number(/^exit: (\d+)(?:\n|$)/.exec(text)?.[1] ?? 0);
  },
  (error: unknown) => {
    process.stderr.write(`house: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

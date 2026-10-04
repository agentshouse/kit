#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { basename, join } from 'node:path';
import type { ToolResult } from './bridge.ts';
import { kitHome } from './home.ts';
import { refusalOf } from './refusals.ts';

interface Tool {
  name: string;
  description: string;
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
const GIT_USAGE = 'usage: house git push [commit] [--owner]';
const ARGUMENTS = `the arguments are one JSON object in single quotes, like house search '{"query":"invoice"}'`;
const CLOSED = "this conversation's House connection is closed; nothing to do from here";
const REVOKED = 'this conversation no longer has House access; nothing to do from here';
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

async function mcp<T>(method: string, params: object): Promise<T> {
  const answer = JSON.parse(await bridged('/', { jsonrpc: '2.0', id: randomUUID(), method, params })) as {
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

async function gitPush(args: string[]): Promise<string> {
  if (args.includes('--help')) return GIT_USAGE;
  if (args[0] !== 'push') throw new Error('only house git push [commit] exists; use plain git for the rest');
  const owner = args.includes('--owner');
  const commit = args.slice(1).find((arg) => arg !== '--owner') ?? 'HEAD';
  if (owner && socketPath !== undefined) throw new Error('--owner is not for Agent conversations; run house git push without it');
  if (!owner && socketPath === undefined) throw new Error('outside an Agent conversation, house git push needs --owner');
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
  if (verb === undefined || verb === '--help') {
    return [USAGE, 'git push [commit]', ...(await tools()).map((tool) => `${tool.name}: ${tool.description}`)].join('\n');
  }
  if (argument === '--help') {
    const tool = (await tools()).find((listed) => listed.name === verb);
    if (tool === undefined) throw new Error(`${verb} is no Tool; house find_command '{"query":"${verb}"}' finds Commands`);
    return `${tool.description}\n${JSON.stringify(tool.inputSchema)}`;
  }
  const args = argumentsOf(argument);
  if (verb === 'upload_attachment') {
    return JSON.stringify({ attachment: await upload(args.path, args.room_ref, 'upload_attachment needs "path", a local file') });
  }
  if (verb === 'append_record' && Array.isArray(args.attachments)) {
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
if (argv[0] !== 'git' && socketPath === undefined) {
  process.stderr.write('house: house runs inside an Agent conversation\n');
  process.exitCode = 1;
} else {
  (argv[0] === 'git' ? gitPush(argv.slice(1)) : house(argv)).then(
    (text) => {
      process.stdout.write(`${text}\n`);
    },
    (error: unknown) => {
      process.stderr.write(`house: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

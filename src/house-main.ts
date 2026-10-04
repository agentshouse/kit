#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { basename, join } from 'node:path';
import type { ToolResult } from './bridge.ts';
import { kitHome } from './home.ts';

interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
}

interface Declared {
  upload: { url: string; operation: string };
}

const USAGE = "usage: house <tool> ['<arguments as JSON>']";
const GIT_HELP = 'Submit a Room commit to House; default HEAD. Use --owner only outside an Agent conversation. Native git push is not a House remote.';
const GIT_USAGE = `usage: house git push [commit] [--owner]\n${GIT_HELP}`;
const socketPath = process.env.HOUSE_BRIDGE;

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
        else reject(new Error(`${path} answered ${answer.statusCode}: ${text}`));
      });
    });
    sent.on('error', reject);
    sent.end(body instanceof Buffer ? body : JSON.stringify(body));
  });
}

async function mcp<T>(method: string, params: object): Promise<T> {
  const answer = JSON.parse(await bridged('/', { jsonrpc: '2.0', id: 1, method, params })) as {
    result?: T;
    error?: { message: string };
  };
  if (answer.error !== undefined) throw new Error(answer.error.message);
  return answer.result!;
}

async function tools(): Promise<Tool[]> {
  return (await mcp<{ tools: Tool[] }>('tools/list', {})).tools;
}

async function upload(path: string, roomRef: unknown): Promise<string> {
  const bytes = await readFile(path);
  const declared = JSON.parse(
    await bridged('/kit/attachments/upload', {
      ...(roomRef === undefined ? {} : { room_ref: roomRef }),
      version: randomUUID(),
      name: basename(path),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  ) as Declared;
  return bridged(declared.upload.url, bytes, {
    'content-type': 'application/octet-stream',
    'x-house-byte-operation': declared.upload.operation,
  });
}

async function gitPush(args: string[]): Promise<string> {
  if (args.includes('--help')) return GIT_USAGE;
  if (args[0] !== 'push') throw new Error(GIT_USAGE);
  const owner = args.includes('--owner');
  const commit = args.slice(1).find((arg) => arg !== '--owner') ?? 'HEAD';
  if (owner && socketPath !== undefined) throw new Error('house git push --owner runs outside an Agent conversation');
  if (!owner && socketPath === undefined) throw new Error('outside an Agent conversation, house git push needs --owner');
  const pushed = JSON.parse(
    await bridged('/git/push', { cwd: process.cwd(), commit }, undefined, owner ? join(kitHome(), 'owner.sock') : socketPath),
  ) as { refused: boolean; text: string };
  if (pushed.refused) throw new Error(pushed.text);
  return pushed.text;
}

async function house([verb, argument]: string[]): Promise<string> {
  if (verb === undefined || verb === '--help') {
    return [USAGE, `git push [commit]: ${GIT_HELP}`, ...(await tools()).map((tool) => `${tool.name}: ${tool.description}`)].join('\n');
  }
  if (argument === '--help') {
    const tool = (await tools()).find((listed) => listed.name === verb);
    if (tool === undefined) throw new Error(`House has no tool ${verb}`);
    return `${tool.description}\n${JSON.stringify(tool.inputSchema, null, 2)}`;
  }
  const args = (argument === undefined ? {} : JSON.parse(argument)) as Record<string, unknown>;
  if (verb === 'upload_attachment') return upload(String(args.path), args.room_ref);
  if (verb === 'append_record' && Array.isArray(args.attachments)) {
    const attachments: string[] = [];
    for (const path of args.attachments) {
      attachments.push((JSON.parse(await upload(String(path), args.room_ref)) as { attachment: string }).attachment);
    }
    args.attachments = attachments;
  }
  const result = await mcp<ToolResult>('tools/call', { name: verb, arguments: args });
  const text = result.content.map((content) => content.text).join('\n');
  if (result.isError === true) throw new Error(text);
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

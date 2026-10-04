import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { delimiter, join } from 'node:path';
import { parse } from 'yaml';
import type { House } from './api.ts';
import { KIT_VERSION } from './clis.ts';
import {
  changedPaths,
  refusalCode,
  type Caller,
  type Observed,
  type Submitted,
  type Upload,
  type WorkingCopies,
} from './copies.ts';
import { kitHome, readEnrolment } from './home.ts';
import { operationId } from './operation.ts';
import type { Edit } from './translate.ts';

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

export interface Bridge {
  env: Record<string, string>;
  tool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): void;
}

interface Message {
  method: string;
  params?: Record<string, unknown>;
}

interface Forwarded {
  status: number;
  text: string;
}

const MCP_PROTOCOL_VERSION = '2026-07-28';
const MCP_REQUEST_BYTES = 4 * 1024 * 1024;
const FORWARDED = new Set(['/', '/kit/attachments/upload']);

export async function received(request: IncomingMessage): Promise<string> {
  let text = '';
  request.setEncoding('utf8');
  for await (const chunk of request) text += chunk;
  return text;
}

function relay(request: IncomingMessage, response: ServerResponse, target: URL, authorization?: string): void {
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const forwarded = send(
    target,
    {
      method: request.method,
      headers: { ...request.headers, host: target.host, ...(authorization === undefined ? {} : { authorization }) },
    },
    (answer) => {
      response.writeHead(answer.statusCode!, answer.headers);
      answer.pipe(response);
    },
  );
  forwarded.on('error', () => response.destroy());
  request.pipe(forwarded);
}

function answered(forwarded: Forwarded): { text: string } | { refused: { code: string; text: string } } {
  if (forwarded.status >= 500) throw new Error(`House answered ${forwarded.status}`);
  if (forwarded.status !== 200) return { refused: { code: refusalCode(forwarded.text), text: forwarded.text } };
  const answer = JSON.parse(forwarded.text) as { result?: ToolResult; error?: { message: string } };
  if (answer.error !== undefined) return { refused: { code: refusalCode(answer.error.message), text: answer.error.message } };
  const text = answer.result!.content.map((content) => content.text).join('\n');
  return answer.result!.isError === true ? { refused: { code: refusalCode(text), text } } : { text };
}

function editAnswer(forwarded: Forwarded): Submitted {
  const answer = answered(forwarded);
  if ('refused' in answer) return answer;
  const { results } = parse(answer.text) as { results: { path: string; op: string; revision: string; from?: string }[] };
  return {
    accepted: results.flatMap((result) => [
      ...(result.from === undefined ? [] : [{ path: result.from, revision: null, content: null }]),
      { path: result.path, revision: result.op === 'remove' ? null : result.revision },
    ]),
  };
}

export async function openBridge(
  house: House,
  copies: WorkingCopies,
  conversationId: string,
  signal: AbortSignal,
): Promise<Bridge> {
  const origin = (await readEnrolment())!.house;
  const { credential } = await house.post<{ credential: string }>(
    `/kit/conversations/${conversationId}/credential`,
    {},
    signal,
  );

  const closed = new AbortController();
  const body = (message: Message, operation: string | null): string =>
    JSON.stringify({
      ...message,
      params: {
        ...message.params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': { name: '@agentshouse/kit', version: KIT_VERSION },
          'io.modelcontextprotocol/clientCapabilities': {},
          ...(operation === null ? {} : { 'agents.house/agent-operation': operation }),
        },
      },
    });

  const send = async (message: Message, operation: string | null): Promise<Forwarded> => {
    const tool = message.method === 'tools/call' ? String(message.params?.name) : null;
    const answer = await fetch(new URL('/', origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`,
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        'mcp-method': message.method,
        ...(tool === null ? {} : { 'mcp-name': tool }),
      },
      body: body(message, operation),
      signal: closed.signal,
    });
    return { status: answer.status, text: await answer.text() };
  };

  const call = (name: string, args: Record<string, unknown>): Message =>
    ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as Message;

  const staged = async (operation: string, changes: Edit[]): Promise<Upload | { refused: { code: string; text: string } }> => {
    const bytes = Buffer.from(JSON.stringify({ changes }));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const prepared = answered(
      await send(
        call('run_command', {
          command: 'prepare_edit_upload',
          arguments: { paths: changedPaths(changes), bytes: bytes.length, sha256 },
        }),
        operation,
      ),
    );
    if ('refused' in prepared) return prepared;
    const { transfer } = parse(prepared.text) as { transfer: { url: string; operation: string } };
    const posted = await fetch(transfer.url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.concat([Buffer.from(`${transfer.operation}\n`), bytes]),
      signal: closed.signal,
    });
    const text = await posted.text();
    if (posted.status >= 500) throw new Error(`House answered ${posted.status}`);
    if (!posted.ok) return { refused: { code: refusalCode(text), text } };
    const held = (JSON.parse(text) as { transfer: { url: string; operation: string } }).transfer;
    return { url: held.url, operation: held.operation, bytes: bytes.length, sha256 };
  };

  const forward = async (path: string, text: string): Promise<Forwarded> => {
    if (path === '/') {
      const message = JSON.parse(text) as Message;
      const tool = message.method === 'tools/call' ? String(message.params?.name) : null;
      const writes =
        tool !== null &&
        (
          await house.post<{ tools: { name: string; writes: boolean }[] }>('/kit/tools/mutations', {}, closed.signal)
        ).tools.some((listed) => listed.name === tool && listed.writes);
      return send(message, writes ? operationId() : null);
    }
    const answer = await fetch(new URL(path, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: text,
      signal: closed.signal,
    });
    return { status: answer.status, text: await answer.text() };
  };

  const caller: Caller = {
    key: `conversation:${conversationId}`,
    submit: async (operation, changes, held, retain) => {
      const inline = call('edit', { changes });
      let upload = held;
      if (upload === undefined && Buffer.byteLength(body(inline, operation)) > MCP_REQUEST_BYTES) {
        const prepared = await staged(operation, changes);
        if ('refused' in prepared) return prepared;
        upload = prepared;
        await retain(upload);
      }
      return editAnswer(
        await send(upload === undefined ? inline : call('edit', { paths: changedPaths(changes), upload }), operation),
      );
    },
  };

  const local = async (path: string, text: string): Promise<Forwarded> => {
    if (path === '/git/push') {
      const { cwd, commit } = JSON.parse(text) as { cwd: string; commit: string };
      return { status: 200, text: JSON.stringify(await copies.push(cwd, commit, caller)) };
    }
    if (path === '/git/observed') {
      await copies.observed(JSON.parse(text) as Observed);
      return { status: 200, text: '{}' };
    }
    return FORWARDED.has(path) ? forward(path, text) : { status: 404, text: '' };
  };

  const sockets = join(kitHome(), 'bridges');
  await mkdir(sockets, { recursive: true, mode: 0o700 });
  const socketPath = join(sockets, `${randomUUID()}.sock`);
  const bridge = createServer(async (request, response) => {
    try {
      const path = request.url ?? '';
      if (URL.canParse(path)) {
        relay(request, response, new URL(path));
        return;
      }
      const answered = await local(path, await received(request));
      response.writeHead(answered.status, { 'content-type': 'application/json' }).end(answered.text);
    } catch (error) {
      response.writeHead(502).end(error instanceof Error ? error.message : String(error));
    }
  });
  bridge.listen(socketPath);
  await once(bridge, 'listening');

  const app = new URL('/app/', origin).href;
  const authorization = `Basic ${Buffer.from(`house:${credential}`).toString('base64')}`;
  const git = createServer((request, response) => {
    const target = new URL(request.url ?? '', app);
    if (!target.href.startsWith(app)) {
      response.writeHead(404).end();
      return;
    }
    relay(request, response, target, authorization);
  });
  git.listen(0, '127.0.0.1');
  await once(git, 'listening');
  const proxy = `http://127.0.0.1:${(git.address() as AddressInfo).port}`;

  return {
    env: {
      HOUSE_BRIDGE: socketPath,
      PATH: `${join(kitHome(), 'shim')}${delimiter}${process.env.PATH ?? ''}`,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${proxy}/app/.insteadOf`,
      GIT_CONFIG_VALUE_0: app,
    },
    tool: async (name, args) => {
      const forwarded = await forward(
        '/',
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      );
      if (forwarded.status !== 200) throw new Error(`House refused ${name} with ${forwarded.status}: ${forwarded.text}`);
      const answer = JSON.parse(forwarded.text) as { result?: ToolResult; error?: { message: string } };
      if (answer.error !== undefined) throw new Error(`House refused ${name}: ${answer.error.message}`);
      return answer.result!;
    },
    close: () => {
      closed.abort();
      bridge.close();
      bridge.closeAllConnections();
      git.close();
      git.closeAllConnections();
    },
  };
}

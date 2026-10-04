import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { House } from './api.ts';
import { KIT_VERSION } from './clis.ts';
import { kitHome, readEnrolment } from './home.ts';

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
const FORWARDED = new Set(['/', '/kit/attachments/upload']);

function operationId(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function received(request: IncomingMessage): Promise<string> {
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

export async function openBridge(house: House, conversationId: string, signal: AbortSignal): Promise<Bridge> {
  const origin = (await readEnrolment())!.house;
  const { credential } = await house.post<{ credential: string }>(
    `/kit/conversations/${conversationId}/credential`,
    {},
    signal,
  );

  const closed = new AbortController();
  const mcp = async (message: Message) => {
    const params = message.params ?? {};
    const tool = message.method === 'tools/call' ? String(params.name) : null;
    const writes =
      tool !== null &&
      (
        await house.post<{ tools: { name: string; writes: boolean }[] }>('/kit/tools/mutations', {}, closed.signal)
      ).tools.some((listed) => listed.name === tool && listed.writes);
    return {
      headers: {
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        'mcp-method': message.method,
        ...(tool === null ? {} : { 'mcp-name': tool }),
      },
      body: {
        ...message,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: '@agentshouse/kit', version: KIT_VERSION },
            'io.modelcontextprotocol/clientCapabilities': {},
            ...(writes ? { 'agents.house/agent-operation': operationId() } : {}),
          },
        },
      },
    };
  };

  const forward = async (path: string, text: string): Promise<Forwarded> => {
    const call = path === '/' ? await mcp(JSON.parse(text) as Message) : null;
    const answer = await fetch(new URL(path, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}`, ...call?.headers },
      body: call === null ? text : JSON.stringify(call.body),
      signal: closed.signal,
    });
    return { status: answer.status, text: await answer.text() };
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
      const forwarded = FORWARDED.has(path) ? await forward(path, await received(request)) : { status: 404, text: '' };
      response.writeHead(forwarded.status, { 'content-type': 'application/json' }).end(forwarded.text);
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

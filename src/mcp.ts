import { randomUUID } from 'node:crypto';
import { KIT_VERSION } from './clis.ts';

export interface Message {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface Forwarded {
  status: number;
  text: string;
}

const MCP_PROTOCOL_VERSION = '2026-07-28';

export const UNREACHABLE = 'House is unreachable; call again in a minute';

export function rpc(method: string, params: Record<string, unknown>): Message {
  return { jsonrpc: '2.0', id: randomUUID(), method, params };
}

export function mcpBody(message: Message, operation: string | null): string {
  return JSON.stringify({
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
}

export async function callHouse(
  origin: string,
  credential: string,
  message: Message,
  operation: string | null = null,
  signal?: AbortSignal,
): Promise<Forwarded> {
  const tool = message.method === 'tools/call' ? String(message.params.name) : null;
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
    body: mcpBody(message, operation),
    signal,
  });
  return { status: answer.status, text: await answer.text() };
}

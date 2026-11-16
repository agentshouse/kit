import { KIT_WIRE, KIT_WIRE_HEADER } from '@agentshouse/kit-wire';
import { randomUUID } from 'node:crypto';
import { KIT_RELEASE } from './clis.ts';
import { readOwnAgent } from './home.ts';
import { refusalOf, retryable, type Refusal } from './refusals.ts';
import { relayed, selectRelay } from './relay.ts';

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

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const MCP_PROTOCOL_VERSION = '2026-07-28';

export const UNREACHABLE = 'House is unreachable; call again in a minute';
const UNCONNECTED = "this computer's own agent has no House connection; run kit login";
const DISCONNECTED = "House no longer accepts this computer's own agent; run kit login";
const UNCONFIRMED = 'with no result; a write may or may not have taken effect, so read before you repeat it';

export class Unsettled extends Error {}

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
        'io.modelcontextprotocol/clientInfo': { name: '@agentshouse/kit', version: KIT_RELEASE },
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
  const answer = await fetch(relayed(new URL('/', origin)), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credential}`,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': message.method,
      ...(tool === null ? {} : { 'mcp-name': tool }),
      [KIT_WIRE_HEADER]: KIT_WIRE,
    },
    body: mcpBody(message, operation),
    signal,
  });
  return { status: answer.status, text: await answer.text() };
}

export function unconfirmed(status: number): string {
  return `House answered ${status} ${UNCONFIRMED}`;
}

export async function ownAgentCall(message: Message): Promise<string> {
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

export function refusalIn(text: string, status: number): Refusal {
  return refusalOf(text) ?? { code: '', text: text === '' ? `House refused it with ${status}` : text, conflicts: [], detail: {} };
}

export function toolAnswer(forwarded: Forwarded): { text: string } | { refused: Refusal } {
  if (forwarded.status !== 200) return { refused: refusalIn(forwarded.text, forwarded.status) };
  const answer = JSON.parse(forwarded.text) as { result?: ToolResult; error?: { message: string } };
  if (answer.error !== undefined) return { refused: refusalIn(answer.error.message, forwarded.status) };
  const text = answer.result!.content.map((content) => content.text).join('\n');
  return answer.result!.isError === true ? { refused: refusalIn(text, forwarded.status) } : { text };
}

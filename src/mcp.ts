import { KIT_WIRE, KIT_WIRE_HEADER } from '@agentshouse/kit-wire';
import { randomUUID } from 'node:crypto';
import { KIT_RELEASE } from './clis.ts';
import { readEnrolment } from './home.ts';
import { operationId } from './operation.ts';
import { refusalOf, retryable, type Refusal } from './refusals.ts';
import { proxyUnlessRelayed, relayed } from './relay.ts';

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
const UNCONNECTED = 'this computer has no House connection; run kit login';
export const DISCONNECTED = 'House no longer accepts this computer; run kit login';
const UNCONFIRMED = 'with no result; a write may or may not have taken effect, so read before you repeat it';

export class Unsettled extends Error {}

export function rpc(method: string, params: Record<string, unknown>): Message {
  return { jsonrpc: '2.0', id: randomUUID(), method, params };
}

export interface Sending {
  operation?: string | null;
  named?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export function mcpBody(message: Message, { operation = null, named = {} }: Sending = {}): string {
  return JSON.stringify({
    ...message,
    params: {
      ...message.params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientInfo': { name: '@agentshouse/kit', version: KIT_RELEASE },
        'io.modelcontextprotocol/clientCapabilities': {},
        ...named,
        ...(operation === null ? {} : { 'agents.house/agent-operation': operation }),
      },
    },
  });
}

export async function callHouse(origin: string, credential: string, message: Message, sending: Sending = {}): Promise<Forwarded> {
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
    body: mcpBody(message, sending),
    signal: sending.signal,
  });
  return { status: answer.status, text: await answer.text() };
}

export function unconfirmed(status: number): string {
  return `House answered ${status} ${UNCONFIRMED}`;
}

export async function environmentCall(message: Message, operation = message.method === 'tools/call' ? operationId() : null): Promise<string> {
  const enrolment = await readEnrolment();
  if (enrolment === null) throw new Error(UNCONNECTED);
  proxyUnlessRelayed();
  const answer = await callHouse(enrolment.house, enrolment.credential, message, { operation }).catch(() => {
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

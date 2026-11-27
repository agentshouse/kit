import { KIT_WIRE, KIT_WIRE_HEADER } from '@agentshouse/kit-wire';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { KIT_RELEASE } from './clis.ts';
import { carried, retryAt } from './hold.ts';
import { readEnrolment } from './home.ts';
import { operationId } from './operation.ts';
import { namedWait, refusalOf, retryable, type Refusal } from './refusals.ts';
import { proxyUnlessRelayed } from './relay.ts';

export interface Message {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface Forwarded {
  status: number;
  text: string;
  admits?: number;
}

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const MCP_PROTOCOL_VERSION = '2026-07-28';

export const HELP_META_KEY = 'agents.house/help';

export const UNREACHABLE = 'House is unreachable; call again in a minute';
const UNCONNECTED = 'this computer has no House connection; run house login';
export const DISCONNECTED = 'House no longer accepts this computer; run house login';
const UNCONFIRMED = 'with no result; a write may or may not have taken effect, so read before you repeat it';

export class Unsettled extends Error {
  readonly after: number | null;

  constructor(message: string, after: number | null = null) {
    super(message);
    this.after = after;
  }
}

export function rpc(method: string, params: Record<string, unknown>): Message {
  return { jsonrpc: '2.0', id: randomUUID(), method, params };
}

export interface Sending {
  operation?: string | null;
  named?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export function ownCall(name: string, args: Record<string, unknown>): Message {
  return rpc('tools/call', { name, arguments: { ...args, long: true } });
}

export function mcpBody(message: Message, { operation = null, named = {} }: Sending = {}): string {
  const help = (message.params._meta as Record<string, unknown> | undefined)?.[HELP_META_KEY];
  return JSON.stringify({
    ...message,
    params: {
      ...message.params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientInfo': { name: '@agentshouse/kit', version: KIT_RELEASE },
        'io.modelcontextprotocol/clientCapabilities': {},
        ...(help === undefined ? {} : { [HELP_META_KEY]: help }),
        ...named,
        ...(operation === null ? {} : { 'agents.house/agent-operation': operation }),
      },
    },
  });
}

export async function callHouse(origin: string, credential: string, message: Message, sending: Sending = {}): Promise<Forwarded> {
  const tool = message.method === 'tools/call' ? String(message.params.name) : null;
  const answer = await carried(new URL('/', origin), {
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
  const admits = retryAt(answer.headers.get('retry-after'));
  return { status: answer.status, text: await answer.text(), ...(admits === null ? {} : { admits }) };
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
  throw retryable(answer.text) === false ? new Error(refusal) : new Unsettled(refusal, namedWait(answer.text));
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

export async function environmentTool(name: string, args: Record<string, unknown>): Promise<string> {
  const read = toolAnswer({ status: 200, text: await environmentCall(ownCall(name, args)) });
  if ('refused' in read) throw new Error(read.refused.text);
  return read.text;
}

export function answerDocument<T>(answer: string): T {
  const document = parseDocument(answer);
  if (document.errors.length > 0) throw new Error("House's answer could not be read");
  return document.toJS() as T;
}

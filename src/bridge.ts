import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { FUNCTION_RUN_META_KEY } from '@agentshouse/kit-wire';
import { parse } from 'yaml';
import { finalRefusal, HouseRefusal, retryDelay, retrying, type House } from './api.ts';
import type { Staged } from './binaries.ts';
import { loginPath } from './clis.ts';
import {
  changedPaths,
  DEFAULT_MAX_SIZE,
  UPLOAD_NEEDS_OWNER,
  type Answered,
  type Caller,
  type Change,
  type LocalCopies,
  type Submitted,
  type Upload,
} from './copies.ts';
import { fileInfo, instructionsText, type Finished } from './files.ts';
import { readEnrolment, readOwnAgent, socketDirectory } from './home.ts';
import { callHouse, DISCONNECTED, mcpBody, refusalIn, rpc, toolAnswer, UNREACHABLE, type Forwarded, type Message, type ToolResult } from './mcp.ts';
import { operationId } from './operation.ts';
import { refusalOf, retryable, stopsPush, type Refusal } from './refusals.ts';
import { relayed } from './relay.ts';

export interface Bridge {
  env: Record<string, string>;
  tool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): void;
}

interface Holder {
  key: string;
  origin: string;
  credential: string;
  named: Record<string, string>;
  ownAgent: boolean;
  owner: boolean;
  path: string | null;
}

class Said extends Error {}

const OWNER_IN_CONVERSATION = '--owner is not for Agent conversations; run house upload without it';

const MCP_REQUEST_BYTES = 4_000_000;

export async function received(request: IncomingMessage): Promise<string> {
  let text = '';
  request.setEncoding('utf8');
  for await (const chunk of request) text += chunk;
  return text;
}

function relay(request: IncomingMessage, response: ServerResponse, house: URL, authorization?: string): void {
  const target = relayed(house);
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

function pendingSeconds(forwarded: Forwarded): number | null {
  if (forwarded.status !== 200) return null;
  const { result } = JSON.parse(forwarded.text) as { result?: ToolResult };
  if (result === undefined || result.isError === true) return null;
  const text = result.content.map((content) => content.text).join('\n');
  if (!text.startsWith('{"pending":')) return null;
  const seconds = (JSON.parse(text) as { pending: { retry_after?: unknown } }).pending.retry_after;
  return typeof seconds === 'number' ? seconds : null;
}

function resendAfter(forwarded: Forwarded | null, attempt: number, pushing: boolean): number | null {
  if (forwarded === null) return retryDelay(attempt);
  if (forwarded.status !== 200) {
    if (pushing && stopsPush(refusalOf(forwarded.text))) return null;
    return retryable(forwarded.text) === false ? null : retryDelay(attempt);
  }
  const seconds = pendingSeconds(forwarded);
  return seconds === null ? null : seconds * 1000;
}

function editAnswer(forwarded: Forwarded): Submitted {
  const answer = toolAnswer(forwarded);
  if ('refused' in answer) return answer;
  const { results } = parse(answer.text) as { results: { path: string; revision?: string; from?: string; content?: string }[] };
  return {
    accepted: results.flatMap((result) => [
      ...(result.from === undefined ? [] : [{ path: result.from, revision: null, content: null }]),
      { path: result.path, revision: result.revision ?? null, ...(result.content === undefined ? {} : { content: result.content }) },
    ]),
  };
}

export async function openBridge(
  house: House,
  copies: LocalCopies,
  conversationId: string,
  signal: AbortSignal,
): Promise<Bridge> {
  const { credential } = await retrying(
    () => house.act('agent_update.credentials_issue', { conversation: conversationId }, signal),
    signal,
  );
  return bridgeFor(copies, {
    key: `conversation:${conversationId}`,
    origin: (await readEnrolment())!.house,
    credential,
    named: {},
    ownAgent: false,
    owner: false,
    path: [dirname(process.execPath), await loginPath()].join(delimiter),
  });
}

async function runCredential(house: House, run: string, signal: AbortSignal): Promise<string | null> {
  try {
    return (await retrying(() => house.act('agent_update.credentials_issue', { run }, signal), signal)).credential;
  } catch (error) {
    if (finalRefusal(error)) return null;
    throw error;
  }
}

export async function openRunBridge(house: House, copies: LocalCopies, run: string, signal: AbortSignal): Promise<Bridge | null> {
  const named = { [FUNCTION_RUN_META_KEY]: run };
  const ownAgent = await readOwnAgent();
  if (ownAgent !== null) {
    return bridgeFor(copies, {
      key: `function-run:${run}`,
      origin: ownAgent.house,
      credential: ownAgent.credential,
      named,
      ownAgent: true,
      owner: true,
      path: null,
    });
  }
  const credential = await runCredential(house, run, signal);
  if (credential === null) return null;
  const origin = (await readEnrolment())!.house;
  return bridgeFor(copies, { key: `function-run:${run}`, origin, credential, named, ownAgent: false, owner: true, path: null });
}

async function bridgeFor(copies: LocalCopies, holder: Holder): Promise<Bridge> {
  const { origin, credential, named, path } = holder;

  const closed = new AbortController();
  const sent = (message: Message, operation: string | null): Promise<Forwarded> =>
    callHouse(origin, credential, message, { operation, named, signal: closed.signal });

  const send = async (message: Message, asked: string | null, pushing = false): Promise<Forwarded> => {
    const operation = holder.ownAgent ? null : asked;
    if (operation === null) return sent(message, null);
    for (let attempt = 0; ; attempt++) {
      const forwarded = await sent(message, operation).catch((error: unknown) => {
        if (closed.signal.aborted) throw error;
        return null;
      });
      const after = resendAfter(forwarded, attempt, pushing);
      if (after === null) return forwarded!;
      // A Tool call House did not settle is sent again on the jittered curve, or after the wait House names for a pending one.
      await delay(after, undefined, { signal: closed.signal });
    }
  };

  const call = (name: string, args: Record<string, unknown>): Message => rpc('tools/call', { name, arguments: args });

  const staged = async (operation: string, changes: Change[]): Promise<Upload | { refused: Refusal }> => {
    const bytes = Buffer.from(JSON.stringify({ changes }));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const prepared = toolAnswer(
      await send(
        call('update', { op: 'stage', paths: changedPaths(changes), bytes: bytes.length, sha256 }),
        operation,
      ),
    );
    if ('refused' in prepared) return prepared;
    const { transfer } = parse(prepared.text) as { transfer: { url: string; operation: string } };
    let text: string;
    try {
      text = await retrying(async () => {
        const posted = await fetch(relayed(transfer.url), {
          method: 'POST',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: Buffer.concat([Buffer.from(`${transfer.operation}\n`), bytes]),
          signal: closed.signal,
        });
        const answer = await posted.text();
        if (!posted.ok) throw new HouseRefusal('/', posted.status, answer);
        return answer;
      }, closed.signal);
    } catch (error) {
      if (!finalRefusal(error)) throw error;
      return { refused: refusalIn(error.text, error.status) };
    }
    const held = (JSON.parse(text) as { transfer: { url: string; operation: string } }).transfer;
    return { url: held.url, operation: held.operation, bytes: bytes.length, sha256 };
  };

  const forward = (text: string): Promise<Forwarded> => {
    const message = JSON.parse(text) as Message;
    return send(message, message.method === 'tools/call' ? operationId() : null);
  };

  const info = async (args: Record<string, unknown>): Promise<string> => {
    const answer = toolAnswer(await send(call('info', args), operationId()));
    if ('refused' in answer) throw new Error(answer.refused.text);
    return answer.text;
  };

  const caller: Caller = {
    key: holder.key,
    submit: async (operation, changes, held, retain) => {
      const inline = call('update', { changes });
      let upload = held;
      if (upload === undefined && Buffer.byteLength(mcpBody(inline, { operation, named })) > MCP_REQUEST_BYTES) {
        const prepared = await staged(operation, changes);
        if ('refused' in prepared) return prepared;
        upload = prepared;
        await retain(upload);
      }
      return editAnswer(
        await send(upload === undefined ? inline : call('update', { paths: changedPaths(changes), upload }), operation, true),
      );
    },
    finish: async (upload, path, partSha256) => {
      const answer = toolAnswer(
        await send(call('upload', { upload, path, part_sha256: partSha256 }), operationId(), true),
      );
      if ('refused' in answer) throw new Error(answer.refused.text);
      return parse(answer.text) as Finished<Staged>;
    },
    info: async (path, revision) => fileInfo(await info({ path, ...(revision === undefined ? {} : { ref: revision }) })),
    instructions: async (root) => instructionsText(root, await info({ path: root })),
  };

  const uploader = holder.owner ? copies.owner : caller;

  const local = async (path: string, text: string): Promise<Forwarded> => {
    if (path === '/copy/upload') {
      const { cwd, owner } = JSON.parse(text) as { cwd: string; owner: boolean };
      const uploaded: Answered =
        owner === holder.owner ? await copies.upload(cwd, uploader) : { refused: true, text: owner ? OWNER_IN_CONVERSATION : UPLOAD_NEEDS_OWNER };
      return { status: 200, text: JSON.stringify(uploaded) };
    }
    if (path === '/copy/download') {
      const { attachments = false, max_size: maxSize = DEFAULT_MAX_SIZE } = JSON.parse(text) as { attachments?: boolean; max_size?: number };
      return { status: 200, text: JSON.stringify(await copies.download(uploader, { attachments, maxSize })) };
    }
    if (path !== '/') return { status: 404, text: '' };
    const forwarded = await forward(text);
    if (holder.ownAgent && forwarded.status === 401) throw new Said(DISCONNECTED);
    return forwarded;
  };

  const socketPath = join(socketDirectory(), `${randomUUID()}.sock`);
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
      if (error instanceof Said) {
        response.writeHead(502).end(error.message);
        return;
      }
      if (error instanceof HouseRefusal) {
        response.writeHead(error.status, { 'content-type': 'application/json' }).end(error.text);
        return;
      }
      const verb = request.url === '/copy/upload' || request.url === '/copy/download';
      response.writeHead(502).end(verb && error instanceof Error ? error.message : UNREACHABLE);
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
      ...(path === null ? {} : { PATH: path }),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${proxy}/app/.insteadOf`,
      GIT_CONFIG_VALUE_0: app,
    },
    tool: async (name, args) => {
      const forwarded = await forward(JSON.stringify(call(name, args)));
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

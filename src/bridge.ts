import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { CONVERSATION_GIT_HEADER, CONVERSATION_META_KEY, FUNCTION_RUN_META_KEY } from '@agentshouse/kit-wire';
import { parse } from 'yaml';
import { finalRefusal, HouseRefusal, resendDelay, retrying } from './api.ts';
import type { Staged } from './binaries.ts';
import { loginPath } from './clis.ts';
import { changedPaths, DEFAULT_MAX_SIZE, updateAnswer, updateChanges, UPDATE_PATH, type Caller, type Change, type LocalCopies, type Updating, type Upload } from './copies.ts';
import { fileInfo, roomInstructions, type Finished } from './files.ts';
import { answered, carried, held, judgement, type Answer, type Pass } from './hold.ts';
import { readEnrolment, socketDirectory } from './home.ts';
import { callHouse, mcpBody, ownCall, refusalIn, toolAnswer, UNREACHABLE, type Forwarded, type Message, type ToolResult } from './mcp.ts';
import { operationId } from './operation.ts';
import { namedWait, REFUSAL_HEADER, refusalOf, retryable, stopsPush, type Refusal } from './refusals.ts';
import { relayed } from './relay.ts';
import type { RunWaits } from './run-waits.ts';
import { WAIT_PATH } from './agent-run.ts';

export interface Bridge {
  env: Record<string, string>;
  caller: Caller;
  tool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): void;
}

interface Holder {
  key: string;
  conversation: string | null;
  named: Record<string, string>;
  git: Record<string, string>;
  path: string | null;
}

const MCP_REQUEST_BYTES = 4_000_000;

export async function received(request: IncomingMessage): Promise<string> {
  let text = '';
  request.setEncoding('utf8');
  for await (const chunk of request) text += chunk;
  return text;
}

function relay(request: IncomingMessage, response: ServerResponse, house: URL, called?: { headers: Record<string, string>; pass: Pass }): void {
  let settled = called === undefined;
  const settle = (answer: Answer | null) => {
    if (!settled) answered(called!.pass, answer);
    settled = true;
  };
  const target = relayed(house);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const forwarded = send(
    target,
    {
      method: request.method,
      headers: { ...request.headers, host: target.host, ...called?.headers },
    },
    (answer) => {
      const status = answer.statusCode!;
      const refusal = answer.headers[REFUSAL_HEADER];
      settle(judgement(status, answer.headers['retry-after'] ?? null, typeof refusal === 'string' ? refusal : null));
      response.writeHead(status, answer.headers);
      answer.pipe(response);
    },
  );
  forwarded.on('error', () => {
    settle(null);
    response.destroy();
  });
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
  if (forwarded === null) return resendDelay(null, attempt);
  if (forwarded.status === 401) return null;
  if (forwarded.status !== 200) {
    if (pushing && stopsPush(refusalOf(forwarded.text))) return null;
    return retryable(forwarded.text) === false ? null : (namedWait(forwarded.text) ?? resendDelay(null, attempt));
  }
  const seconds = pendingSeconds(forwarded);
  return seconds === null ? null : seconds * 1000;
}

function conversationHolder(conversationId: string, path: string | null): Holder {
  return {
    key: `conversation:${conversationId}`,
    conversation: conversationId,
    named: { [CONVERSATION_META_KEY]: conversationId },
    git: { [CONVERSATION_GIT_HEADER]: conversationId },
    path,
  };
}

export async function openBridge(copies: LocalCopies, waits: RunWaits, conversationId: string): Promise<Bridge> {
  return bridgeFor(copies, waits, conversationHolder(conversationId, [dirname(process.execPath), await loginPath()].join(delimiter)));
}

export function openRunBridge(copies: LocalCopies, waits: RunWaits, run: string): Promise<Bridge> {
  return bridgeFor(copies, waits, { key: `function-run:${run}`, conversation: null, named: { [FUNCTION_RUN_META_KEY]: run }, git: {}, path: null });
}

export async function conversationCaller(conversationId: string): Promise<Caller> {
  const { house: origin, credential } = (await readEnrolment())!;
  return labelled(conversationHolder(conversationId, null), origin, credential, null).caller;
}

interface Labelled {
  caller: Caller;
  forward(text: string): Promise<Forwarded>;
}

function labelled(holder: Holder, origin: string, credential: string, closed: AbortSignal | null): Labelled {
  const { named } = holder;
  const sent = (message: Message, operation: string | null): Promise<Forwarded> =>
    callHouse(origin, credential, message, { operation, named, ...(closed === null ? {} : { signal: closed }) });

  const send = async (message: Message, operation: string | null, pushing = false): Promise<Forwarded> => {
    if (operation === null) return sent(message, null);
    for (let attempt = 0; ; attempt++) {
      const forwarded = await sent(message, operation).catch((error: unknown) => {
        if (closed === null || closed.aborted) throw error;
        return null;
      });
      const after = resendAfter(forwarded, attempt, pushing);
      if (after === null) return forwarded!;
      // A Tool call House did not settle is sent again after the wait House names for a refused or a pending one, else on the jittered curve.
      await delay(after, undefined, closed === null ? undefined : { signal: closed });
    }
  };


  const staged = async (operation: string, changes: Change[]): Promise<Upload | { refused: Refusal }> => {
    const bytes = Buffer.from(JSON.stringify({ changes }));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const prepared = toolAnswer(
      await send(
        ownCall('update', { op: 'stage', paths: changedPaths(changes), bytes: bytes.length, sha256 }),
        operation,
      ),
    );
    if ('refused' in prepared) return prepared;
    const { transfer } = parse(prepared.text) as { transfer: { url: string; operation: string } };
    let text: string;
    try {
      text = await retrying(async () => {
        const posted = await carried(transfer.url, {
          method: 'POST',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: Buffer.concat([Buffer.from(`${transfer.operation}\n`), bytes]),
          ...(closed === null ? {} : { signal: closed }),
        });
        const answer = await posted.text();
        if (!posted.ok) throw new HouseRefusal('/', posted.status, answer);
        return answer;
      }, closed ?? undefined);
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
    const answer = toolAnswer(await send(ownCall('info', args), operationId()));
    if ('refused' in answer) throw new Error(answer.refused.text);
    return answer.text;
  };

  const caller: Caller = {
    key: holder.key,
    submit: async (operation, changes, held, retain) => {
      const inline = ownCall('update', { changes });
      let upload = held;
      if (upload === undefined && Buffer.byteLength(mcpBody(inline, { operation, named })) > MCP_REQUEST_BYTES) {
        const prepared = await staged(operation, changes);
        if ('refused' in prepared) return prepared;
        upload = prepared;
        await retain(upload);
      }
      return updateAnswer(
        await send(upload === undefined ? inline : ownCall('update', { paths: changedPaths(changes), upload }), operation, true),
      );
    },
    finish: async (upload, path, partSha256) => {
      const answer = toolAnswer(
        await send(ownCall('upload', { upload, path, part_sha256: partSha256 }), operationId(), true),
      );
      if ('refused' in answer) throw new Error(answer.refused.text);
      return parse(answer.text) as Finished<Staged>;
    },
    info: async (path, revision) => fileInfo(await info({ path, ...(revision === undefined ? {} : { ref: revision }) })),
    instructions: (root) => roomInstructions(info, root),
  };
  return { caller, forward };
}

async function bridgeFor(copies: LocalCopies, waits: RunWaits, holder: Holder): Promise<Bridge> {
  const { path } = holder;
  const { house: origin, credential } = (await readEnrolment())!;

  const closed = new AbortController();
  const { caller, forward } = labelled(holder, origin, credential, closed.signal);

  const local = async (path: string, text: string): Promise<Forwarded> => {
    if (path === '/copy/upload') {
      const { cwd } = JSON.parse(text) as { cwd: string };
      return { status: 200, text: JSON.stringify(await copies.upload(cwd, caller)) };
    }
    if (path === '/copy/download') {
      const { attachments = false, max_size: maxSize = DEFAULT_MAX_SIZE, cwd } = JSON.parse(text) as { attachments?: boolean; max_size?: number; cwd: string };
      return { status: 200, text: JSON.stringify(await copies.download(caller, { attachments, maxSize }, cwd)) };
    }
    if (path === UPDATE_PATH) {
      const { message, cwd } = JSON.parse(text) as Updating;
      const forwarded = await forward(JSON.stringify(message));
      return copies.updated(holder.conversation, cwd, updateChanges(message), forwarded);
    }
    if (path !== '/') return { status: 404, text: '' };
    return forward(text);
  };

  const socketPath = join(socketDirectory(), `${randomUUID()}.sock`);
  const bridge = createServer(async (request, response) => {
    try {
      const path = request.url ?? '';
      if (URL.canParse(path)) {
        relay(request, response, new URL(path));
        return;
      }
      if (path === WAIT_PATH) {
        await waits.serve(holder.conversation, request, response);
        return;
      }
      const answered = await local(path, await received(request));
      response.writeHead(answered.status, { 'content-type': 'application/json' }).end(answered.text);
    } catch (error) {
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
  const presented = { ...holder.git, authorization };
  const git = createServer(async (request, response) => {
    const target = new URL(request.url ?? '', app);
    if (!target.href.startsWith(app)) {
      response.writeHead(404).end();
      return;
    }
    relay(request, response, target, { headers: presented, pass: await held() });
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
    caller,
    tool: async (name, args) => {
      const forwarded = await forward(JSON.stringify(ownCall(name, args)));
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

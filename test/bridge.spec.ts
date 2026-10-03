import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until, type Received } from './double.ts';
import { conversationCredential, hostKit, lastInput, LISTING, type Hosted, type McpCall } from './environment.ts';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION = 'agents.house/agent-operation';

interface Ran {
  house?: string[];
  git?: string[];
  status: number;
  stdout: string;
  stderr: string;
}

async function opened(hosted: Hosted, conversation = 'conversation-1', agent = 'agent-1'): Promise<void> {
  hosted.input({ kind: 'open', conversation_id: conversation, agent_id: agent });
  await hosted.ack(lastInput());
}

function directed(hosted: Hosted, text: string, conversation = 'conversation-1', agent = 'agent-1'): void {
  hosted.input({ kind: 'message', conversation_id: conversation, agent_id: agent, text, files: [], first: false });
}

async function runs(hosted: Hosted, count: number): Promise<Ran[]> {
  return until(async () => {
    const ran = (await hosted.adapterLog()).filter((entry) => 'house' in entry || 'git' in entry);
    return ran.length >= count ? (ran as unknown as Ran[]) : undefined;
  });
}

const called = (received: Received) => received.body as McpCall;

it("reaches House with each process's own conversation credential and never shows it to the CLI", async () => {
  const hosted = await hostKit([{}, { kind: 'claude-agent-acp' }]);
  await opened(hosted);
  await opened(hosted, 'conversation-2', 'agent-2');

  directed(hosted, '@house search {"query":"one"}');
  directed(hosted, '@house search {"query":"two"}', 'conversation-2', 'agent-2');

  expect((await runs(hosted, 2)).map((ran) => ran.status)).toEqual([0, 0]);
  const bearers = Object.fromEntries(
    hosted.mcp.map((received) => [called(received).params.arguments!.query, received.headers.authorization]),
  );
  expect(bearers).toEqual({
    one: `Bearer ${conversationCredential('conversation-1')}`,
    two: `Bearer ${conversationCredential('conversation-2')}`,
  });
  const asked = hosted.house.requests.filter((received) => received.path.endsWith('/credential'));
  expect(asked.map((received) => [received.params.conversation, received.headers.authorization])).toEqual([
    ['conversation-1', 'Bearer ahk_held'],
    ['conversation-2', 'Bearer ahk_held'],
  ]);
  const seen = JSON.stringify([await hosted.adapterLog(), hosted.socket.frames]);
  expect(seen).not.toContain(conversationCredential('conversation-1'));
  expect(seen).not.toContain(conversationCredential('conversation-2'));
});

it("serves House's listed tools as the house verbs with House's help", async () => {
  const hosted = await hostKit();
  await opened(hosted);

  directed(hosted, '@house --help\n@house inspect --help\n@house search {"query":"notes"}');

  const [help, toolHelp, search] = await runs(hosted, 3);
  expect(help!.stdout).toBe(
    [
      "usage: house <tool> ['<arguments as JSON>']",
      ...LISTING.map((tool) => `${tool.name}: ${tool.description}`),
    ].join('\n') + '\n',
  );
  expect(toolHelp!.stdout).toBe(`${LISTING[1]!.description}\n${JSON.stringify(LISTING[1]!.inputSchema, null, 2)}\n`);
  expect(search!.stdout).toBe('search answered\n');
  expect(hosted.mcp.map((received) => [received.headers['mcp-method'], called(received).params.name])).toEqual([
    ['tools/list', undefined],
    ['tools/list', undefined],
    ['tools/call', 'search'],
  ]);
});

it('attaches a fresh operation id to each mutation and none to a read', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  const record = '{"room_ref":"r_room","source_ref":"s_source","body":"hello"}';

  directed(hosted, `@house append_record ${record}\n@house append_record ${record}\n@house search {"query":"hello"}`);

  await runs(hosted, 3);
  const operations = hosted.mcp.map((received) => called(received).params._meta[OPERATION]);
  expect(operations).toEqual([expect.stringMatching(UUID_V7), expect.stringMatching(UUID_V7), undefined]);
  expect(operations[0]).not.toBe(operations[1]);
});

it('uploads a local file through the attachments route and its transfer before upload_attachment answers', async () => {
  const hosted = await hostKit();
  const content = Buffer.from('quarterly numbers\n');
  await writeFile(join(hosted.workingDirectory, 'report.txt'), content);
  const transfers = await attachmentDouble(hosted);
  await opened(hosted);

  directed(hosted, '@house upload_attachment {"path":"report.txt","room_ref":"r_room"}');

  const [ran] = await runs(hosted, 1);
  expect(JSON.parse(ran!.stdout)).toEqual({ attachment: 'at_1', save: { status: 'saved' } });
  const declared = hosted.house.requests.find((received) => received.path === '/kit/attachments/upload')!;
  expect(declared.headers.authorization).toBe(`Bearer ${conversationCredential('conversation-1')}`);
  expect(declared.body).toEqual({
    room_ref: 'r_room',
    version: expect.stringMatching(/^[0-9a-f-]{36}$/),
    name: 'report.txt',
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  });
  expect(transfers).toEqual([{ operation: 'operation-1', authorization: undefined, bytes: content }]);
  expect(hosted.mcp).toEqual([]);
});

it("uploads append_record's attachments and sends their references", async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.workingDirectory, 'a.txt'), 'first');
  await writeFile(join(hosted.workingDirectory, 'b.txt'), 'second');
  const transfers = await attachmentDouble(hosted);
  await opened(hosted);

  directed(
    hosted,
    '@house append_record {"room_ref":"r_room","source_ref":"s_source","body":"see","attachments":["a.txt","b.txt"]}',
  );

  expect((await runs(hosted, 1))[0]!.stdout).toBe('append_record answered\n');
  expect(transfers.map((transfer) => transfer.bytes.toString())).toEqual(['first', 'second']);
  expect(hosted.mcp.map(called).map((call) => call.params.arguments)).toEqual([
    { room_ref: 'r_room', source_ref: 's_source', body: 'see', attachments: ['at_1', 'at_2'] },
  ]);
  expect(called(hosted.mcp[0]!).params._meta[OPERATION]).toMatch(UUID_V7);
});

it('carries the credential on a Git call to a House App source remote', async () => {
  const hosted = await hostKit();
  const commit = 'a'.repeat(40);
  const credentials: string[] = [];
  hosted.house.route('GET', '/app/:app/info/refs', (received) => {
    const basic = /^Basic (.+)$/.exec(received.headers.authorization ?? '')?.[1];
    const presented = Buffer.from(basic ?? '', 'base64').toString('utf8');
    credentials.push(presented.slice(presented.indexOf(':') + 1));
    if (basic === undefined) return { status: 401, bytes: { type: 'text/plain', content: 'authentication required\n' } };
    return {
      bytes: {
        type: 'application/x-git-upload-pack-advertisement',
        content: [
          line('# service=git-upload-pack\n'),
          '0000',
          line(`${commit} HEAD\0side-band-64k\n`),
          line(`${commit} refs/heads/main\n`),
          '0000',
        ].join(''),
      },
    };
  });
  await opened(hosted);

  directed(hosted, `@git ls-remote ${hosted.house.origin}/app/a_app.git`);

  const [ran] = await runs(hosted, 1);
  expect(ran).toMatchObject({ status: 0, stdout: `${commit}\tHEAD\n${commit}\trefs/heads/main\n` });
  expect(credentials).toEqual([conversationCredential('conversation-1')]);
});

it("closes the process's socket and Git proxy when the process exits", async () => {
  const hosted = await hostKit();
  await opened(hosted);
  const started = (await hosted.adapterLog()).find(
    (entry) => entry.method === 'initialize' && (entry.env as Record<string, string>).HOUSE_BRIDGE !== undefined,
  )!;
  const env = started.env as Record<string, string>;
  const proxy = /^url\.(.+)\/app\/\.insteadOf$/.exec(env.GIT_CONFIG_KEY_0!)![1]!;
  expect(env.GIT_CONFIG_VALUE_0).toBe(`${hosted.house.origin}/app/`);
  expect(await answers(env.HOUSE_BRIDGE!)).toBe(true);

  hosted.input({ kind: 'kill' });
  await hosted.ack(lastInput());

  await until(() => !existsSync(env.HOUSE_BRIDGE!));
  expect(await answers(env.HOUSE_BRIDGE!)).toBe(false);
  await expect(fetch(`${proxy}/app/a_app.git/info/refs`)).rejects.toThrow();
});

function line(text: string): string {
  return `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`;
}

function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sent = request({ socketPath, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } }, (answer) => {
      answer.resume();
      resolve(true);
    });
    sent.on('error', () => resolve(false));
    sent.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  });
}

async function attachmentDouble(
  hosted: Hosted,
): Promise<{ operation: unknown; authorization: unknown; bytes: Buffer }[]> {
  const transfers: { operation: unknown; authorization: unknown; bytes: Buffer }[] = [];
  let declared = 0;
  hosted.house.route('POST', '/kit/attachments/upload', () => {
    declared++;
    return {
      body: {
        attachment: `at_${declared}`,
        save: { status: 'pending' },
        upload: {
          method: 'POST',
          operation: `operation-${declared}`,
          url: `${hosted.house.origin}/bytes/upload-${declared}`,
          expires_at: '2026-10-03T12:00:00Z',
        },
      },
    };
  });
  hosted.house.route('POST', '/bytes/:grant', (received) => {
    transfers.push({
      operation: received.headers['x-house-byte-operation'],
      authorization: received.headers.authorization,
      bytes: received.body as Buffer,
    });
    return { body: { attachment: `at_${received.params.grant!.slice('upload-'.length)}`, save: { status: 'saved' } } };
  });
  return transfers;
}

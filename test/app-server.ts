import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = join(process.env.HOME ?? '/tmp', '.agents', 'house');
const memories = !process.argv.includes('memories') && existsSync(join(home, 'codex-memories'));
const queues = new Map<string, number>();
const THREAD_OPENS = new Set(['thread/start', 'thread/resume', 'thread/fork']);
let turns = 0;
const hung = existsSync(join(home, 'hung-app-server'));

appendFileSync(join(home, 'app-server.log'), `${JSON.stringify(process.argv.slice(2))}\n`);
if (hung) {
  // An idle tick each minute keeps a hung app server alive after its input ends, as a CLI stuck in its start stays.
  setInterval(() => undefined, 60_000);
}

function write(message: unknown): void {
  if (!hung) process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line) as { id?: unknown; method: string; params: Record<string, any> };
  if (message.method === 'config/read') {
    write({ jsonrpc: '2.0', id: message.id, result: { config: { features: { memories } }, origins: {}, layers: null } });
  }
  if (message.method === 'thread/queue/list') {
    const queued = Array.from({ length: queues.get(message.params.threadId) ?? 0 }, (_, index) => ({ id: `queued-${index}` }));
    write({ jsonrpc: '2.0', id: message.id, result: { data: queued, nextCursor: null } });
  }
  if (THREAD_OPENS.has(message.method)) {
    const { threadId = `thread-${message.id}`, approvalPolicy = 'on-request' } = message.params;
    write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: threadId }, approvalPolicy } });
  }
  if (message.method === 'turn/start') {
    const { threadId, approvalPolicy, approvalsReviewer, sandboxPolicy } = message.params;
    write({ jsonrpc: '2.0', method: 'thread/settings/updated', params: { threadId, threadSettings: { approvalPolicy, approvalsReviewer, sandboxPolicy } } });
    write({ jsonrpc: '2.0', id: message.id, result: { turn: { id: `turn-${++turns}`, items: [], status: 'inProgress', error: null } } });
  }
  if (message.method === 'thread/settings/update') {
    const { threadId, collaborationMode } = message.params;
    write({ jsonrpc: '2.0', method: 'thread/settings/updated', params: { threadId, threadSettings: { collaborationMode } } });
    write({ jsonrpc: '2.0', id: message.id, result: {} });
  }
  if (message.method === 'emit') {
    for (const [thread, count] of Object.entries(message.params.queue ?? {})) queues.set(thread, count as number);
    for (const emitted of message.params.messages ?? []) write(emitted);
    write({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});

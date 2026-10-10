import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = process.env.HOUSE_KIT_HOME ?? '/tmp';
const memories = !process.argv.includes('memories') && existsSync(join(home, 'codex-memories'));
const queues = new Map<string, number>();

appendFileSync(join(home, 'app-server.log'), `${JSON.stringify(process.argv.slice(2))}\n`);

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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
  if (message.method === 'emit') {
    for (const [thread, count] of Object.entries(message.params.queue ?? {})) queues.set(thread, count as number);
    for (const emitted of message.params.messages ?? []) write(emitted);
    write({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});

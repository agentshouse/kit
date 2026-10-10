#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const KIT_ANSWER = '"house-kit-';
const SYNC = 'house-kit/sync';

function lines(each: (line: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      each(buffer.slice(0, index + 1));
      buffer = buffer.slice(index + 1);
    }
  };
}

function answersKit(line: string): boolean {
  if (!line.includes(KIT_ANSWER)) return false;
  try {
    const message = JSON.parse(line) as { id?: unknown; method?: unknown };
    return message.method === undefined && typeof message.id === 'string' && message.id.startsWith(KIT_ANSWER.slice(1));
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);
const serving = args[0] === 'app-server';
if (process.env.HOUSE_KIT_SANDBOX === '1' && serving) args.push('--disable', 'memories');
const codex = spawn(process.env.HOUSE_KIT_CODEX!, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const stream = serving ? connect(process.env.HOUSE_KIT_CODEX_STREAM!) : null;
stream?.on('error', () => undefined);

process.stdin.setEncoding('utf8').on('data', lines((line) => codex.stdin.write(line)));
process.stdin.on('end', () => codex.stdin.end());
stream?.setEncoding('utf8').on(
  'data',
  lines((line) => {
    const message = JSON.parse(line) as { id: string; method: string };
    if (message.method === SYNC) stream!.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
    else codex.stdin.write(line);
  }),
);
codex.stdout.setEncoding('utf8').on(
  'data',
  lines((line) => {
    stream?.write(line);
    if (answersKit(line) || process.stdout.write(line)) return;
    codex.stdout.pause();
    process.stdout.once('drain', () => codex.stdout.resume());
  }),
);
codex.stdin.on('error', () => undefined);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => codex.kill(signal));
codex.on('exit', (code, signal) => {
  if (signal === null) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});

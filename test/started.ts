import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Started {
  name: string;
  proxy: string[];
  keyed: string[];
}

export function recordStart(name: string): void {
  const proxy = Object.keys(process.env).filter((variable) => /^https?_proxy$/i.test(variable));
  const keyed = Object.keys(process.env).filter((variable) => variable === 'XAI_API_KEY' || variable === 'GROK_MODELS_BASE_URL');
  appendFileSync(join(process.env.HOME!, '.agents', 'house', 'started.log'), `${JSON.stringify({ name, proxy, keyed })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) recordStart(process.argv[2]!);

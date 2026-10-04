import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Started {
  name: string;
  proxy: string[];
}

export function recordStart(name: string): void {
  const proxy = Object.keys(process.env).filter((variable) => /^https?_proxy$/i.test(variable));
  appendFileSync(join(process.env.HOUSE_KIT_HOME!, 'started.log'), `${JSON.stringify({ name, proxy })}\n`);
}

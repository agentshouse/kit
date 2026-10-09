import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIS } from '../src/clis.ts';
import { recordStart } from './started.ts';

const ADAPTER = fileURLToPath(new URL('./adapter.ts', import.meta.url));

export function placeAdapter(prefix: string, kind: string, version: string): void {
  const adapter = CLIS[kind]!.adapter!;
  const manifest = join(prefix, 'node_modules', adapter.package);
  mkdirSync(manifest, { recursive: true });
  writeFileSync(join(manifest, 'package.json'), JSON.stringify({ name: adapter.package, version }));
  mkdirSync(join(prefix, 'node_modules', '.bin'), { recursive: true });
  const bin = join(prefix, 'node_modules', '.bin', adapter.bin);
  writeFileSync(bin, ['#!/bin/sh', `export ADAPTER_KIND=${kind}`, `exec ${process.execPath} ${ADAPTER} "$@"`, ''].join('\n'));
  chmodSync(bin, 0o755);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  recordStart('npm');
  const argv = process.argv.slice(2);
  const home = process.env.HOUSE_KIT_HOME!;
  appendFileSync(join(home, 'npm.log'), `${JSON.stringify(argv)}\n`);
  const prefix = argv[argv.indexOf('--prefix') + 1]!;
  const spec = argv.at(-1)!;
  const at = spec.lastIndexOf('@');
  const name = spec.slice(0, at);
  // Fifty milliseconds resumes the held install as soon as the spec removes its file.
  while (existsSync(join(home, 'npm-hold'))) await new Promise((resolve) => setTimeout(resolve, 50));
  const muted = join(home, 'npm-mute');
  if (existsSync(muted) && readFileSync(muted, 'utf8').includes(name)) process.exit(1);
  const failing = join(home, 'npm-fail');
  if (existsSync(failing) && readFileSync(failing, 'utf8').includes(name)) {
    process.stderr.write(`npm error 404 Not Found - ${name}\n`);
    process.exit(1);
  }
  const kind = Object.keys(CLIS).find((candidate) => CLIS[candidate]!.adapter?.package === name)!;
  placeAdapter(prefix, kind, spec.slice(at + 1));
}

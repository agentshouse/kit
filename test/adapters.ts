import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIS } from '../src/clis.ts';

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

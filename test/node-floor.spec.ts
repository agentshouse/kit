import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

async function run(bin: string, version: string) {
  const home = await mkdtemp(join(tmpdir(), 'kit-node-floor-'));
  try {
    await writeFile(join(home, 'entry.mjs'), await readFile(new URL(`../src/${bin}-main.ts`, import.meta.url), 'utf8'));
    await writeFile(join(home, `${bin}-cli.ts`), 'process.stdout.write("implementation loaded\\n");\n');
    const entry = pathToFileURL(join(home, 'entry.mjs')).href;
    return spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); await import(${JSON.stringify(entry)});`],
      { encoding: 'utf8' },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

for (const bin of ['kit', 'house']) {
  it.each(['22.23.3', '24.13.0'])(`${bin} refuses Node %s in one line before loading anything`, async (version) => {
    const ran = await run(bin, version);
    expect(ran.status).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe(`${bin}: the Kit needs Node 24.14.0 or newer; this is ${version}\n`);
  });

  it.each(['24.14.0', '25.0.0'])(`${bin} runs on Node %s`, async (version) => {
    const ran = await run(bin, version);
    expect(ran.stderr).toBe('');
    expect(ran.stdout).toBe('implementation loaded\n');
    expect(ran.status).toBe(0);
  });
}

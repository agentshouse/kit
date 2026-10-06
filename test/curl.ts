import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIS } from '../src/clis.ts';
import { ENGINES, MODEL, type Artifact } from '../src/transcription.ts';
import { recordStart } from './started.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const CACHE = fileURLToPath(new URL('../tmp/transcription-cache/', import.meta.url));

export const LOCATIONS: Record<string, string> = {
  'codex-acp': '.local/bin',
  'claude-agent-acp': '.local/bin',
  'grok-build': '.grok/bin',
};

export function pinnedArtifacts(): Artifact[] {
  const engine = ENGINES[`${process.platform}-${process.arch}`]!;
  return [engine.decoder, engine.engine, MODEL];
}

export function cacheArtifacts(): void {
  mkdirSync(CACHE, { recursive: true });
  for (const artifact of pinnedArtifacts()) {
    const cached = join(CACHE, artifact.sha256);
    if (existsSync(cached)) continue;
    const fetched = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', `${cached}.part`, artifact.url], { stdio: 'inherit' });
    if (fetched.status !== 0) throw new Error(`${artifact.url} did not download`);
    if (createHash('sha256').update(readFileSync(`${cached}.part`)).digest('hex') !== artifact.sha256) {
      throw new Error(`${artifact.url} does not match its sha256`);
    }
    renameSync(`${cached}.part`, cached);
  }
}

function serve(artifact: Artifact, output: string): void {
  const corrupt = join(process.env.HOUSE_KIT_HOME!, 'curl-corrupt');
  if (existsSync(corrupt) && readFileSync(corrupt, 'utf8').includes(artifact.url)) {
    writeFileSync(output, 'not the pinned artifact');
    return;
  }
  copyFileSync(join(CACHE, artifact.sha256), output);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  recordStart('curl');
  const url = process.argv.at(-1)!;
  appendFileSync(join(process.env.HOUSE_KIT_HOME!, 'curl.log'), `${url}\n`);
  const artifact = pinnedArtifacts().find((candidate) => candidate.url === url);
  if (artifact !== undefined) {
    serve(artifact, process.argv[process.argv.indexOf('-o') + 1]!);
  } else {
    const kind = Object.keys(CLIS).find((candidate) => CLIS[candidate]!.install.includes(` ${url} `))!;
    process.stdout.write(
      [
        `if grep -qx ${kind} "$HOUSE_KIT_HOME/install-fail" 2>/dev/null; then cat "$HOUSE_KIT_HOME/install-output" 2>/dev/null; echo "Checksum verification failed" >&2; exit 1; fi`,
        `${process.execPath} ${CLI} ${kind} "$HOME/${LOCATIONS[kind]}"`,
        ...(kind === 'claude-agent-acp' ? [] : [`printf '%s\\n' 'PATH="$HOME/${LOCATIONS[kind]}:$PATH"' >> "$HOME/.profile"`]),
        '',
      ].join('\n'),
    );
  }
}

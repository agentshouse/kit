import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { unlessAborted } from './abort.ts';
import { failureOf, run } from './clis.ts';
import { kitHome } from './home.ts';

export interface Artifact {
  url: string;
  sha256: string;
  executable: boolean;
}

interface Engine {
  decoder: Artifact;
  engine: Artifact;
}

const RELEASE = 'https://github.com/agentshouse/kit/releases/download/engine-1';

export const MODEL: Artifact = {
  url: 'https://huggingface.co/ggml-org/parakeet-GGUF/resolve/35156454d1a39de06863303dd209fd2bed6ee079/ggml-parakeet-tdt-0.6b-v3-q4_k.bin',
  sha256: '8b205b8b39c6535e153de6fb11c51db46125d45c4f16ba496fe41a0fe71b885e',
  executable: false,
};

export const ENGINES: Record<string, Engine> = {
  'linux-x64': {
    decoder: { url: `${RELEASE}/ffmpeg-linux-x86_64`, sha256: '1f8235d206428305afb89c6e8ab99d100425a0ba61e22bb4c7aff017db8c8de5', executable: true },
    engine: { url: `${RELEASE}/parakeet-cli-linux-x86_64`, sha256: '00b038974a18476ce7db7289b0952fbba9f9f7f4f2d101e60b558c2ab9e96970', executable: true },
  },
  'linux-arm64': {
    decoder: { url: `${RELEASE}/ffmpeg-linux-aarch64`, sha256: 'a7e08a0fae0179d1078312f6bb13d2a9aa4d4c71a1d82a022953f25dee452f5e', executable: true },
    engine: { url: `${RELEASE}/parakeet-cli-linux-aarch64`, sha256: '3b1f50f4bad8fe954a593abe42e92565a703eced89c51092d569e7ca34c6d94d', executable: true },
  },
};

const CHUNK_SECONDS = 20;

let held: Promise<unknown> = Promise.resolve();

function directory(): string {
  return join(kitHome(), 'transcription');
}

function installed(artifact: Artifact): string {
  return join(directory(), artifact.sha256);
}

async function executed(command: string, args: string[], signal: AbortSignal): Promise<string> {
  const ran = await run(command, args, 0, false, signal);
  if (ran.status !== 0) throw new Error(failureOf(ran, basename(command)));
  return ran.stdout;
}

function present(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function cpus(): Promise<number> {
  const [quota, period] = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8').catch(() => 'max')).split(' ');
  const allowed = quota === 'max' ? Infinity : Math.ceil(Number(quota) / Number(period));
  return Math.min(availableParallelism(), allowed);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function install(artifacts: Artifact[], signal: AbortSignal): Promise<void> {
  await mkdir(directory(), { recursive: true });
  const pinned = new Set(artifacts.map((artifact) => artifact.sha256));
  for (const name of await readdir(directory())) {
    if (!pinned.has(name)) await rm(join(directory(), name), { recursive: true, force: true });
  }
  const missing: Artifact[] = [];
  for (const artifact of artifacts) if (!(await present(installed(artifact)))) missing.push(artifact);
  try {
    for (const artifact of missing) {
      const part = `${installed(artifact)}.part`;
      await executed('curl', ['-fsSL', '--retry', '3', '-o', part, artifact.url], signal);
      if ((await sha256(part)) !== artifact.sha256) throw new Error(`${artifact.url} does not match its sha256`);
    }
    for (const artifact of missing) {
      if (artifact.executable) await chmod(`${installed(artifact)}.part`, 0o755);
      await rename(`${installed(artifact)}.part`, installed(artifact));
    }
  } finally {
    for (const artifact of missing) await rm(`${installed(artifact)}.part`, { force: true });
  }
}

async function transcribed(path: string, signal: AbortSignal): Promise<string> {
  const platform = `${process.platform}-${process.arch}`;
  const pinned = ENGINES[platform];
  if (pinned === undefined) throw new Error(`no transcription engine is pinned for ${platform}`);
  await install([pinned.decoder, pinned.engine, MODEL], signal);
  const work = await mkdtemp(join(tmpdir(), 'kit-transcription-'));
  try {
    await executed(
      installed(pinned.decoder),
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), join(work, '%05d.wav')],
      signal,
    );
    const parts = (await readdir(work)).sort().flatMap((part) => ['-f', join(work, part)]);
    const text = await executed(
      installed(pinned.engine),
      ['-t', String(await cpus()), '-np', '-m', installed(MODEL), ...parts],
      signal,
    );
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join(' ');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function transcribe(path: string, signal: AbortSignal): Promise<string> {
  const before = held;
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  held = Promise.all([before, mine]);
  try {
    await unlessAborted(before, signal);
    return await transcribed(path, signal);
  } finally {
    release();
  }
}

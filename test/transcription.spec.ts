import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { cacheArtifacts, pinnedArtifacts } from './curl.ts';
import { until } from './double.ts';
import { hostKit, hostMac, lastInput, opened, type Hosted } from './environment.ts';
import { alive } from './kit.ts';

interface Sent {
  name: string;
  media_type: string | null;
  content: Buffer;
}

const fixture = (name: string) => readFileSync(new URL(`./fixtures/audio/${name}`, import.meta.url));
const ENGLISH = /^Transcript: .*\bdollar\b.*\bcents\b/i;
const RUSSIAN = /^Transcript: .*чудная ночь/i;
const MACH_O_ARM64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const started = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/started'));
const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));

let versions = 0;

beforeAll(() => {
  cacheArtifacts();
  cacheArtifacts('darwin-arm64');
}, 900_000);

function speech(seconds: number): Buffer {
  const wav = fixture('en.wav');
  const data = wav.subarray(44);
  const pcm = Buffer.concat(Array.from({ length: Math.ceil((seconds * 32_000) / data.length) }, () => data));
  const header = Buffer.from(wav.subarray(0, 44));
  header.writeUInt32LE(36 + pcm.length, 4);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function sent(hosted: Hosted, files: Sent[]): { described: Record<string, unknown>[]; paths: string[] } {
  const served = files.map((file) => ({ ...file, version: `version-${++versions}` }));
  hosted.house.route('POST', '/kit/conversation/originals/get', (received) => {
    const { version } = received.body as { version: string };
    return {
      body: {
        version,
        message: 'message-1',
        name: served.find((file) => file.version === version)?.name ?? 'other',
        download: { method: 'GET', url: `${hosted.house.origin}/bytes/${version}`, expires_at: '2026-10-06T12:00:00Z' },
      },
    };
  });
  hosted.house.route('GET', '/bytes/:version', (received) => ({
    bytes: { type: 'application/octet-stream', content: served.find((file) => file.version === received.params.version)!.content },
  }));
  return {
    described: served.map(({ content, ...file }) => ({
      ...file,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    })),
    paths: served.map((file) => join(hosted.workingDirectory, '.house', 'files', 'message-1', file.version, file.name)),
  };
}

async function prompted(hosted: Hosted, index: number): Promise<string[]> {
  const prompts = await until(async () => {
    const found = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt');
    return found.length > index ? found : undefined;
  }, 30_000);
  return String(prompts[index]!.text).split('\n');
}

function engines(hosted: Hosted): number[] {
  const installed = join(hosted.home, 'transcription');
  return readdirSync('/proc').flatMap((entry) => {
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
      return argv[0]!.startsWith(installed) && argv.includes('-m') ? [Number(entry)] : [];
    } catch {
      return [];
    }
  });
}

async function downloads(hosted: Hosted): Promise<string[]> {
  return (await readFile(join(hosted.home, 'curl.log'), 'utf8')).trim().split('\n');
}

it('follows each audio path with its transcript in the prompt and leaves every other path bare', async () => {
  const hosted = await hostKit();
  const { described, paths } = sent(hosted, [
    { name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') },
    { name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') },
    { name: 'notes.txt', media_type: 'text/plain', content: Buffer.from('plain notes\n') },
    { name: 'untyped', media_type: null, content: Buffer.from('no media type\n') },
  ]);

  hosted.input({ kind: 'message', text: 'listen to these', files: described, first: false });

  expect(await hosted.ack(lastInput())).toHaveProperty('provider_session_id');
  const lines = await prompted(hosted, 0);
  expect(lines).toEqual([
    'listen to these',
    paths[0],
    expect.stringMatching(ENGLISH),
    paths[1],
    expect.stringMatching(RUSSIAN),
    paths[2],
    paths[3],
  ]);
});

it.each([['en.ogg', 'audio/ogg'], ['en.webm', 'audio/webm'], ['en.m4a', 'audio/mp4'], ['en.mp3', 'audio/mpeg'], ['en.wav', 'audio/wav']])(
  'transcribes %s',
  async (name, mediaType) => {
    const hosted = await hostKit();
    const { described, paths } = sent(hosted, [{ name, media_type: mediaType, content: fixture(name) }]);

    hosted.input({ kind: 'message', text: 'listen', files: described, first: false });

    expect(await prompted(hosted, 0)).toEqual(['listen', paths[0], expect.stringMatching(ENGLISH)]);
  },
);

it('downloads the pinned engine, decoder and model into Kit home once, deleting any artifact the release no longer pins', async () => {
  const hosted = await hostKit();
  const directory = join(hosted.home, 'transcription');
  await mkdir(directory);
  await writeFile(join(directory, '0'.repeat(64)), 'an artifact an earlier release pinned');
  const first = sent(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);

  hosted.input({ kind: 'message', text: 'first', files: first.described, first: false });

  expect(await prompted(hosted, 0)).toEqual(['first', first.paths[0], expect.stringMatching(RUSSIAN)]);
  expect(new Set(await downloads(hosted)).size).toBe(3);
  const installed = await readdir(directory);
  expect(installed).toHaveLength(3);
  expect(installed).not.toContain('0'.repeat(64));
  for (const name of installed) {
    expect(createHash('sha256').update(await readFile(join(directory, name))).digest('hex')).toBe(name);
  }

  const second = sent(hosted, [{ name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') }]);
  hosted.input({ kind: 'message', text: 'second', files: second.described, first: false });

  expect(await prompted(hosted, 1)).toEqual(['second', second.paths[0], expect.stringMatching(ENGLISH)]);
  expect(await downloads(hosted)).toHaveLength(3);
  expect((await readdir(directory)).sort()).toEqual(installed.sort());
});

it('installs the engine and the decoder built for Apple silicon on a Mac', async () => {
  const hosted = await hostMac();
  const { described } = sent(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);

  hosted.input({ kind: 'message', text: 'listen', files: described, first: false });

  await hosted.ack(lastInput());
  const directory = join(hosted.home, 'transcription');
  const installed = await Promise.all((await readdir(directory)).map((name) => readFile(join(directory, name))));
  expect(installed).toHaveLength(3);
  expect(installed.filter((content) => content.subarray(0, 8).equals(MACH_O_ARM64))).toHaveLength(2);
});

it('refuses an artifact that does not match its hash, installs nothing, keeps the bare path and tries again on the next audio file', async () => {
  const hosted = await hostKit();
  const corrupt = join(hosted.home, 'curl-corrupt');
  await writeFile(corrupt, pinnedArtifacts()[2]!.url);
  const first = sent(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);

  hosted.input({ kind: 'message', text: 'first', files: first.described, first: false });

  expect(await hosted.ack(lastInput())).toHaveProperty('provider_session_id');
  expect(await prompted(hosted, 0)).toEqual(['first', first.paths[0]]);
  expect(await readdir(join(hosted.home, 'transcription'))).toEqual([]);

  await rm(corrupt);
  const second = sent(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);
  hosted.input({ kind: 'message', text: 'second', files: second.described, first: false });

  expect(await prompted(hosted, 1)).toEqual(['second', second.paths[0], expect.stringMatching(RUSSIAN)]);
});

it('keeps the bare path of an audio file it cannot decode', async () => {
  const hosted = await hostKit();
  const { described, paths } = sent(hosted, [
    { name: 'broken.ogg', media_type: 'audio/ogg', content: Buffer.from('not audio at all') },
    { name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') },
  ]);

  hosted.input({ kind: 'message', text: 'listen', files: described, first: false });

  expect(await prompted(hosted, 0)).toEqual(['listen', paths[0], paths[1], expect.stringMatching(ENGLISH)]);
});

it(
  'reports no idle while a transcription runs',
  async () => {
    const hosted = await hostKit();
    await opened(hosted);
    await until(() => hosted.idles[1]);
    const { described } = sent(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(40) }]);

    hosted.input({ kind: 'message', text: 'listen', files: described, first: false });

    await until(() => engines(hosted)[0], 30_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(engines(hosted)).toHaveLength(1);
    expect(hosted.idles).toHaveLength(2);
    await hosted.ack(lastInput());
    await until(() => hosted.idles[2], 30_000);
  },
  // Transcribing the deliberate 40-second sample can exceed the default on the two-vCPU runner.
  60_000,
);

it("makes a second conversation's audio wait for the first conversation's transcription", async () => {
  const hosted = await hostKit();
  await opened(hosted, 'conversation-1');
  await opened(hosted, 'conversation-2');
  const files = sent(hosted, [
    { name: 'first.wav', media_type: 'audio/wav', content: speech(20) },
    { name: 'second.wav', media_type: 'audio/wav', content: speech(20) },
  ]);
  const seen = new Set<number>();
  let most = 0;
  const sampling = setInterval(() => {
    const running = engines(hosted);
    for (const pid of running) seen.add(pid);
    most = Math.max(most, running.length);
  }, 20);

  hosted.input({ kind: 'message', conversation_id: 'conversation-1', text: 'first', files: [files.described[0]], first: false });
  const first = lastInput();
  hosted.input({ kind: 'message', conversation_id: 'conversation-2', text: 'second', files: [files.described[1]], first: false });
  const second = lastInput();

  try {
    const acked = (input: string) => hosted.acks.some((ack) => ack.params.input === input);
    await until(() => acked(first) && acked(second), 60_000);
  } finally {
    clearInterval(sampling);
  }
  expect(most).toBe(1);
  expect(seen.size).toBe(2);
  expect(await prompted(hosted, 1)).toEqual([expect.any(String), expect.any(String), expect.stringMatching(ENGLISH)]);
});

it('ends a running transcription on an interrupt and writes the message with its bare path before the interrupt cancels the turn', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  hosted.input({ kind: 'message', text: '@wait', files: [], first: false });
  const turn = (await until(() => started(hosted)[0])).params.turn!;
  const { described, paths } = sent(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(240) }]);
  hosted.input({ kind: 'message', text: '@hold 2000', files: described, first: false });
  const message = lastInput();
  const engine = await until(() => engines(hosted)[0], 30_000);

  hosted.input({ kind: 'interrupt', turn_id: turn });

  await until(() => !alive(engine), 3000);
  expect(await hosted.ack(message)).toEqual({});
  expect(await prompted(hosted, 1)).toEqual(['@hold 2000', paths[0]]);
  await until(() => ended(hosted)[0]);
  const log = await hosted.adapterLog();
  const methods = log.filter((entry) => entry.method === 'session/prompt' || entry.method === 'session/cancel').map((entry) => entry.method);
  expect(methods).toEqual(['session/prompt', 'session/prompt', 'session/cancel']);
});

it('ends a running transcription on a kill and refuses its message', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  const { described } = sent(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(240) }]);
  hosted.input({ kind: 'message', text: 'listen', files: described, first: false });
  const message = lastInput();
  const engine = await until(() => engines(hosted)[0], 30_000);

  hosted.input({ kind: 'kill' });

  await until(() => !alive(engine), 3000);
  expect(await hosted.ack(message)).toEqual({ refused: 'the conversation was killed' });
});

it('transcribes the next audio file after an interrupt whose cancel could not reach the CLI', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  hosted.input({ kind: 'message', text: '@deaf\n@wait', files: [], first: false });
  const turn = (await until(() => started(hosted)[0])).params.turn!;
  hosted.input({ kind: 'interrupt', turn_id: turn });
  await new Promise((resolve) => setTimeout(resolve, 500));
  hosted.input({ kind: 'interrupt', turn_id: turn });
  await until(() => hosted.kit.stderr().includes('EPIPE'));
  const { described } = sent(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);

  hosted.input({ kind: 'message', text: 'listen', files: described, first: false });

  await hosted.ack(lastInput());
  expect(await readdir(join(hosted.home, 'transcription'))).toHaveLength(3);
});

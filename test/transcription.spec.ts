import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { cacheArtifacts, pinnedArtifacts } from './curl.ts';
import { until } from './double.ts';
import { hostKit, lastInput, opened, type Hosted } from './environment.ts';
import { alive } from './kit.ts';

interface Sent {
  name: string;
  media_type: string;
  content: Buffer;
}

const fixture = (name: string) => readFileSync(new URL(`./fixtures/audio/${name}`, import.meta.url));
const ENGLISH = /^Transcript: .*\bdollar\b.*\bcents\b/i;
const RUSSIAN = /^Transcript: .*чудная ночь/i;
const started = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/started'));
const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));

let versions = 0;

beforeAll(cacheArtifacts, 900_000);

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
  const engine = join(hosted.home, 'transcription', pinnedArtifacts()[1]!.sha256);
  return readdirSync('/proc').flatMap((entry) => {
    try {
      return readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0')[0] === engine ? [Number(entry)] : [];
    } catch {
      return [];
    }
  });
}

it('follows each audio path with its transcript in the prompt and leaves every other path bare', async () => {
  const hosted = await hostKit();
  const { described, paths } = sent(hosted, [
    { name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') },
    { name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') },
    { name: 'notes.txt', media_type: 'text/plain', content: Buffer.from('plain notes\n') },
  ]);

  hosted.input({ kind: 'message', text: 'listen to these', files: described, first: false });

  expect(await hosted.ack(lastInput())).toHaveProperty('provider_session_id');
  const lines = await prompted(hosted, 0);
  expect(lines).toEqual(['listen to these', paths[0], expect.stringMatching(ENGLISH), paths[1], expect.stringMatching(RUSSIAN), paths[2]]);
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
  const pinned = pinnedArtifacts();
  expect((await readFile(join(hosted.home, 'curl.log'), 'utf8')).trim().split('\n').sort()).toEqual(
    pinned.map((artifact) => artifact.url).sort(),
  );
  expect((await readdir(directory)).sort()).toEqual(pinned.map((artifact) => artifact.sha256).sort());

  const second = sent(hosted, [{ name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') }]);
  hosted.input({ kind: 'message', text: 'second', files: second.described, first: false });

  expect(await prompted(hosted, 1)).toEqual(['second', second.paths[0], expect.stringMatching(ENGLISH)]);
  expect((await readFile(join(hosted.home, 'curl.log'), 'utf8')).trim().split('\n')).toHaveLength(3);
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

it('reports no idle while a transcription runs', async () => {
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
});

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

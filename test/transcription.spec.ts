import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { cacheArtifacts, pinnedArtifacts } from './curl.ts';
import { until } from './double.ts';
import type { TranscriptionReport } from '../src/transcription.ts';
import { hostKit, hostMac, lastCall, opened, type Hosted, type Hosting } from './environment.ts';
import { alive, stop } from './kit.ts';

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
// Fifteen minutes cover downloading the pinned engines and model once into an empty cache.
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
  // Thirty seconds cover transcribing a sample before the CLI double is prompted.
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
  return (await readFile(join(hosted.home, 'curl.log'), 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');
}

function reported(hosted: Hosted, after = 0): TranscriptionReport[] {
  return hosted.reports.slice(after).flatMap((report) => (report.transcription === undefined ? [] : [report.transcription as TranscriptionReport]));
}

function settled(hosted: Hosted, wanted: TranscriptionReport | ((report: TranscriptionReport) => boolean), after = 0): Promise<TranscriptionReport> {
  const met = typeof wanted === 'function' ? wanted : (report: TranscriptionReport) => JSON.stringify(report) === JSON.stringify(wanted);
  // A minute covers checking the three pinned artifacts the curl double copies into Kit home on a loaded runner.
  return until(() => reported(hosted, after).find(met), 60_000);
}

async function transcribing(hosting: Hosting = {}): Promise<Hosted> {
  const hosted = await hostKit([{}], { ...hosting, transcribe: true });
  await settled(hosted, { installed: true, failure: null });
  return hosted;
}

function desiredReads(hosted: Hosted): number {
  return hosted.house.requests.filter((request) => request.path === '/kit/agents/desired').length;
}

it('follows each audio path with its transcript in the prompt and leaves every other path bare', async () => {
  const hosted = await transcribing();
  const { described, paths } = sent(hosted, [
    { name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') },
    { name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') },
    { name: 'notes.txt', media_type: 'text/plain', content: Buffer.from('plain notes\n') },
    { name: 'untyped', media_type: null, content: Buffer.from('no media type\n') },
  ]);

  hosted.call({ kind: 'message', text: 'listen to these', files: described, first: false });

  expect(await hosted.result(lastCall())).toHaveProperty('provider_session_id');
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
    const hosted = await transcribing();
    const { described, paths } = sent(hosted, [{ name, media_type: mediaType, content: fixture(name) }]);

    hosted.call({ kind: 'message', text: 'listen', files: described, first: false });

    expect(await prompted(hosted, 0)).toEqual(['listen', paths[0], expect.stringMatching(ENGLISH)]);
  },
);

it('downloads the pinned engine, decoder and model into Kit home at its start, before any message, deleting any artifact the release no longer pins', async () => {
  const hosted = await transcribing({
    prepare: async (home) => {
      await mkdir(join(home, 'transcription'));
      await writeFile(join(home, 'transcription', '0'.repeat(64)), 'an artifact an earlier release pinned');
    },
  });
  const directory = join(hosted.home, 'transcription');

  expect(new Set(await downloads(hosted)).size).toBe(3);
  const installed = await readdir(directory);
  expect(installed).toHaveLength(3);
  expect(installed).not.toContain('0'.repeat(64));
  for (const name of installed) {
    expect(createHash('sha256').update(await readFile(join(directory, name))).digest('hex')).toBe(name);
  }

  const { described, paths } = sent(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);
  hosted.call({ kind: 'message', text: 'listen', files: described, first: false });

  expect(await prompted(hosted, 0)).toEqual(['listen', paths[0], expect.stringMatching(RUSSIAN)]);
  expect(await downloads(hosted)).toHaveLength(3);
  expect((await readdir(directory)).sort()).toEqual(installed.sort());
});

it('deletes the three artifacts when the setting turns off, keeps a later audio path bare with no download, and downloads them again when it turns on without a restart', async () => {
  const hosted = await transcribing();
  const directory = join(hosted.home, 'transcription');
  const reports = hosted.reports.length;

  hosted.transcribe(false);

  await settled(hosted, { installed: false, failure: null }, reports);
  expect(existsSync(directory)).toBe(false);
  const off = sent(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);
  hosted.call({ kind: 'message', text: 'off', files: off.described, first: false });
  expect(await prompted(hosted, 0)).toEqual(['off', off.paths[0]]);
  expect(await downloads(hosted)).toHaveLength(3);

  const again = hosted.reports.length;
  hosted.transcribe(true);

  await settled(hosted, { installed: true, failure: null }, again);
  expect(await downloads(hosted)).toHaveLength(6);
  expect(await readdir(directory)).toHaveLength(3);
  const on = sent(hosted, [{ name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') }]);
  hosted.call({ kind: 'message', text: 'on', files: on.described, first: false });
  expect(await prompted(hosted, 1)).toEqual(['on', on.paths[0], expect.stringMatching(ENGLISH)]);
});

it('ends a running download and deletes the artifacts when the setting turns off, reporting no failure', async () => {
  const stalled = pinnedArtifacts()[1]!.url;
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'curl-stall'), stalled);
  hosted.transcribe(true);
  const directory = join(hosted.home, 'transcription');
  await until(async () => (await downloads(hosted)).includes(stalled));

  hosted.transcribe(false);

  await until(() => !existsSync(directory));
  await rm(join(hosted.home, 'curl-stall'));
  const again = hosted.reports.length;
  hosted.transcribe(true);
  await settled(hosted, { installed: true, failure: null }, again);
  expect(reported(hosted).filter((report) => report.failure !== null)).toEqual([]);
});

it('sends no report when a read of the setting changes neither whether the engine is installed nor its failure', async () => {
  const hosted = await transcribing();
  const reports = hosted.reports.length;
  const reads = desiredReads(hosted);

  hosted.transcribe(true);

  await until(() => desiredReads(hosted) > reads);
  // Half a second outlasts the Kit reporting a change it read, so a report not sent by then is not coming.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(hosted.reports).toHaveLength(reports);
  expect(await downloads(hosted)).toHaveLength(3);
});

it('installs the engine and the decoder built for Apple silicon on a Mac', async () => {
  const hosted = await hostMac({ transcribe: true });

  await settled(hosted, { installed: true, failure: null });

  const directory = join(hosted.home, 'transcription');
  const installed = await Promise.all((await readdir(directory)).map((name) => readFile(join(directory, name))));
  expect(installed).toHaveLength(3);
  expect(installed.filter((content) => content.subarray(0, 8).equals(MACH_O_ARM64))).toHaveLength(2);
});

it('refuses an artifact that does not match its hash, installs nothing, reports why, keeps audio paths bare and tries again only when the setting next turns on', async () => {
  const corrupt = pinnedArtifacts()[2]!.url;
  const hosted = await hostKit([{}], {
    transcribe: true,
    prepare: (home) => writeFile(join(home, 'curl-corrupt'), corrupt),
  });

  await settled(hosted, { installed: false, failure: `${corrupt} does not match its sha256` });
  expect(existsSync(join(hosted.home, 'transcription'))).toBe(false);
  const tried = (await downloads(hosted)).length;
  const first = sent(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);
  hosted.call({ kind: 'message', text: 'first', files: first.described, first: false });
  expect(await hosted.result(lastCall())).toHaveProperty('provider_session_id');
  expect(await prompted(hosted, 0)).toEqual(['first', first.paths[0]]);

  const reads = desiredReads(hosted);
  hosted.transcribe(true);
  await until(() => desiredReads(hosted) > reads);
  // Half a second outlasts the Kit starting a download it read a reason for, so one not started by then is not coming.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await downloads(hosted)).toHaveLength(tried);

  await rm(join(hosted.home, 'curl-corrupt'));
  const cleared = hosted.reports.length;
  hosted.transcribe(false);
  await settled(hosted, { installed: false, failure: null }, cleared);
  const again = hosted.reports.length;
  hosted.transcribe(true);
  await settled(hosted, { installed: true, failure: null }, again);
  const second = sent(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);
  hosted.call({ kind: 'message', text: 'second', files: second.described, first: false });

  expect(await prompted(hosted, 1)).toEqual(['second', second.paths[0], expect.stringMatching(RUSSIAN)]);
});

it('keeps the bare path of an audio file it cannot decode', async () => {
  const hosted = await transcribing();
  const { described, paths } = sent(hosted, [
    { name: 'broken.ogg', media_type: 'audio/ogg', content: Buffer.from('not audio at all') },
    { name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') },
  ]);

  hosted.call({ kind: 'message', text: 'listen', files: described, first: false });

  expect(await prompted(hosted, 0)).toEqual(['listen', paths[0], paths[1], expect.stringMatching(ENGLISH)]);
});

it('runs the engine on half the CPUs the Environment grants, so work beside it does not slow it tenfold', async () => {
  const hosted = await transcribing();
  await opened(hosted);
  const { described } = sent(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(60) }]);

  hosted.call({ kind: 'message', text: 'listen', files: described, first: false });

  // Thirty seconds cover the engine starting on a loaded runner.
  const engine = await until(() => engines(hosted)[0], 30_000);
  const argv = readFileSync(`/proc/${engine}/cmdline`, 'utf8').split('\0');
  stop(engine);
  expect(argv[argv.indexOf('-t') + 1]).toBe('2');
});

it('reports no idle while a transcription runs and reports idle once it has ended', async () => {
  const hosted = await transcribing();
  await opened(hosted);
  await until(() => hosted.idles[1]);
  const { described } = sent(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(240) }]);

  hosted.call({ kind: 'message', text: 'listen', files: described, first: false });
  const message = lastCall();

  // Thirty seconds cover the engine starting on a loaded runner.
  stop(await until(() => engines(hosted)[0], 30_000));

  await hosted.result(message);
  const idled = hosted.house.requests.indexOf(await until(() => hosted.idles[2]));
  expect(idled).toBeGreaterThan(hosted.house.requests.findIndex((request) => request.path === `/kit/inputs/${message}/ack`));
});

it(
  "makes a second conversation's audio wait for the first conversation's transcription",
  async () => {
    const hosted = await transcribing();
    await opened(hosted, 'conversation-1');
    await opened(hosted, 'conversation-2');
    const files = sent(hosted, [
      { name: 'first.wav', media_type: 'audio/wav', content: speech(20) },
      { name: 'second.wav', media_type: 'audio/wav', content: speech(20) },
    ]);
    const seen = new Set<number>();
    let most = 0;
    // Sampling every twenty milliseconds sees each engine that runs, however briefly.
    const sampling = setInterval(() => {
      const running = engines(hosted);
      for (const pid of running) seen.add(pid);
      most = Math.max(most, running.length);
    }, 20);

    hosted.call({ kind: 'message', conversation_id: 'conversation-1', text: 'first', files: [files.described[0]], first: false });
    const first = lastCall();
    // Thirty seconds cover the first engine starting on a loaded runner.
    await until(() => engines(hosted)[0], 30_000);
    hosted.call({ kind: 'message', conversation_id: 'conversation-2', text: 'second', files: [files.described[1]], first: false });
    const second = lastCall();

    try {
      const returned = (call: string) => hosted.results.some((result) => result.params.input === call);
      // A minute covers transcribing both samples one after the other.
      await until(() => returned(first) && returned(second), 60_000);
    } finally {
      clearInterval(sampling);
    }
    expect(most).toBe(1);
    expect(seen.size).toBe(2);
    expect(await prompted(hosted, 1)).toEqual([expect.any(String), expect.any(String), expect.stringMatching(ENGLISH)]);
  },
  // A minute covers two deliberate twenty-second samples on the loaded two-vCPU runner.
  60_000,
);

it('ends a running transcription on an interrupt and writes the message with its bare path once the interrupt has cancelled the turn', async () => {
  const hosted = await transcribing();
  await opened(hosted);
  hosted.call({ kind: 'message', text: '@wait', files: [], first: false });
  const turn = (await until(() => started(hosted)[0])).params.turn!;
  const { described, paths } = sent(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(240) }]);
  // The prompt holds two seconds, so the interrupt reaches the turn while it still runs.
  hosted.call({ kind: 'message', text: '@hold 2000', files: described, first: false });
  const message = lastCall();
  // Thirty seconds cover the engine starting on a loaded runner.
  const engine = await until(() => engines(hosted)[0], 30_000);

  hosted.call({ kind: 'interrupt', turn_id: turn });

  // Three seconds cover the Kit ending the engine it started.
  await until(() => !alive(engine), 3000);
  expect(await hosted.result(message)).toEqual({});
  expect(await prompted(hosted, 1)).toEqual(['@hold 2000', paths[0]]);
  await until(() => ended(hosted)[0]);
  const log = await hosted.adapterLog();
  const methods = log.filter((entry) => entry.method === 'session/prompt' || entry.method === 'session/cancel').map((entry) => entry.method);
  expect(methods).toEqual(['session/prompt', 'session/cancel', 'session/prompt']);
});

it('ends a running transcription on a kill and refuses its message', async () => {
  const hosted = await transcribing();
  await opened(hosted);
  const { described } = sent(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(240) }]);
  hosted.call({ kind: 'message', text: 'listen', files: described, first: false });
  const message = lastCall();
  // Thirty seconds cover the engine starting on a loaded runner.
  const engine = await until(() => engines(hosted)[0], 30_000);

  hosted.call({ kind: 'kill' });

  // Three seconds cover the Kit ending the engine it started.
  await until(() => !alive(engine), 3000);
  expect(await hosted.result(message)).toEqual({ refused: 'the conversation was killed' });
});

it('transcribes the next audio file after an interrupt whose cancel could not reach the CLI', async () => {
  const hosted = await transcribing();
  await opened(hosted);
  hosted.call({ kind: 'message', text: '@deaf\n@gate exit\n@exit 0', files: [], first: false });
  const turn = (await until(() => started(hosted)[0])).params.turn!;
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.deaf === true));
  hosted.call({ kind: 'interrupt', turn_id: turn });
  await hosted.result(lastCall());
  hosted.call({ kind: 'interrupt', turn_id: turn });
  await until(() => hosted.kit.stderr().includes('EPIPE'));
  const { described } = sent(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);

  hosted.call({ kind: 'message', text: 'listen', files: described, first: false });
  await writeFile(join(hosted.home, 'exit'), '');

  await hosted.result(lastCall());
  expect(hosted.kit.stderr()).not.toContain('voice.ogg was not transcribed');
});

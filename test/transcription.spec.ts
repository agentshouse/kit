import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { beforeAll, expect, it, onTestFinished } from 'vitest';
import { attached, bridgeSockets, inspected, posted } from './attachments.ts';
import { cacheArtifacts, pinnedArtifacts } from './curl.ts';
import { until, type Answer } from './double.ts';
import { ENGINES, type TranscriptionReport } from '../src/transcription.ts';
import { hostKit, hostMac, lastCall, lastMessage, opened, type Hosted, type Hosting } from './environment.ts';
import { alive, stop } from './kit.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/audio/${name}`, import.meta.url));
const ENGLISH = /\bdollar\b.*\bcents\b/i;
const RUSSIAN = /чудная ночь/i;
const MACH_O_ARM64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const OFF = "transcription is off on the Agent's Environment, so this message's audio has no text; turn it on or write instead";
const NOT_INSTALLED = "the speech engine is not installed on the Agent's Environment, so this message's audio has no text";
const NOT_DOWNLOADED = 'an audio file this message links could not be downloaded; send the message again';
const UNDECODABLE = 'an audio file this message links could not be decoded';
const UNTRANSCRIBED = 'an audio file this message links could not be transcribed';
const INTERRUPTED = 'the conversation was interrupted';
const started = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/started'));
const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));

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

function linked(text: string, files: { link: string }[]): string {
  return [text, ...files.map((file) => file.link)].join(' ');
}

async function prompts(hosted: Hosted): Promise<Record<string, unknown>[]> {
  return (await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt');
}

async function prompted(hosted: Hosted, index: number): Promise<unknown[]> {
  const found = await until(async () => {
    const written = await prompts(hosted);
    return written.length > index ? written : undefined;
  // Thirty seconds cover transcribing a sample before the CLI double is prompted.
  }, 30_000);
  return (found[index]!.params as { prompt: unknown[] }).prompt;
}

function block(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

function transcribed(path: string, said: RegExp): unknown {
  return { type: 'text', text: expect.stringMatching(new RegExp(`^${path.replaceAll('.', '\\.')}\nTranscript: .*${said.source}`, said.flags)) };
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

function starting(hosted: Hosted): unknown[] {
  return hosted.connection.notifications.filter((notification) => notification.type === 'starting').map((notification) => notification.step);
}

function audioReads(hosted: Hosted): number {
  return hosted.store.requests.filter((request) => request.method === 'GET').length;
}

async function refusedUnprompted(hosted: Hosted, reason: string): Promise<void> {
  expect(await hosted.result(lastCall())).toEqual({ refused: reason });
  expect(await prompts(hosted)).toEqual([]);
}

function held(): { answer: Promise<Answer>; release(): void } {
  let release = (): void => {};
  const answer = new Promise<Answer>((settle) => {
    release = () => settle({ body: {} });
  });
  onTestFinished(() => release());
  return { answer, release };
}

it("posts the transcript of each audio file a message links in the order it links them, then writes the text and each audio file's Path with its Transcript line, keeping every other link as text and no file anywhere", async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'kit-temporary-'));
  onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const hosted = await transcribing({ environment: { TMPDIR: temporary } });
  const files = attached(hosted, [
    { name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') },
    { name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') },
    { name: 'notes.txt', media_type: 'text/plain', content: Buffer.from('plain notes\n') },
    { name: 'untyped', media_type: null, content: Buffer.from('no media type\n') },
  ]);
  const [note, voice] = files;
  const text = linked('listen to these:', files);
  const first = held();
  hosted.house.route('POST', '/kit/conversations/:conversation/messages/:message/transcripts', async (request) => {
    hosted.transcripts.push(request);
    return hosted.transcripts.length === 1 ? first.answer : { body: {} };
  });

  hosted.call({ kind: 'message', text, first: false });
  await until(() => hosted.transcripts[0]);
  // A second outlasts the Kit writing a prompt that does not wait for the transcript House still holds.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(await prompts(hosted)).toEqual([]);
  first.release();

  expect(await hosted.result(lastCall())).toHaveProperty('provider_session_id');
  expect(await prompted(hosted, 0)).toEqual([block(text), transcribed(note!.path, ENGLISH), transcribed(voice!.path, RUSSIAN)]);
  expect(posted(hosted)).toEqual([
    ['conversation-1', lastMessage(), { path: note!.path, text: expect.stringMatching(ENGLISH) }],
    ['conversation-1', lastMessage(), { path: voice!.path, text: expect.stringMatching(RUSSIAN) }],
  ]);
  expect(inspected(hosted)).toEqual(files.map((file) => ({ path: file.path })));
  expect(hosted.store.requests.map((request) => request.key)).toEqual([note!.key, voice!.key]);
  expect(await readdir(hosted.workingDirectory)).toEqual([]);
  expect(await readdir(temporary)).toEqual([]);
});

it.each([['en.ogg', 'audio/ogg'], ['en.webm', 'audio/webm'], ['en.m4a', 'audio/mp4'], ['en.mp3', 'audio/mpeg'], ['en.wav', 'audio/wav']])(
  'transcribes %s',
  async (name, mediaType) => {
    const hosted = await transcribing();
    const [file] = attached(hosted, [{ name, media_type: mediaType, content: fixture(name) }]);

    hosted.call({ kind: 'message', text: linked('listen', [file!]), first: false });

    expect(await prompted(hosted, 0)).toEqual([block(linked('listen', [file!])), transcribed(file!.path, ENGLISH)]);
  },
);

it('transcribes the same audio file once however often the message links it', async () => {
  const hosted = await transcribing();
  const [file] = attached(hosted, [{ name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') }]);
  const text = linked('twice', [file!, file!]);

  hosted.call({ kind: 'message', text, first: false });

  expect(await prompted(hosted, 0)).toEqual([block(text), transcribed(file!.path, ENGLISH)]);
  expect(hosted.transcripts).toHaveLength(1);
});

it("sends the transcription step while it transcribes a message's audio, then the session's start, then its end", async () => {
  const hosted = await transcribing();
  const [file] = attached(hosted, [{ name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') }]);
  const post = held();
  hosted.house.route('POST', '/kit/conversations/:conversation/messages/:message/transcripts', () => post.answer);
  await writeFile(join(hosted.home, 'hold-new'), '');

  hosted.call({ kind: 'message', text: linked('listen', [file!]), first: true });

  await until(() => starting(hosted).length > 0);
  expect(starting(hosted)).toEqual(['transcription']);
  post.release();
  await until(() => starting(hosted).length > 1);
  expect(starting(hosted)).toEqual(['transcription', 'session']);
  await rm(join(hosted.home, 'hold-new'));
  expect(await hosted.result(lastCall())).toHaveProperty('provider_session_id');
  await until(() => starting(hosted).length > 2);
  expect(starting(hosted)).toEqual(['transcription', 'session', null]);
});

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

  const [file] = attached(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);
  hosted.call({ kind: 'message', text: linked('listen', [file!]), first: false });

  expect(await prompted(hosted, 0)).toEqual([block(linked('listen', [file!])), transcribed(file!.path, RUSSIAN)]);
  expect(await downloads(hosted)).toHaveLength(3);
  expect((await readdir(directory)).sort()).toEqual(installed.sort());
});

it('deletes the three artifacts when the setting turns off, refuses a message linking audio then with no download, and downloads them again when it turns on without a restart', async () => {
  const hosted = await transcribing();
  const directory = join(hosted.home, 'transcription');
  const reports = hosted.reports.length;
  const [voice, note] = attached(hosted, [
    { name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') },
    { name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') },
  ]);

  hosted.transcribe(false);

  await settled(hosted, { installed: false, failure: null }, reports);
  expect(existsSync(directory)).toBe(false);
  hosted.call({ kind: 'message', text: linked('off', [voice!]), first: false });
  await refusedUnprompted(hosted, OFF);
  expect(hosted.transcripts).toEqual([]);
  expect(audioReads(hosted)).toBe(0);
  expect(await downloads(hosted)).toHaveLength(3);

  const again = hosted.reports.length;
  hosted.transcribe(true);

  await settled(hosted, { installed: true, failure: null }, again);
  expect(await downloads(hosted)).toHaveLength(6);
  expect(await readdir(directory)).toHaveLength(3);
  hosted.call({ kind: 'message', text: linked('on', [note!]), first: false });
  expect(await prompted(hosted, 0)).toEqual([block(linked('on', [note!])), transcribed(note!.path, ENGLISH)]);
});

it('closes the connection a message opened to read its links once it refuses that message', async () => {
  const hosted = await hostKit();
  const [voice] = attached(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);

  hosted.call({ kind: 'message', text: linked('off', [voice!]), first: false });

  await refusedUnprompted(hosted, OFF);
  expect(inspected(hosted)).toEqual([{ path: voice!.path }]);
  await until(async () => (await bridgeSockets(hosted)).length === 0);
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
  // Half a second outlasts the Kit sending a change Notification, so one not sent by then is not coming.
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

it('refuses an artifact that does not match its hash, installs nothing, reports why, refuses a message linking audio as having no engine and tries again only when the setting next turns on', async () => {
  const corrupt = pinnedArtifacts()[2]!.url;
  const hosted = await hostKit([{}], {
    transcribe: true,
    prepare: (home) => writeFile(join(home, 'curl-corrupt'), corrupt),
  });
  const [voice] = attached(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);

  await settled(hosted, { installed: false, failure: `${corrupt} does not match its sha256` });
  expect(existsSync(join(hosted.home, 'transcription'))).toBe(false);
  const tried = (await downloads(hosted)).length;
  hosted.call({ kind: 'message', text: linked('first', [voice!]), first: false });
  await refusedUnprompted(hosted, NOT_INSTALLED);
  expect(hosted.transcripts).toEqual([]);
  expect(audioReads(hosted)).toBe(0);

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
  hosted.call({ kind: 'message', text: linked('second', [voice!]), first: false });

  expect(await prompted(hosted, 0)).toEqual([block(linked('second', [voice!])), transcribed(voice!.path, RUSSIAN)]);
});

it('stops a download larger than its pinned size, installs nothing and reports why', async () => {
  const [decoder] = pinnedArtifacts();
  const hosted = await hostKit([{}], {
    transcribe: true,
    prepare: (home) => writeFile(join(home, 'curl-oversize'), decoder!.url),
  });

  expect(await settled(hosted, (report) => report.failure !== null)).toEqual({
    installed: false,
    failure: 'curl: (63) Maximum file size exceeded',
  });
  expect(existsSync(join(hosted.home, 'transcription'))).toBe(false);
});

it('refuses a message linking an audio file it cannot decode, posting no transcript and writing no prompt', async () => {
  const hosted = await transcribing();
  const [broken] = attached(hosted, [{ name: 'broken.ogg', media_type: 'audio/ogg', content: Buffer.from('not audio at all') }]);

  hosted.call({ kind: 'message', text: linked('listen', [broken!]), first: false });

  await refusedUnprompted(hosted, UNDECODABLE);
  expect(hosted.transcripts).toEqual([]);
});

it.each([
  ['fails on', '#!/bin/sh\nexit 3\n'],
  ['turns into no text', '#!/bin/sh\nprintf "\\n  \\n"\n'],
])('refuses a message linking an audio file the engine %s, posting no transcript and writing no prompt', async (_case, engine) => {
  const hosted = await transcribing();
  await writeFile(join(hosted.home, 'transcription', ENGINES[`${process.platform}-${process.arch}`]!.engine.sha256), engine);
  const [file] = attached(hosted, [{ name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') }]);

  hosted.call({ kind: 'message', text: linked('listen', [file!]), first: false });

  await refusedUnprompted(hosted, UNTRANSCRIBED);
  expect(hosted.transcripts).toEqual([]);
});

it('posts the transcript of the first audio file of a message whose second it cannot decode, then refuses the message and writes no prompt', async () => {
  const hosted = await transcribing();
  const files = attached(hosted, [
    { name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') },
    { name: 'broken.ogg', media_type: 'audio/ogg', content: Buffer.from('not audio at all') },
    { name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') },
  ]);

  hosted.call({ kind: 'message', text: linked('listen', files), first: false });

  await refusedUnprompted(hosted, UNDECODABLE);
  expect(posted(hosted)).toEqual([['conversation-1', lastMessage(), { path: files[0]!.path, text: expect.stringMatching(ENGLISH) }]]);
  expect(hosted.store.requests.map((request) => request.key)).toEqual([files[0]!.key, files[1]!.key]);
});

it.each<[string, (inspect: string) => string]>([
  ['does not arrive whole', (text) => text.replace(/sha256: \w+/, `sha256: ${'0'.repeat(64)}`)],
  ['has an address the store refuses each time it is asked', (text) => text.replace(/expires=\d+/, 'expires=1')],
])('refuses a message whose audio file %s, posting no transcript and writing no prompt', async (_case, answered) => {
  const hosted = await transcribing();
  const [file] = attached(hosted, [{ name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') }]);
  const read = hosted.tools.inspect!;
  hosted.tools.inspect = async (args, request) => {
    const result = (await read(args, request))!;
    return { content: [{ type: 'text', text: answered(result.content[0]!.text) }] };
  };

  hosted.call({ kind: 'message', text: linked('listen', [file!]), first: false });

  await refusedUnprompted(hosted, NOT_DOWNLOADED);
  expect(hosted.transcripts).toEqual([]);
});

it('asks House again for an audio file whose download address the store refuses as expired, and transcribes it from the new one', async () => {
  const hosted = await transcribing();
  const [file] = attached(hosted, [{ name: 'note.ogg', media_type: 'audio/ogg', content: fixture('en.ogg') }]);
  const read = hosted.tools.inspect!;
  let reads = 0;
  hosted.tools.inspect = async (args, request) => {
    const result = (await read(args, request))!;
    if (++reads > 1) return result;
    const answer = parse(result.content[0]!.text) as Record<string, unknown>;
    return { content: [{ type: 'text', text: stringify({ ...answer, download: hosted.store.address('GET', file!.key, {}, true) }) }] };
  };

  hosted.call({ kind: 'message', text: linked('listen', [file!]), first: false });

  expect(await prompted(hosted, 0)).toEqual([block(linked('listen', [file!])), transcribed(file!.path, ENGLISH)]);
  expect(inspected(hosted)).toEqual([{ path: file!.path }, { path: file!.path }]);
  expect(hosted.store.requests.map((request) => request.status)).toEqual([403, 200]);
});

it('runs the engine on half the CPUs the Environment grants, so work beside it does not slow it tenfold', async () => {
  const hosted = await transcribing();
  await opened(hosted);
  const [file] = attached(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(60) }]);

  hosted.call({ kind: 'message', text: linked('listen', [file!]), first: false });

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
  const [file] = attached(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(240) }]);

  hosted.call({ kind: 'message', text: linked('listen', [file!]), first: false });
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
    const [first, second] = attached(hosted, [
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

    hosted.call({ kind: 'message', conversation_id: 'conversation-1', text: linked('first', [first!]), first: false });
    const firstCall = lastCall();
    // Thirty seconds cover the first engine starting on a loaded runner.
    await until(() => engines(hosted)[0], 30_000);
    hosted.call({ kind: 'message', conversation_id: 'conversation-2', text: linked('second', [second!]), first: false });
    const secondCall = lastCall();

    try {
      const returned = (call: string) => hosted.results.some((result) => result.params.input === call);
      // A minute covers transcribing both samples one after the other.
      await until(() => returned(firstCall) && returned(secondCall), 60_000);
    } finally {
      clearInterval(sampling);
    }
    expect(most).toBe(1);
    expect(seen.size).toBe(2);
    expect(await prompted(hosted, 1)).toEqual([expect.anything(), transcribed(second!.path, ENGLISH)]);
  },
  // A minute covers two deliberate twenty-second samples on the loaded two-vCPU runner.
  60_000,
);

it('ends a running transcription on an interrupt, refuses its message and writes no prompt for it', async () => {
  const hosted = await transcribing();
  await opened(hosted);
  hosted.call({ kind: 'message', text: '@wait', first: false });
  const turn = (await until(() => started(hosted)[0])).params.turn!;
  const [file] = attached(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(240) }]);
  hosted.call({ kind: 'message', text: linked('@say heard', [file!]), first: false });
  const message = lastCall();
  // Thirty seconds cover the engine starting on a loaded runner.
  const engine = await until(() => engines(hosted)[0], 30_000);

  hosted.call({ kind: 'interrupt', turn_id: turn });

  // Three seconds cover the Kit ending the engine it started.
  await until(() => !alive(engine), 3000);
  expect(await hosted.result(message)).toEqual({ refused: INTERRUPTED });
  await until(() => ended(hosted)[0]);
  expect(hosted.transcripts).toEqual([]);
  expect((await prompts(hosted)).map((prompt) => prompt.text)).toEqual(['@wait']);
});

it('ends a running transcription on a kill and refuses its message', async () => {
  const hosted = await transcribing();
  await opened(hosted);
  const [file] = attached(hosted, [{ name: 'long.wav', media_type: 'audio/wav', content: speech(240) }]);
  hosted.call({ kind: 'message', text: linked('listen', [file!]), first: false });
  const message = lastCall();
  // Thirty seconds cover the engine starting on a loaded runner.
  const engine = await until(() => engines(hosted)[0], 30_000);

  hosted.call({ kind: 'kill' });

  // Three seconds cover the Kit ending the engine it started.
  await until(() => !alive(engine), 3000);
  expect(await hosted.result(message)).toEqual({ refused: 'the conversation was killed' });
  expect(hosted.transcripts).toEqual([]);
  expect(await prompts(hosted)).toEqual([]);
});

it('transcribes the next audio file after an interrupt whose cancel could not reach the CLI', async () => {
  const hosted = await transcribing();
  await opened(hosted);
  hosted.call({ kind: 'message', text: '@deaf\n@gate exit\n@exit 0', first: false });
  const turn = (await until(() => started(hosted)[0])).params.turn!;
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.deaf === true));
  hosted.call({ kind: 'interrupt', turn_id: turn });
  await hosted.result(lastCall());
  hosted.call({ kind: 'interrupt', turn_id: turn });
  await until(() => hosted.kit.stderr().includes('EPIPE'));
  const [file] = attached(hosted, [{ name: 'voice.ogg', media_type: 'audio/ogg', content: fixture('ru.ogg') }]);

  hosted.call({ kind: 'message', text: linked('listen', [file!]), first: false });
  await writeFile(join(hosted.home, 'exit'), '');

  expect(await hosted.result(lastCall())).not.toHaveProperty('refused');
  expect(posted(hosted)).toEqual([['conversation-1', lastMessage(), { path: file!.path, text: expect.stringMatching(RUSSIAN) }]]);
});

import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { attached, inspected, link } from './attachments.ts';
import { until } from './double.ts';
import { hostKit, lastCall, opened, type Hosted } from './environment.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PLAN = '/rooms/notes/plan.md';

async function prompt(hosted: Hosted): Promise<unknown> {
  const prompted = await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt'));
  return (prompted.params as { prompt: unknown }).prompt;
}

function held(): { held: Promise<void>; release(): void } {
  let release = (): void => {};
  const held = new Promise<void>((settled) => {
    release = settled;
  });
  return { held, release };
}

function starting(hosted: Hosted): unknown[] {
  return hosted.connection.notifications.filter((notification) => notification.type === 'starting').map((notification) => notification.step);
}

it('keeps a link to an image or a document in the text, reading only what inspect answers of each, downloading nothing and placing nothing in the working directory', async () => {
  const hosted = await hostKit();
  const [photo] = attached(hosted, [{ name: 'photo.jpg', media_type: 'image/jpeg', content: JPEG }], [PLAN]);
  const text = `look at ${photo!.link} beside ${link(PLAN)}`;

  hosted.call({ kind: 'message', text, first: false });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
  expect(await prompt(hosted)).toEqual([{ type: 'text', text }]);
  expect(inspected(hosted)).toEqual([{ path: photo!.path }, { path: PLAN }]);
  expect(hosted.store.requests).toEqual([]);
  expect(hosted.transcripts).toEqual([]);
  expect(await readdir(hosted.workingDirectory)).toEqual([]);
});

it('keeps a link inspect refuses in the text, into a Room the Environment does not reach or to no file, and goes on to the prompt', async () => {
  const hosted = await hostKit();
  const unreached = '/rooms/elsewhere/voice.ogg';
  const missing = '/rooms/private/attachments/2026-10-21/gone.ogg';
  attached(hosted, [], [], { [unreached]: `room_not_found: ${unreached} is in no Room this conversation reaches\n` });
  const text = `hear ${link(unreached)} and ${link(missing)}`;

  hosted.call({ kind: 'message', text, first: false });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
  expect(await prompt(hosted)).toEqual([{ type: 'text', text }]);
  expect(inspected(hosted)).toEqual([{ path: unreached }, { path: missing }]);
  expect(hosted.store.requests).toEqual([]);
  expect(hosted.transcripts).toEqual([]);
});

it('keeps a link in the text whose inspect answer is no mapping, a captured item or a history or listing inspect cut, and goes on to the prompt', async () => {
  const hosted = await hostKit();
  const item = '/rooms/notes/inbox/2026-10-21.md';
  const history = '/rooms/notes/log.md';
  const folder = '/rooms/notes/drafts';
  const answers: Record<string, string> = {
    [item]: `${item}:4-6 revision=rev-item ref=ep_1\nepisode: ep_1\nthe item's own words: a note\n`,
    [history]: `${stringify({ ref: 'doc_1', path: history, media_type: 'text/markdown', revisions: [{ revision: 'rev-2' }] })}inspect: output_cut 1 newest revisions; continue with: inspect ref=rev-1 path=${history} view=history`,
    [folder]: `${stringify({ path: folder, documents: [{ path: `${folder}/a.md` }] })}inspect: output_cut 1 newest documents; continue with: ls -lt ${folder}`,
  };
  hosted.tools.inspect = (args) => ({ content: [{ type: 'text', text: answers[String(args.path)]! }] });
  const text = `see ${link(item)}, ${link(history)} and ${link(folder)}`;

  hosted.call({ kind: 'message', text, first: false });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
  expect(await prompt(hosted)).toEqual([{ type: 'text', text }]);
  expect(inspected(hosted)).toEqual([{ path: item }, { path: history }, { path: folder }]);
  expect(hosted.store.requests).toEqual([]);
});

it("reads a message's links through an interrupt of the running turn and writes its prompt once that turn ends", async () => {
  const hosted = await hostKit();
  await opened(hosted);
  hosted.call({ kind: 'message', text: '@wait', first: false });
  const turn = (await until(() => hosted.turns.find((posted) => posted.path.endsWith('/started')))).params.turn!;
  const [photo] = attached(hosted, [{ name: 'photo.jpg', media_type: 'image/jpeg', content: JPEG }]);
  const read = hosted.tools.inspect!;
  const reading = held();
  hosted.tools.inspect = async (args, request) => {
    await reading.held;
    return read(args, request);
  };
  const text = `@say seen ${photo!.link}`;
  hosted.call({ kind: 'message', text, first: false });
  const message = lastCall();
  await until(() => inspected(hosted).length > 0);

  hosted.call({ kind: 'interrupt', turn_id: turn });
  // Half a second outlasts the Kit receiving the interrupt, so the read it holds is still open when the interrupt arrives.
  await new Promise((resolve) => setTimeout(resolve, 500));
  reading.release();

  expect(await hosted.result(message)).not.toHaveProperty('refused');
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.method === 'session/prompt' && entry.text === text));
});

it("shows only the session's start for a message whose links hold no audio, however long their reads take", async () => {
  const hosted = await hostKit();
  const answer = attached(hosted, [{ name: 'photo.jpg', media_type: 'image/jpeg', content: JPEG }]);
  const read = hosted.tools.inspect!;
  const reading = held();
  hosted.tools.inspect = async (args, request) => {
    await reading.held;
    return read(args, request);
  };
  await writeFile(join(hosted.home, 'hold-new'), '');

  hosted.call({ kind: 'message', text: `look at ${answer[0]!.link}`, first: false });
  await until(() => inspected(hosted).length > 0);
  // A second and a half outlasts the second a start-up step waits before it is shown, so a step not shown by then was never set.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(starting(hosted)).toEqual([]);
  reading.release();

  await until(() => starting(hosted).length > 0);
  expect(starting(hosted)).toEqual(['session']);
  await rm(join(hosted.home, 'hold-new'));
  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
  await until(() => starting(hosted).length > 1);
  expect(starting(hosted)).toEqual(['session', null]);
});

import { expect, it, onTestFinished } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastInput, type Hosted } from './environment.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS = ['codex-acp', 'claude-agent-acp', 'grok-build'];

async function opened(kind: string): Promise<Hosted> {
  const hosted = await hostKit([{ kind }]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  return hosted;
}

async function ends(hosted: Hosted, count: number): Promise<unknown[]> {
  const ended = await until(() => {
    const reported = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
    return reported.length === count ? reported : undefined;
  });
  return ended.map((turn) => turn.body);
}

function notes(hosted: Hosted): Record<string, unknown>[] {
  return hosted.socket.frames.filter((frame) => frame.type === 'working-note');
}

function drafts(hosted: Hosted): Record<string, unknown>[] {
  return hosted.socket.frames.filter((frame) => frame.type === 'draft');
}

function note(text: string): Record<string, unknown> {
  return { type: 'working-note', conversation_id: 'conversation-1', note_id: expect.stringMatching(UUID), text };
}

it.each(KINDS)('sends each working note %s writes between actions as one complete frame and keeps it out of the answer', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({
    kind: 'message',
    text: '@note Let me check the config first\n@tool Read the config\n@note Now the tests\n@tool Run the tests\n@say The config\n@say  is fine.',
    files: [],
    first: true,
  });

  expect(await ends(hosted, 1)).toEqual([{ text: 'The config is fine.' }]);
  expect(notes(hosted)).toEqual([note('Let me check the config first'), note('Now the tests')]);
  expect(new Set(notes(hosted).map((frame) => frame.note_id)).size).toBe(2);
  const answer = await until(() =>
    drafts(hosted).find((frame) => JSON.stringify(frame.blocks).includes('The config is fine.')),
  );
  expect(answer).toMatchObject({ from: 0, blocks: [{ type: 'paragraph', text: 'The config is fine.' }] });
  for (const draft of drafts(hosted)) {
    expect(draft.blocks).toEqual([{ type: 'paragraph', text: expect.stringMatching(/^The config/) }]);
  }
});

it('grows the draft from the answer chunks alone while Codex writes notes between them', async () => {
  const hosted = await opened('codex-acp');

  hosted.input({ kind: 'message', text: '@note Reading it\n@tool Read the file\n@say one\n@say  two', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'one two' }]);
  expect(drafts(hosted).map((frame) => frame.blocks)).toEqual([
    [{ type: 'paragraph', text: 'one' }],
    [{ type: 'paragraph', text: 'one two' }],
  ]);
  expect(notes(hosted)).toEqual([note('Reading it')]);
});

it.each(KINDS)('ends a turn %s writes only notes in with an empty answer', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({ kind: 'message', text: '@note Reading the logs\n@tool Read the logs', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: '' }]);
  expect(notes(hosted)).toEqual([note('Reading the logs')]);
  expect(drafts(hosted)).toEqual([]);
});

it.each(KINDS)('separates the notes and answer of a turn %s starts by itself like those of a prompted turn', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({
    kind: 'message',
    text: '@itself 500 @note Checking the job;@tool Read the job output;@say The job finished',
    files: [],
    first: true,
  });

  expect(await ends(hosted, 2)).toEqual([{ text: '' }, { text: 'The job finished' }]);
  expect(notes(hosted)).toEqual([note('Checking the job')]);
  expect(JSON.stringify(drafts(hosted))).not.toContain('Checking');
});

it.each(KINDS)('never sends the private thought %s writes before an action as a working note', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({ kind: 'message', text: '@think I should read the config\n@tool Read the config\n@say Done', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'Done' }]);
  expect(notes(hosted)).toEqual([]);
  expect(JSON.stringify(drafts(hosted))).not.toContain('I should');
});

it("sends each message Codex marks as commentary as a note of its own, with no action after it", async () => {
  const hosted = await opened('codex-acp');

  hosted.input({ kind: 'message', text: '@note First look\n@note Second look\n@say Done', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'Done' }]);
  expect(notes(hosted)).toEqual([note('First look'), note('Second look')]);
});

it.each(['claude-agent-acp', 'grok-build'])('sends the text %s writes before a plan update as a working note', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({ kind: 'message', text: '@note Let me plan this\n@plan read|fix\n@say Done', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'Done' }]);
  expect(notes(hosted)).toEqual([note('Let me plan this')]);
});

it.each(['claude-agent-acp', 'grok-build'])('keeps the text %s writes with no action after it as the answer', async (kind) => {
  const hosted = await opened(kind);

  hosted.input({ kind: 'message', text: '@note Looking around\n@say  and done', files: [], first: true });

  expect(await ends(hosted, 1)).toEqual([{ text: 'Looking around and done' }]);
  expect(notes(hosted)).toEqual([]);
});

it('sends a note finished before House answered the turn start once House answers it', async () => {
  const hosted = await opened('codex-acp');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  hosted.house.route('POST', '/kit/conversations/:conversation/turns/:turn/started', async (request) => {
    await held;
    hosted.turns.push(request);
    return { body: {} };
  });

  hosted.input({ kind: 'message', text: '@note Reading it\n@tool Read the file\n@ping\n@say Done', files: [], first: true });
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.pinged === true));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(notes(hosted)).toEqual([]);
  release();

  expect(await until(() => notes(hosted)[0])).toEqual(note('Reading it'));
  expect(await ends(hosted, 1)).toEqual([{ text: 'Done' }]);
});

import { CONVERSATION_META_KEY } from '@agentshouse/kit-wire';
import { agentInstructions, listSkills } from '@agentshouse/skills';
import { expect, it } from 'vitest';
import { catalogue } from './catalogue.ts';
import { until } from './double.ts';
import { hostKit, lastCall, shelled, type Hosted, type McpCall, type ToolAnswer, type ToolResult } from './environment.ts';
import { alive } from './kit.ts';

const DOCUMENT = '# Owner rules\n\nWork goes into the Room it belongs to.';
const READ = 'cat /rooms/private/owner-rules.md';
const WHOLE_CHARACTERS = 30_000;
const SHOWN_BYTES = 2048;
const LONG_BYTES = 102_400;

type Prompt = { type: string; text: string }[];

async function prompts(hosted: Hosted, count: number): Promise<Prompt[]> {
  return until(async () => {
    const sent = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt');
    return sent.length >= count ? sent.map((entry) => (entry.params as { prompt: Prompt }).prompt) : undefined;
  });
}

function refused(code: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: you read no Room there\n` }] };
}

const LINES = agentInstructions();

const SKILLS = listSkills().map(({ name }) => name);

function blockOf(prompt: Prompt): string[] {
  expect(prompt).toHaveLength(2);
  expect(prompt[1]).toEqual({ type: 'text', text: 'hello' });
  return prompt[0]!.text.split('\n');
}

it("begins a first message with the package's Agent instructions, the base instructions and the Owner rules read over the conversation's bridge, the same for every CLI, writing no Owner rules with the Skill set installed and naming no `conversation` action", async () => {
  const kinds = ['codex-acp', 'claude-agent-acp', 'grok-build'];
  const hosted = await hostKit(kinds.map((kind) => ({ kind })), { skills: 'all', tools: { guide: catalogue(SKILLS) } });
  hosted.tools.shell = () => shelled(DOCUMENT);

  for (const [index] of kinds.entries()) {
    hosted.call({
      kind: 'message',
      conversation_id: `conversation-${index + 1}`,
      agent_id: `agent-${index + 1}`,
      text: 'hello',
      first: true,
    });
  }

  const sent = await prompts(hosted, kinds.length);
  expect(LINES.length).toBeGreaterThan(1);
  expect(blockOf(sent[0]!)).toEqual([...LINES, '', 'Be useful.', '', ...DOCUMENT.split('\n')]);
  expect(sent[0]![0]!.text).not.toMatch(/`conversation` action/i);
  for (const prompt of sent) expect(prompt).toEqual(sent[0]);
  expect(
    hosted.mcp
      .filter((received) => (received.body as McpCall).params.name !== 'guide')
      .map((received) => [received.headers.authorization, (received.body as McpCall).params._meta[CONVERSATION_META_KEY], (received.body as McpCall).params.arguments])
      .sort(),
  ).toEqual(kinds.map((_, index) => ['Bearer ahk_held', `conversation-${index + 1}`, { command: READ, long: true }]));
});

it.each([
  ['an absent document', shelled('', 1, ['cat: path_not_found /rooms/private/owner-rules.md'])],
  ['a Private Room the Profile cannot read', refused('room_not_found')],
  ['a read the Profile does not allow', refused('operation_denied')],
])('adds nothing for %s and still sends the message', async (_case, answer) => {
  const hosted = await hostKit();
  hosted.tools.shell = () => answer;

  hosted.call({ kind: 'message', text: 'hello', first: true });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
  expect(blockOf((await prompts(hosted, 1))[0]!)).toEqual([...LINES, '', 'Be useful.']);
});

it('refuses a first message with the cause when House cannot answer the document read', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/', () => ({ status: 503, body: { error: { code: 'house_unavailable', retryable: false } } }));

  hosted.call({ kind: 'message', text: 'hello', first: true });

  expect(await hosted.result(lastCall())).toEqual({ refused: expect.stringContaining('503') });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt')).toEqual([]);
});

it.each([
  ['house_unavailable', refused('house_unavailable')],
  ['is_a_directory', shelled('', 1, ['cat: is_a_directory /rooms/private/owner-rules.md'])],
])("refuses a first message with House's answer when the document read fails with %s", async (code, answer) => {
  const hosted = await hostKit();
  hosted.tools.shell = () => answer;

  hosted.call({ kind: 'message', text: 'hello', first: true });

  expect(await hosted.result(lastCall())).toEqual({ refused: expect.stringContaining(code) });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt')).toEqual([]);
});

function readAsHouse(document: string): ToolAnswer {
  const lines = document.split(/(?<=\n)/u);
  return (args) => {
    const from = args.command === READ ? 1 : Number(new RegExp(`^\\{ ${READ}; \\} \\| tail -n \\+(\\d+)$`, 'u').exec(String(args.command))![1]);
    const rest = lines.slice(from - 1);
    const text = rest.join('');
    const bytes = Buffer.byteLength(text);
    if ([...text].length <= WHOLE_CHARACTERS || (args.long === true && bytes <= LONG_BYTES)) return shelled(text);
    const bound = args.long === true ? LONG_BYTES - 200 : SHOWN_BYTES;
    let shown = 0;
    let held = 0;
    while (held + Buffer.byteLength(rest[shown]!) <= bound) held += Buffer.byteLength(rest[shown++]!);
    const line =
      args.long === true
        ? `shell: output_cut ${held} of ${bytes} bytes; with long: true, continue with: { ${READ}; } | tail -n +${from + shown}`
        : `shell: output_cut ${held} of ${bytes} bytes, ${shown} of ${rest.length} lines; narrow the command with rg -n '<words>' or grep -n, or print a range with sed -n '<from>,<to>p'; or run it again with long: true for up to 100 KB`;
    return shelled(rest.slice(0, shown).join(''), 0, [line]);
  };
}

it.each([
  ['40,000 characters, which come whole at 100 KB', 40_000, 1],
  ['250 KB, which come in three replies', 250_000, 3],
])('reads Owner rules of %s whole, asking with long: true and following each cut line to the command that reads on', async (_size, size, reads) => {
  const hosted = await hostKit();
  const rule = '- Work goes into the Room it belongs to; é.\n';
  const document = `# Owner rules\n\n${rule.repeat(Math.ceil(size / rule.length))}`;
  hosted.tools.shell = readAsHouse(document);

  hosted.call({ kind: 'message', text: 'hello', first: true });

  expect(blockOf((await prompts(hosted, 1))[0]!).slice(LINES.length).join('\n')).toBe(`\nBe useful.\n\n${document.replace(/\n$/, '')}`);
  const asked = hosted.mcp.map((received) => (received.body as McpCall).params.arguments!);
  expect(asked).toHaveLength(reads);
  expect(asked.map((args) => args.long)).toEqual(Array(reads).fill(true));
  expect(asked[0]).toEqual({ command: READ, long: true });
});

it('keeps document lines that read like House diagnostics, in one reply and after a continuation', async () => {
  const hosted = await hostKit();
  const first = 'stderr: use the approved workflow\n';
  const rest = 'stderr: shell: output_cut 1 of 2 bytes; with long: true, continue with: cat /elsewhere\nDone.';
  const next = `{ ${READ}; } | tail -n +2`;
  hosted.tools.shell = (args) =>
    args.command === READ
      ? shelled(first, 0, [`shell: output_cut ${first.length} of ${(first + rest).length} bytes; with long: true, continue with: ${next}`])
      : shelled(rest);

  hosted.call({ kind: 'message', text: 'hello', first: true });

  expect(blockOf((await prompts(hosted, 1))[0]!).slice(LINES.length).join('\n')).toBe(`\nBe useful.\n\n${first}${rest}`);
  expect(hosted.mcp.map((received) => (received.body as McpCall).params.arguments)).toEqual([
    { command: READ, long: true },
    { command: next, long: true },
  ]);
});

it('stops the session it opened for a first message it refuses, so the next message opens one and reports it', async () => {
  const hosted = await hostKit();
  hosted.tools.shell = () => refused('house_unavailable');
  hosted.call({ kind: 'message', text: 'hello', first: true });
  await hosted.result(lastCall());
  hosted.tools.shell = () => shelled(DOCUMENT);

  hosted.call({ kind: 'message', text: 'hello', first: true });

  const returned = await hosted.result(lastCall());
  const opened = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/new');
  expect(opened).toHaveLength(2);
  expect(returned).toEqual({ provider_session_id: opened[1]!.sessionId });
  expect(alive(opened[0]!.pid as number)).toBe(false);
});

it('carries no block on a message that is not first', async () => {
  const hosted = await hostKit();
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());

  hosted.call({ kind: 'message', text: 'hello', first: false });

  expect((await prompts(hosted, 1))[0]).toEqual([{ type: 'text', text: 'hello' }]);
  expect(hosted.mcp).toEqual([]);
});

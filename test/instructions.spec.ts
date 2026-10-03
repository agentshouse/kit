import { expect, it } from 'vitest';
import { until } from './double.ts';
import { conversationCredential, hostKit, lastInput, shelled, type Hosted, type McpCall, type ToolResult } from './environment.ts';
import { alive } from './kit.ts';

const DOCUMENT = '# How we work\n\nWork goes into the Room it belongs to.';
const READ = 'cat /private/library/how-we-work.md';

type Prompt = { type: string; text: string }[];

async function prompts(hosted: Hosted, count: number): Promise<Prompt[]> {
  return until(async () => {
    const sent = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt');
    return sent.length >= count ? sent.map((entry) => (entry.params as { prompt: Prompt }).prompt) : undefined;
  });
}

function refused(code: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: check the reference, then call again.\n` }] };
}

function blockOf(prompt: Prompt): string[] {
  expect(prompt).toHaveLength(2);
  expect(prompt[1]).toEqual({ type: 'text', text: 'hello' });
  return prompt[0]!.text.split('\n');
}

it('begins a first message with the house line, the file line, the App line, the base instructions and the How-we-work text, the same for every CLI', async () => {
  const kinds = ['codex-acp', 'claude-agent-acp', 'grok-build'];
  const hosted = await hostKit(kinds.map((kind) => ({ kind })));
  hosted.tools.shell = () => shelled(DOCUMENT);

  for (const [index] of kinds.entries()) {
    hosted.input({
      kind: 'message',
      conversation_id: `conversation-${index + 1}`,
      agent_id: `agent-${index + 1}`,
      text: 'hello',
      files: [],
      first: true,
    });
  }

  const sent = await prompts(hosted, kinds.length);
  const [houseLine, fileLine, appLine, ...rest] = blockOf(sent[0]!);
  expect(houseLine).toContain('`house`');
  expect(fileLine).toContain('`house upload_attachment`');
  expect(appLine).toBe(`To show the User a page, upload it or push it to an App instead of starting a server; \`git clone ${hosted.house.origin}/app/new.git\` starts a new App.`);
  expect(rest.join('\n')).toBe(`\nBe useful.\n\n${DOCUMENT}`);
  for (const prompt of sent) expect(prompt).toEqual(sent[0]);
  expect(
    hosted.mcp.map((received) => [received.headers.authorization, (received.body as McpCall).params.arguments]).sort(),
  ).toEqual(
    kinds.map((_, index) => [
      `Bearer ${conversationCredential(`conversation-${index + 1}`)}`,
      { command: READ },
    ]),
  );
});

it.each([
  ['an absent document', shelled('', 1, ['cat: path_not_found /private/library/how-we-work.md'])],
  ['a Private Room the Profile cannot read', refused('room_not_found')],
  ['a read the Profile does not allow', refused('operation_denied')],
])('adds nothing for %s and still sends the message', async (_case, answer) => {
  const hosted = await hostKit();
  hosted.tools.shell = () => answer;

  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  const [houseLine, fileLine, appLine, ...rest] = blockOf((await prompts(hosted, 1))[0]!);
  expect(houseLine).toContain('`house`');
  expect(fileLine).toContain('`house upload_attachment`');
  expect(appLine).toBe(`To show the User a page, upload it or push it to an App instead of starting a server; \`git clone ${hosted.house.origin}/app/new.git\` starts a new App.`);
  expect(rest.join('\n')).toBe('\nBe useful.');
});

it('refuses a first message with the cause when House cannot answer the document read', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/', () => ({ status: 503, body: { error: { code: 'house_unavailable' } } }));

  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });

  expect(await hosted.ack(lastInput())).toEqual({ refused: expect.stringContaining('503') });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt')).toEqual([]);
});

it.each([
  ['house_unavailable', refused('house_unavailable')],
  ['is_a_directory', shelled('', 1, ['cat: is_a_directory /private/library/how-we-work.md'])],
])("refuses a first message with House's answer when the document read fails with %s", async (code, answer) => {
  const hosted = await hostKit();
  hosted.tools.shell = () => answer;

  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });

  expect(await hosted.ack(lastInput())).toEqual({ refused: expect.stringContaining(code) });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt')).toEqual([]);
});

it('reads a document longer than one House reply whole by following its continuation', async () => {
  const hosted = await hostKit();
  const document = `# How we work\n\n${'- Work goes into the Room it belongs to; é.\n'.repeat(900)}`;
  const shown = Buffer.from(document).subarray(0, 32_769).toString();
  const next = `{ ${READ}; } | tail -c +32770`;
  hosted.tools.shell = (args) =>
    args.command === READ
      ? shelled(shown, 0, [`shell: output_cut 32769 of ${Buffer.byteLength(document)} bytes; continue with: ${next}`])
      : shelled(Buffer.from(document).subarray(32_769).toString());

  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });

  expect(blockOf((await prompts(hosted, 1))[0]!).slice(3).join('\n')).toBe(`\nBe useful.\n\n${document.replace(/\n$/, '')}`);
  expect(hosted.mcp.map((received) => (received.body as McpCall).params.arguments)).toEqual([{ command: READ }, { command: next }]);
});

it('keeps document lines that read like House diagnostics, in one reply and after a continuation', async () => {
  const hosted = await hostKit();
  const first = 'stderr: use the approved workflow\n';
  const rest = 'stderr: shell: output_cut 1 of 2 bytes; continue with: cat /elsewhere\nDone.';
  const next = `{ ${READ}; } | tail -n +2`;
  hosted.tools.shell = (args) =>
    args.command === READ
      ? shelled(first, 0, [`shell: output_cut ${first.length} of ${(first + rest).length} bytes; continue with: ${next}`])
      : shelled(rest);

  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });

  expect(blockOf((await prompts(hosted, 1))[0]!).slice(3).join('\n')).toBe(`\nBe useful.\n\n${first}${rest}`);
  expect(hosted.mcp.map((received) => (received.body as McpCall).params.arguments)).toEqual([{ command: READ }, { command: next }]);
});

it('stops the session it opened for a first message it refuses, so the next message opens one and reports it', async () => {
  const hosted = await hostKit();
  hosted.tools.shell = () => refused('house_unavailable');
  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });
  await hosted.ack(lastInput());
  hosted.tools.shell = () => shelled(DOCUMENT);

  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });

  const acked = await hosted.ack(lastInput());
  const opened = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/new');
  expect(opened).toHaveLength(2);
  expect(acked).toEqual({ provider_session_id: opened[1]!.sessionId });
  expect(alive(opened[0]!.pid as number)).toBe(false);
});

it('carries no block on a message that is not first', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: 'hello', files: [], first: false });

  expect((await prompts(hosted, 1))[0]).toEqual([{ type: 'text', text: 'hello' }]);
  expect(hosted.mcp).toEqual([]);
});

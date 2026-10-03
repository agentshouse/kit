import { expect, it } from 'vitest';
import { until } from './double.ts';
import { conversationCredential, hostKit, lastInput, type Hosted, type McpCall } from './environment.ts';

const DOCUMENT = '# How we work\n\nWork goes into the Room it belongs to.';

type Prompt = { type: string; text: string }[];

async function prompts(hosted: Hosted, count: number): Promise<Prompt[]> {
  return until(async () => {
    const sent = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt');
    return sent.length >= count ? sent.map((entry) => (entry.params as { prompt: Prompt }).prompt) : undefined;
  });
}

function blockOf(prompt: Prompt): string[] {
  expect(prompt).toHaveLength(2);
  expect(prompt[1]).toEqual({ type: 'text', text: 'hello' });
  return prompt[0]!.text.split('\n');
}

it('begins a first message with the house line, the file line, the base instructions and the How-we-work text, the same for every CLI', async () => {
  const kinds = ['codex-acp', 'claude-agent-acp', 'grok-build'];
  const hosted = await hostKit(kinds.map((kind) => ({ kind })));
  hosted.tools.inspect = () => ({ content: [{ type: 'text', text: DOCUMENT }] });

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
  const [houseLine, fileLine, ...rest] = blockOf(sent[0]!);
  expect(houseLine).toContain('`house`');
  expect(fileLine).toContain('`house upload_attachment`');
  expect(rest.join('\n')).toBe(`\nBe useful.\n\n${DOCUMENT}`);
  for (const prompt of sent) expect(prompt).toEqual(sent[0]);
  expect(
    hosted.mcp.map((received) => [received.headers.authorization, (received.body as McpCall).params.arguments]).sort(),
  ).toEqual(
    kinds.map((_, index) => [
      `Bearer ${conversationCredential(`conversation-${index + 1}`)}`,
      { path: '/private/library/how-we-work.md' },
    ]),
  );
});

it('adds nothing for an absent or unreadable How-we-work document and still sends the message', async () => {
  const hosted = await hostKit();

  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });

  expect(await hosted.ack(lastInput())).toEqual({ provider_session_id: expect.any(String) });
  const [houseLine, fileLine, ...rest] = blockOf((await prompts(hosted, 1))[0]!);
  expect(houseLine).toContain('`house`');
  expect(fileLine).toContain('`house upload_attachment`');
  expect(rest.join('\n')).toBe('\nBe useful.');
});

it('refuses a first message with the cause when House cannot answer the document read', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/', () => ({ status: 503, body: { error: { code: 'house_unavailable' } } }));

  hosted.input({ kind: 'message', text: 'hello', files: [], first: true });

  expect(await hosted.ack(lastInput())).toEqual({ refused: expect.stringContaining('503') });
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt')).toEqual([]);
});

it('carries no block on a message that is not first', async () => {
  const hosted = await hostKit();
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: 'hello', files: [], first: false });

  expect((await prompts(hosted, 1))[0]).toEqual([{ type: 'text', text: 'hello' }]);
  expect(hosted.mcp).toEqual([]);
});

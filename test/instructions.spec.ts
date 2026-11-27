import { agentInstructions, GUIDE, listSkills } from '@agentshouse/skills';
import { expect, it } from 'vitest';
import { catalogue } from './catalogue.ts';
import { until } from './double.ts';
import { hostKit, lastCall, shelled, type Hosted, type McpCall } from './environment.ts';

const OWN_RULES = '# Owner rules\n\nWork goes into the Room it belongs to.';

type Prompt = { type: string; text: string }[];

async function prompts(hosted: Hosted, count: number): Promise<Prompt[]> {
  return until(async () => {
    const sent = (await hosted.adapterLog()).filter((entry) => entry.method === 'session/prompt');
    return sent.length >= count ? sent.map((entry) => (entry.params as { prompt: Prompt }).prompt) : undefined;
  });
}

const LINES = agentInstructions();

const WHERE_WORK_GOES = GUIDE.find((page) => page.path === 'where-work-goes')!.text.trimEnd();

const SKILLS = listSkills().map(({ name }) => name);

function blockOf(prompt: Prompt): string {
  expect(prompt).toHaveLength(2);
  expect(prompt[1]).toEqual({ type: 'text', text: 'hello' });
  return prompt[0]!.text;
}

it("begins a first message with House's lines, ending with the where-work-goes page, then the base instructions, the same for every CLI, reading nothing through House for it and naming no `conversation` action", async () => {
  const kinds = ['codex-acp', 'claude-agent-acp', 'grok-build'];
  const hosted = await hostKit(kinds.map((kind) => ({ kind })), { skills: 'all', tools: { guide: catalogue(SKILLS) } });
  hosted.tools.shell = () => shelled(OWN_RULES);

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
  expect(LINES.at(-1)).toBe(WHERE_WORK_GOES);
  expect(blockOf(sent[0]!)).toBe([...LINES, '', 'Be useful.'].join('\n'));
  expect(sent[0]![0]!.text).not.toMatch(/`conversation` action/i);
  for (const prompt of sent) expect(prompt).toEqual(sent[0]);
  expect(hosted.mcp.filter((received) => (received.body as McpCall).params.name !== 'guide')).toEqual([]);
});

it('carries no block on a message that is not first', async () => {
  const hosted = await hostKit();
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());

  hosted.call({ kind: 'message', text: 'hello', first: false });

  expect((await prompts(hosted, 1))[0]).toEqual([{ type: 'text', text: 'hello' }]);
  expect(hosted.mcp).toEqual([]);
});

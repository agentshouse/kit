import { agentInstructions } from '@agentshouse/skills';
import type { Bridge } from './bridge.ts';
import { HOUSE_REF } from './git.ts';

const OWNER_RULES = '/rooms/private/owner-rules.md';
const UNREADABLE = /^(?:\S+: )?(?:path_not_found|room_not_found|operation_denied)\b/;
const FAILED = /^exit: [1-9]\d*$/;
const CUT = /^stderr: shell: output_cut (\d+) of \d+ bytes; continue with: (.+)$/;

function cutOf(lines: string[]): RegExpExecArray | null {
  const cut = CUT.exec(lines[0] ?? '');
  return cut !== null && Buffer.byteLength(lines.slice(1).join('\n')) === Number(cut[1]) ? cut : null;
}

async function readOwnerRules(bridge: Bridge): Promise<string> {
  let document = '';
  for (let command: string | undefined = `cat ${OWNER_RULES}`; command !== undefined; ) {
    const read = await bridge.tool('shell', { command });
    const text = read.content.map((content) => content.text).join('\n');
    const lines = text.split('\n');
    if (read.isError === true || (FAILED.test(lines[0] ?? '') && lines[1]?.startsWith('stderr: '))) {
      const refusal = read.isError === true ? text : lines.slice(1).join('\n').replace(/^stderr: /gm, '');
      if (UNREADABLE.test(refusal)) return '';
      throw new Error(refusal);
    }
    const cut = cutOf(lines);
    document += lines.slice(cut === null ? 0 : 1).join('\n');
    command = cut?.[2];
  }
  return document;
}

export async function instructions(bridge: Bridge, base: string, copies: string[]): Promise<string> {
  const lines = agentInstructions(HOUSE_REF, copies);
  return [lines.join('\n'), base, (await readOwnerRules(bridge)).replace(/\n$/, '')].filter((part) => part !== '').join('\n\n');
}

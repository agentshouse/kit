import { agentInstructions } from '@agentshouse/skills';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bridge } from './bridge.ts';

const UNREADABLE = /^(?:\S+: )?(?:path_not_found|room_not_found|operation_denied)\b/;
const FAILED = /^exit: [1-9]\d*$/;
const CUT = /^stderr: shell: output_cut (\d+) of \d+ bytes; (?:with long: true, )?continue with: (.+)$/;

function cutOf(lines: string[]): RegExpExecArray | null {
  const cut = CUT.exec(lines[0] ?? '');
  return cut !== null && Buffer.byteLength(lines.slice(1).join('\n')) === Number(cut[1]) ? cut : null;
}

export async function shellDocument(bridge: Pick<Bridge, 'tool'>, path: string): Promise<string | null> {
  let document = '';
  for (let command: string | undefined = `cat ${path}`; command !== undefined; ) {
    const read = await bridge.tool('shell', { command });
    const text = read.content.map((content) => content.text).join('\n');
    const lines = text.split('\n');
    if (read.isError === true || (FAILED.test(lines[0] ?? '') && lines[1]?.startsWith('stderr: '))) {
      const refusal = read.isError === true ? text : lines.slice(1).join('\n').replace(/^stderr: /gm, '');
      if (UNREADABLE.test(refusal)) return null;
      throw new Error(refusal);
    }
    const cut = cutOf(lines);
    document += lines.slice(cut === null ? 0 : 1).join('\n');
    command = cut?.[2];
  }
  return document;
}

function block(base: string, last: string): string {
  return [agentInstructions().join('\n'), base, last.replace(/\n$/, '')].filter((part) => part !== '').join('\n\n');
}

export function instructions(base: string): string {
  return block(base, '');
}

export async function copyInstructions(base: string, copy: string, reads: boolean): Promise<string> {
  return block(base, reads ? '' : await readFile(join(copy, 'AGENTS.md'), 'utf8').catch(() => ''));
}

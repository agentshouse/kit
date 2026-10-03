import type { Bridge } from './bridge.ts';

const HOUSE_LINE = 'Work with House through the `house` CLI: run `house --help`.';
const FILE_LINE = 'To give the User a file, upload it with `house upload_attachment` and link it in your answer.';
const HOW_WE_WORK = '/private/library/how-we-work.md';

export async function instructions(bridge: Bridge, base: string): Promise<string> {
  const read = await bridge.tool('inspect', { path: HOW_WE_WORK });
  const document = read.isError === true ? '' : read.content.map((content) => content.text).join('\n');
  return [`${HOUSE_LINE}\n${FILE_LINE}`, base, document].filter((part) => part !== '').join('\n\n');
}

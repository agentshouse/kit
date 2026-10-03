export type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'code'; language: string | null; text: string };

const FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)/;

export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let fence: { marker: string; language: string | null; lines: string[] } | null = null;

  const closeParagraph = () => {
    const joined = paragraph.join('\n').trim();
    if (joined.length > 0) blocks.push({ type: 'paragraph', text: joined });
    paragraph = [];
  };
  const closeFence = () => {
    const joined = fence!.lines.join('\n');
    if (joined.length > 0) blocks.push({ type: 'code', language: fence!.language, text: joined });
    fence = null;
  };

  for (const line of text.split('\n')) {
    if (fence !== null) {
      if (line.trim().startsWith(fence.marker)) closeFence();
      else fence.lines.push(line);
      continue;
    }
    const opening = FENCE.exec(line);
    if (opening !== null) {
      closeParagraph();
      fence = { marker: opening[1]!, language: opening[2] || null, lines: [] };
    } else if (line.trim().length === 0) {
      closeParagraph();
    } else {
      paragraph.push(line);
    }
  }
  if (fence !== null) closeFence();
  closeParagraph();
  return blocks;
}

export function firstChange(before: Block[], after: Block[]): number {
  let index = 0;
  while (
    index < before.length &&
    index < after.length &&
    JSON.stringify(before[index]) === JSON.stringify(after[index])
  ) {
    index++;
  }
  return index;
}

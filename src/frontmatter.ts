const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/u;

export function frontmatter(text: string): string | null {
  return FRONTMATTER.exec(text)?.[1] ?? null;
}

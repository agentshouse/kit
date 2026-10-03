import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const README_LINE_BUDGET = 60;

it('keeps the public README short and free of development references', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  expect(readme.split('\n').length).toBeLessThanOrEqual(README_LINE_BUDGET);
  expect(readme).not.toMatch(/github\.com\/agentshouse\/(?!kit\b)/);
  expect(readme).not.toMatch(/\b(?:R\d{1,3}|PRD-\d+|ADR-\d+)\b/);
});

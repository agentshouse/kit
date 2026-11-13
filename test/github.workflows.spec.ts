import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);
const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/u;

interface Step {
  readonly uses?: string;
}

it('takes every action at one commit', () => {
  const workflows = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'));
  const steps = workflows.flatMap((name) => {
    const { jobs } = parse(readFileSync(new URL(name, WORKFLOWS), 'utf8')) as { jobs: Record<string, { steps?: Step[] }> };
    return Object.values(jobs).flatMap((job) => (job.steps ?? []).map((step) => ({ name, uses: step.uses })));
  });

  expect(workflows).toContain('publish.yml');
  expect(steps.flatMap(({ name, uses }) => (uses === undefined || PINNED_ACTION.test(uses) ? [] : [`${name}: ${uses}`]))).toEqual([]);
});

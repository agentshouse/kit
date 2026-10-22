import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);
const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/u;
const PINNED_IMAGE = /^(?:docker:\/\/)?[^@\s]+@sha256:[0-9a-f]{64}$/u;

interface Step {
  readonly uses?: string;
  readonly with?: { readonly image?: string; readonly 'driver-opts'?: string };
}

function taken(step: Step): { action: string[]; image: string[] } {
  const options = (step.with?.['driver-opts'] ?? '').split('\n').filter((line) => line.startsWith('image='));
  const images = [...(step.with?.image === undefined ? [] : [step.with.image]), ...options.map((line) => line.slice('image='.length))];
  if (step.uses?.startsWith('docker://')) return { action: [], image: [step.uses, ...images] };
  return { action: step.uses === undefined ? [] : [step.uses], image: images };
}

it('takes every action at one commit and starts every container a step names at one digest', () => {
  const workflows = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'));
  const steps = workflows.flatMap((name) => {
    const { jobs } = parse(readFileSync(new URL(name, WORKFLOWS), 'utf8')) as { jobs: Record<string, { steps?: Step[] }> };
    return Object.values(jobs).flatMap((job) => (job.steps ?? []).map((step) => ({ name, ...taken(step) })));
  });

  expect(workflows).toContain('publish.yml');
  expect(steps.flatMap(({ name, action }) => action.filter((uses) => !PINNED_ACTION.test(uses)).map((uses) => `${name}: ${uses}`))).toEqual([]);
  expect(steps.flatMap(({ name, image }) => image.filter((reference) => !PINNED_IMAGE.test(reference)).map((reference) => `${name}: ${reference}`))).toEqual([]);
});

import { expect, it } from 'vitest';
import { chassisForm } from '../src/agents.ts';

it.each([
  ['8', 'laptop'],
  ['10', 'laptop'],
  ['31', 'laptop'],
  ['3', 'desktop'],
  ['7', 'desktop'],
  ['16', 'desktop'],
  ['17', 'server'],
  ['22', 'server'],
  ['24', 'server'],
])('classifies Linux chassis type %s as %s', (chassis, form) => {
  expect(chassisForm(chassis)).toBe(form);
});

it.each(['', '1', '2', '11', '12', '13', '25', 'not-a-chassis'])('omits unknown chassis type %s', (chassis) => {
  expect(chassisForm(chassis)).toBeUndefined();
});

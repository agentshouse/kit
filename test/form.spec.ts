import { expect, it } from 'vitest';
import { chassisForm, hostVm } from '../src/agents.ts';

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

it.each([
  ['LinuxKit Docker Desktop', true],
  ['Microsoft WSL2', true],
  ['Linux version 6.8.0-generic', false],
])('recognizes whether a container sees a desktop host VM from %s', (version, expected) => {
  expect(hostVm(version)).toBe(expected);
});

import { readFileSync } from 'node:fs';

const now = Date.now;

function shift(): number {
  try {
    return Number(readFileSync(process.env.KIT_CLOCK_SHIFT!, 'utf8'));
  } catch {
    return 0;
  }
}

Date.now = () => now() + shift();

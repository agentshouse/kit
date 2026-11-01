import { appendFileSync } from 'node:fs';

const later = globalThis.setTimeout;

const SCHEDULE = new Set([1000, 2000, 3000, 5000, 8000, 11_000, 15_000]);

// A test-only Kit records each pause of the not-ready schedule and takes it at once, so a spec reads the whole schedule in moments.
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
  if (!SCHEDULE.has(delay ?? 0) || !new Error().stack!.includes('paused')) return later(callback, delay, ...args);
  appendFileSync(process.env.KIT_TEST_PAUSES!, `${delay}\n`);
  return later(callback, 5, ...args);
}) as typeof setTimeout;

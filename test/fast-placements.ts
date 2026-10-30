import { PLACEMENT_RETRY_MS } from '../src/update.ts';

const later = globalThis.setTimeout;

// A test-only refused Kit tries its placement again after a third of a second, so a spec sees it try twice within the second it watches.
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
  later(callback, delay === PLACEMENT_RETRY_MS ? 300 : delay, ...args)) as typeof setTimeout;

import { CLI_SILENCE_MS } from '../src/acp.ts';

const later = globalThis.setTimeout;

// A test-only Kit ends a CLI that owes it an answer after five silent seconds, longer than a test CLI takes to start on a loaded runner.
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
  later(callback, delay === CLI_SILENCE_MS ? 5_000 : delay, ...args)) as typeof setTimeout;

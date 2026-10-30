import { CLI_UPDATE_MS } from '../src/agents.ts';

const every = globalThis.setInterval;

// A test-only Kit runs each CLI's update command again every second, so a spec sees one run while a held turn is still open.
globalThis.setInterval = ((handler: () => void, timeout?: number) =>
  every(handler, timeout === CLI_UPDATE_MS ? 1_000 : timeout)) as typeof setInterval;

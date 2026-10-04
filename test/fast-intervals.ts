const every = globalThis.setInterval;

globalThis.setInterval = ((handler: () => void, timeout?: number) =>
  every(handler, Math.min(timeout ?? 0, 300))) as typeof setInterval;

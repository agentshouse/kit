import { afterEach, expect, it, vi } from 'vitest';
import { relayed } from '../src/relay.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('reaches House directly when no relay is named', () => {
  expect(relayed('https://dev.agents.house/kit/stream').href).toBe('https://dev.agents.house/kit/stream');
});

it('carries every House address through the named relay with its host first', () => {
  vi.stubEnv('HOUSE_KIT_RELAY', 'https://relay.example');
  expect(relayed('wss://dev.agents.house/kit/stream').href).toBe('wss://relay.example/dev.agents.house/kit/stream');
  expect(relayed('https://files.dev.agents.house/t/abc?x=1').href).toBe(
    'https://relay.example/files.dev.agents.house/t/abc?x=1',
  );
});

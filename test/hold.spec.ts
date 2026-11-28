import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { certificate, settle, until } from './double.ts';
import { clocked, hostKit, type Hosted } from './environment.ts';
import { startRelay, type Relay } from './relay-double.ts';

const HELD_CLOCK = ['./moved-clock.ts', './fast-holds.ts'].flatMap((module) => ['--import', fileURLToPath(new URL(module, import.meta.url))]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const LIMITED = { status: 429, retryAfter: null, own: false };

interface Relayed {
  hosted: Hosted;
  relay: Relay;
  shift(by: number): Promise<void>;
}

async function relayed(): Promise<Relayed> {
  const tls = certificate();
  const relay = await startRelay(tls);
  const clock = await clocked();
  const hosted = await hostKit([{}], {
    environment: { HOUSE_KIT_RELAY: relay.origin, NODE_EXTRA_CA_CERTS: tls.path, ...clock.hosting.environment },
    node: HELD_CLOCK,
  });
  return { hosted, relay, shift: clock.shift };
}

function reached(hosted: Hosted, path: string): number {
  return hosted.house.requests.filter((request) => request.path === path).length;
}

function refusedAt(relay: Relay, path: string): number {
  return relay.requests.filter((request) => request.limited && request.path === path).length;
}

async function quiet(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function heldModule() {
  vi.resetModules();
  return import('../src/hold.ts');
}

afterEach(() => {
  vi.useRealTimers();
});

it('holds every call and every opening of its connection for the 120 seconds a refusal that is not House’s own names in Retry-After, and the first call after them goes through', async () => {
  const { hosted, relay, shift } = await relayed();
  const listed = reached(hosted, '/kit/agents/desired/list');
  relay.limit({ status: 429, headers: { 'Retry-After': '120' } });

  hosted.transcribe(false);
  await until(() => refusedAt(relay, '/kit/agents/desired/list') > 0);
  const sent = relay.requests.length;
  hosted.connection.close(1012, 'deploy');
  await quiet(3_500);
  await shift(110_000);
  await quiet(1_000);

  expect(relay.requests.length).toBe(sent);
  expect(hosted.house.connections).toHaveLength(1);
  relay.limit(null);
  await shift(121_000);
  await until(() => hosted.house.connections[1]);
  await until(() => reached(hosted, '/kit/agents/desired/list') > listed);
  expect(relay.requests.slice(sent).every((request) => !request.limited)).toBe(true);
});

it('holds every call and every opening of its connection after a 429 that names no time and is not House’s own, lets one call out as each hold ends, and the first call through releases them all', async () => {
  const { hosted, relay, shift } = await relayed();
  const listed = reached(hosted, '/kit/agents/desired/list');
  relay.limit({ status: 429 });

  hosted.transcribe(false);
  await until(() => refusedAt(relay, '/kit/agents/desired/list') > 0);
  const sent = relay.requests.length;
  hosted.connection.close(1012, 'deploy');
  await quiet(3_500);
  expect(relay.requests.length).toBe(sent);

  for (let quarter = 1; quarter <= 3; quarter++) {
    await shift(quarter * 15 * MINUTE);
    await until(() => relay.requests.length === sent + quarter);
    await settle();
    expect(relay.requests.length).toBe(sent + quarter);
  }
  expect(relay.requests.slice(sent).every((request) => request.limited)).toBe(true);
  expect(hosted.house.connections).toHaveLength(1);
  relay.limit(null);
  await shift(4 * 15 * MINUTE);
  await until(() => hosted.house.connections[1]);
  await until(() => reached(hosted, '/kit/agents/desired/list') > listed);
});

it('sends a call again on the jittered curve after a 503 that names no Retry-After, holding nothing', async () => {
  const { hosted, relay } = await relayed();
  const listed = reached(hosted, '/kit/agents/desired/list');
  relay.limit({ status: 503 }, 2);

  hosted.transcribe(false);

  await until(() => reached(hosted, '/kit/agents/desired/list') > listed);
  expect(refusedAt(relay, '/kit/agents/desired/list')).toBe(2);
});

it('lets at most four calls an hour out through a day of 429s that name no time, one at a time, and the first call through lets every held call go', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { answered, held, THROUGH } = await heldModule();
  const start = Date.now();
  const sent: number[] = [];
  const through: number[] = [];
  let limited = true;
  const call = async (index: number) => {
    while (sent.length < 10_000) {
      const pass = await held();
      sent.push(Date.now() - start);
      if (!limited) {
        answered(pass, THROUGH);
        through.push(index);
        return;
      }
      answered(pass, LIMITED);
    }
  };
  const calls = [0, 1, 2, 3, 4].map(call);

  await vi.advanceTimersByTimeAsync(24 * HOUR);

  const hourly = Array.from({ length: 24 }, (_, hour) => sent.filter((at) => at >= hour * HOUR && at < (hour + 1) * HOUR).length);
  expect(Math.max(...hourly.slice(1))).toBeLessThanOrEqual(4);
  expect(hourly[0]).toBeLessThanOrEqual(5 + 8);
  const after = sent.length;
  limited = false;
  await vi.advanceTimersByTimeAsync(HOUR / 4);
  await Promise.all(calls);
  expect(through.sort()).toEqual([0, 1, 2, 3, 4]);
  expect(sent.length - after).toBe(5);
});

it.each([
  ['a lost answer', null],
  ['a 503 that is not House’s own', { status: 503, retryAfter: null, own: false }],
])('keeps the curve of 429s that name no time through %s, which releases no held call', async (_answer, answer) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { answered, held } = await heldModule();
  answered(await held(), LIMITED);
  await vi.advanceTimersByTimeAsync(2 * MINUTE);
  answered(await held(), answer);
  answered(await held(), LIMITED);
  let went = false;
  void held().then(() => {
    went = true;
  });

  await vi.advanceTimersByTimeAsync(4 * MINUTE - 1_000);
  expect(went).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(went).toBe(true);
});

it.each([
  ['seconds', '120'],
  ['a date', new Date(Date.UTC(2026, 10, 22, 12, 2, 0)).toUTCString()],
])('holds every call until the time a Retry-After in %s names, not a second less', async (_form, retryAfter) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.UTC(2026, 10, 22, 12, 0, 0) });
  const { answered, held } = await heldModule();
  answered(await held(), { status: 503, retryAfter, own: false });
  let went = 0;
  const calls = [held(), held()].map((waiting) => waiting.then(() => went++));

  await vi.advanceTimersByTimeAsync(119_000);
  expect(went).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all(calls);
  expect(went).toBe(2);
});

it.each([
  ['a 503 that names no time', { status: 503, retryAfter: null, own: false }],
  ['a refusal House wrote, its own 429 naming its wait in Retry-After', { status: 429, retryAfter: '3600', own: true }],
])('holds no call after %s', async (_answer, answer) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { answered, held } = await heldModule();
  answered(await held(), answer);
  let went = false;
  void held().then(() => {
    went = true;
  });

  await vi.advanceTimersByTimeAsync(1_000);
  expect(went).toBe(true);
});

it.each([
  ['stops waiting', ['stop.abort();']],
  ['is let go by a lost answer and stops waiting before it goes', ['answered({ round: 0, probe: false, held: false }, null);', 'stop.abort();']],
])('keeps no process from ending once the only call held by a Retry-After %s', async (_how, steps) => {
  const script = [
    `import { answered, held } from ${JSON.stringify(new URL('../src/hold.ts', import.meta.url).href)};`,
    `answered(await held(), { status: 503, retryAfter: '120', own: false });`,
    'const stop = new AbortController();',
    'const waiting = held(stop.signal).catch(() => {});',
    ...steps,
    'await waiting;',
  ].join('\n');

  await expect(promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { timeout: 10_000 })).resolves.toBeDefined();
});

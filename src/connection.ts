import { subscribe } from 'node:diagnostics_channel';
import { HouseRefusal, retryDelay } from './api.ts';
import type { Call } from './calls.ts';
import { end, REPLACED, signInAgain } from './end.ts';
import { readEnrolment } from './home.ts';
import { relayed } from './relay.ts';
import { endUnserved, KIT_WIRE } from './wire.ts';

export type Notification = { type: string } & Record<string, unknown>;

export interface ConnectionHandlers {
  opened(): void;
  closed(): void;
  call(call: Call): void;
  notification(notification: Notification): void;
}

export interface Connection {
  send(notification: Notification): boolean;
}

interface Answered {
  request: { path: string };
  response: { statusCode: number; statusText: string; headers: Buffer[] };
}

const PATH = '/kit/stream';
const SUBPROTOCOL = `house.kit.stream.${KIT_WIRE}`;
const REFUSAL_HEADER = 'x-house-refusal';
// House beats each Kit connection every thirty seconds, so two silent beats mean this Kit process cannot hear House.
export const CONNECTION_SILENCE_MS = 60_000;

export interface ConnectionClock {
  later(delay: number, callback: () => void): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CONNECTION_CLOCK: ConnectionClock = {
  later: (delay, callback) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer),
};

export class ConnectionSilence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly silent: () => void;
  private readonly clock: ConnectionClock;
  private readonly interval: number;

  constructor(
    silent: () => void,
    clock: ConnectionClock = SYSTEM_CONNECTION_CLOCK,
    interval = CONNECTION_SILENCE_MS,
  ) {
    this.silent = silent;
    this.clock = clock;
    this.interval = interval;
  }

  heard(): void {
    this.stop();
    this.timer = this.clock.later(this.interval, () => {
      this.timer = null;
      this.silent();
    });
  }

  stop(): void {
    if (this.timer === null) return;
    this.clock.clear(this.timer);
    this.timer = null;
  }
}

function connectionUrl(house: string): URL {
  const url = new URL(PATH, house);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

function header(headers: Buffer[], name: string): string {
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]!.toString('latin1').toLowerCase() === name) return headers[index + 1]!.toString('latin1');
  }
  return '';
}

let refused: HouseRefusal | null = null;

subscribe('undici:request:headers', (message) => {
  const { request, response } = message as Answered;
  if (!request.path.endsWith(PATH)) return;
  refused = new HouseRefusal(PATH, response.statusCode, header(response.headers, REFUSAL_HEADER) || response.statusText);
});

export function holdConnection(handlers: ConnectionHandlers): Connection {
  let connection: WebSocket | null = null;
  let failures = 0;

  const connect = async () => {
    const { house, credential } = (await readEnrolment())!;
    refused = null;
    const opening = new WebSocket(relayed(connectionUrl(house)), {
      protocols: [SUBPROTOCOL],
      headers: { authorization: `Bearer ${credential}` },
    } as unknown as string[]);
    let opened = false;
    let silence: ConnectionSilence | null = null;
    const closed = (event: CloseEvent) => {
      silence?.stop();
      silence = null;
      if (connection === opening) connection = null;
      handlers.closed();
      process.stderr.write(`kit: connection closed ${event.code} ${event.reason}\n`);
      if (event.reason === 'replaced') end(REPLACED);
      if (event.reason === 'credential_rejected' || refused?.status === 401) {
        void signInAgain(credential);
        return;
      }
      if (refused !== null) endUnserved(refused.text);
      if (!opened && refused !== null) process.stderr.write(`kit: ${refused.message}\n`);
      // A closed connection reopens in one to three seconds, spread so Kit processes one restart closed return apart; an opening House refused or left unanswered backs off on the jittered curve, retryable or not, since a resident outlives a House deploy.
      setTimeout(() => void connect(), opened ? 1000 + Math.random() * 2000 : retryDelay(failures++));
    };
    opening.onopen = () => {
      opened = true;
      failures = 0;
      connection = opening;
      silence = new ConnectionSilence(() => {
        if (connection !== opening) return;
        connection = null;
        opening.onclose = null;
        opening.close();
        closed(new CloseEvent('close', { code: 1006, reason: 'heartbeat_missed' }));
      });
      silence.heard();
      handlers.opened();
    };
    opening.onmessage = (event) => {
      silence?.heard();
      const arrived = JSON.parse(String(event.data)) as Notification;
      if (arrived.type === 'input') handlers.call(arrived as unknown as Call);
      else if (arrived.type !== 'beat') handlers.notification(arrived);
    };
    opening.onerror = () => undefined;
    opening.onclose = closed;
  };

  void connect();
  return {
    send(notification) {
      if (connection === null || connection.readyState !== WebSocket.OPEN) return false;
      connection.send(JSON.stringify(notification));
      return true;
    },
  };
}

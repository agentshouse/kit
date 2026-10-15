import { subscribe } from 'node:diagnostics_channel';
import { finalRefusal, HouseRefusal, retryDelay } from './api.ts';
import { end, REPLACED, signInAgain, updateRequired } from './end.ts';
import { readEnrolment } from './home.ts';
import { relayed } from './relay.ts';
import { KIT_WIRE, tooOld } from './wire.ts';

export type Frame = { type: string } & Record<string, unknown>;

export interface StreamHandlers {
  opened(): void;
  frame(frame: Frame): void;
}

export interface Stream {
  send(frame: Frame): boolean;
}

interface Answered {
  request: { path: string };
  response: { statusCode: number; statusText: string; headers: Buffer[] };
}

const PATH = '/kit/stream';
const SUBPROTOCOL = `house.kit.stream.${KIT_WIRE}`;
const REFUSAL_HEADER = 'x-house-refusal';
// House beats each stream every thirty seconds, so two silent beats mean this Kit cannot hear House.
export const STREAM_SILENCE_MS = 60_000;

export interface StreamClock {
  later(delay: number, callback: () => void): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_STREAM_CLOCK: StreamClock = {
  later: (delay, callback) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer),
};

export class StreamSilence {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly silent: () => void,
    private readonly clock: StreamClock = SYSTEM_STREAM_CLOCK,
    private readonly interval = STREAM_SILENCE_MS,
  ) {}

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

function streamUrl(house: string): URL {
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

export function holdStream(handlers: StreamHandlers): Stream {
  let socket: WebSocket | null = null;
  let failures = 0;

  const connect = async () => {
    const { house, credential } = (await readEnrolment())!;
    refused = null;
    const opening = new WebSocket(relayed(streamUrl(house)), {
      protocols: [SUBPROTOCOL],
      headers: { authorization: `Bearer ${credential}` },
    } as unknown as string[]);
    let opened = false;
    let silence: StreamSilence | null = null;
    const closed = (event: CloseEvent) => {
      silence?.stop();
      silence = null;
      if (socket === opening) socket = null;
      process.stderr.write(`kit: control stream closed ${event.code} ${event.reason}\n`);
      if (event.reason === 'replaced') end(REPLACED);
      if (event.reason === 'credential_rejected' || refused?.status === 401) {
        void signInAgain(credential);
        return;
      }
      if (refused !== null && tooOld(refused.text)) updateRequired(house);
      if (finalRefusal(refused)) end(refused.message);
      // A closed socket reopens in one to three seconds, spread so Kits one restart closed return apart; an opening House refused as retryable or left unanswered backs off on the jittered curve.
      setTimeout(() => void connect(), opened ? 1000 + Math.random() * 2000 : retryDelay(failures++));
    };
    opening.onopen = () => {
      opened = true;
      failures = 0;
      socket = opening;
      silence = new StreamSilence(() => {
        if (socket !== opening) return;
        socket = null;
        opening.onclose = null;
        opening.close();
        closed(new CloseEvent('close', { code: 1006, reason: 'heartbeat_missed' }));
      });
      silence.heard();
      handlers.opened();
    };
    opening.onmessage = (event) => {
      silence?.heard();
      const frame = JSON.parse(String(event.data)) as Frame;
      if (frame.type !== 'beat') handlers.frame(frame);
    };
    opening.onerror = () => undefined;
    opening.onclose = closed;
  };

  void connect();
  return {
    send(frame) {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(frame));
      return true;
    },
  };
}

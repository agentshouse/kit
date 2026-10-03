import { readEnrolment } from './home.ts';

export type Frame = { type: string } & Record<string, unknown>;

const SUBPROTOCOL = 'house.kit.stream.1';

function streamUrl(house: string): URL {
  const url = new URL('/kit/stream', house);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

export function holdStream(frame: (received: Frame) => void): void {
  let failures = 0;

  const connect = async () => {
    const { house, credential } = (await readEnrolment())!;
    const opening = new WebSocket(streamUrl(house), {
      protocols: [SUBPROTOCOL],
      headers: { authorization: `Bearer ${credential}` },
    } as unknown as string[]);
    let opened = false;
    opening.onopen = () => {
      opened = true;
      failures = 0;
    };
    opening.onmessage = (event) => {
      frame(JSON.parse(String(event.data)) as Frame);
    };
    opening.onerror = () => undefined;
    opening.onclose = (event) => {
      process.stderr.write(`kit: control stream closed ${event.code} ${event.reason}\n`);
      const delay = opened
        ? 1000 + Math.random() * 2000
        : Math.min(30_000, 1000 * 2 ** failures++);
      setTimeout(() => void connect(), delay);
    };
  };

  void connect();
}

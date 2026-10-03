export type Frame = { type: string } & Record<string, unknown>;

export interface StreamHandlers {
  opened(): void;
  frame(frame: Frame): void;
}

export interface Stream {
  send(frame: Frame): boolean;
}

const SUBPROTOCOL = 'house.kit.stream.1';

function streamUrl(house: string): URL {
  const url = new URL('/kit/stream', house);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

export function holdStream(house: string, credential: string, handlers: StreamHandlers): Stream {
  let socket: WebSocket | null = null;
  let failures = 0;

  const connect = () => {
    const opening = new WebSocket(streamUrl(house), {
      protocols: [SUBPROTOCOL],
      headers: { authorization: `Bearer ${credential}` },
    } as unknown as string[]);
    let opened = false;
    opening.onopen = () => {
      opened = true;
      failures = 0;
      socket = opening;
      handlers.opened();
    };
    opening.onmessage = (event) => {
      handlers.frame(JSON.parse(String(event.data)) as Frame);
    };
    opening.onerror = () => undefined;
    opening.onclose = (event) => {
      if (socket === opening) socket = null;
      process.stderr.write(`kit: control stream closed ${event.code} ${event.reason}\n`);
      const delay = opened
        ? 1000 + Math.random() * 2000
        : Math.min(30_000, 1000 * 2 ** failures++);
      setTimeout(connect, delay);
    };
  };

  connect();
  return {
    send(frame) {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(frame));
      return true;
    },
  };
}

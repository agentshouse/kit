import { Server, type Socket } from 'node:net';

type Emit = (event: string | symbol, ...args: unknown[]) => boolean;

// A third of a second keeps Codex's own stream behind the adapter messages that follow it, as a loaded machine can.
const LATE_MS = 300;

const emit = Server.prototype.emit as Emit;
Server.prototype.emit = function (this: Server, event: string | symbol, ...args: unknown[]): boolean {
  if (event === 'connection' && this.constructor === Server) {
    const socket = args[0] as Socket;
    const own = socket.emit as Emit;
    socket.emit = function (this: Socket, name: string | symbol, ...rest: unknown[]): boolean {
      if (name !== 'data') return own.call(this, name, ...rest);
      setTimeout(() => own.call(this, name, ...rest), LATE_MS);
      return true;
    } as Socket['emit'];
  }
  return emit.call(this, event, ...args);
} as Server['emit'];

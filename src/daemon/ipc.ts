import net from 'node:net';
import os from 'node:os';
import { getLogger } from '../util/logger.js';

export interface IpcRequest {
  id: string;
  op: string;
  payload?: unknown;
}

export interface IpcResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function pipePath(name: string): string {
  if (os.platform() === 'win32') {
    return `\\\\.\\pipe\\${name}`;
  }
  return `/tmp/${name}.sock`;
}

export type IpcHandler = (req: IpcRequest) => Promise<unknown>;

export class IpcServer {
  private server: net.Server | null = null;
  private log = getLogger('ipc:server');
  constructor(
    public readonly name: string,
    public readonly handler: IpcHandler
  ) {}

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const path = pipePath(this.name);
      this.server = net.createServer((socket) => this.handleConn(socket));
      this.server.on('error', (e) => {
        this.log.error({ err: String(e), path }, 'ipc server error');
        reject(e);
      });
      this.server.listen(path, () => {
        this.log.info({ path }, 'ipc server listening');
        resolve();
      });
    });
  }

  private handleConn(socket: net.Socket): void {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req: IpcRequest;
        try {
          req = JSON.parse(line);
        } catch {
          this.send(socket, { id: '?', ok: false, error: 'invalid json' });
          continue;
        }
        try {
          const data = await this.handler(req);
          this.send(socket, { id: req.id, ok: true, data });
        } catch (e) {
          this.send(socket, {
            id: req.id,
            ok: false,
            error: (e as Error).message ?? String(e),
          });
        }
      }
    });
  }

  private send(socket: net.Socket, res: IpcResponse): void {
    try {
      socket.write(JSON.stringify(res) + '\n');
    } catch {
      /* socket gone */
    }
  }

  async close(): Promise<void> {
    const s = this.server;
    if (!s) return;
    return new Promise((resolve) => {
      s.close(() => resolve());
      this.server = null;
    });
  }
}

export class IpcClient {
  private log = getLogger('ipc:client');
  constructor(public readonly name: string) {}

  async request<T = unknown>(op: string, payload?: unknown, timeoutMs = 15000): Promise<T> {
    const path = pipePath(this.name);
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(path);
      const id = Math.random().toString(36).slice(2);
      const req: IpcRequest = { id, op, payload };
      let buf = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`ipc request '${op}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'));
      socket.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl).trim();
        try {
          const res = JSON.parse(line) as IpcResponse;
          if (res.id !== id) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (res.ok) resolve(res.data as T);
          else reject(new Error(res.error ?? `ipc op '${op}' failed`));
        } catch (e) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`invalid ipc response: ${String(e)}`));
        }
      });
      socket.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.log.debug({ err: String(e), path }, 'ipc socket error');
        reject(new Error(`cannot reach daemon at ${path}: ${(e as Error).message}`));
      });
    });
  }

  isAlive(): Promise<boolean> {
    return this.request('ping')
      .then(() => true)
      .catch(() => false);
  }
}

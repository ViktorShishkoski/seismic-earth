import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Relay } from './relay.ts';
import type { RelayConfig } from './config.ts';

/**
 * The relay's public surface: a small HTTP API and one WebSocket.
 *
 * Built on Node's own http server and `ws` rather than a framework — there are
 * three routes, and the fewer dependencies this has, the fewer ways `npm
 * install` can fail on someone else's machine.
 *
 *   GET  /health          what the relay and each source are doing
 *   GET  /events          merged events in a window
 *   GET  /events/:id      one event with every network report behind it
 *   WS   /live            a snapshot, then every change inside your window
 */

export interface ApiServer {
  server: Server;
  close(): Promise<void>;
}

export function createApi(relay: Relay, config: RelayConfig): ApiServer {
  const server = createServer((req, res) => handleHttp(req, res, relay, config));
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/live') {
      socket.destroy();
      return;
    }
    if (!originAllowed(req.headers.origin, config)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleLive(ws, relay));
  });

  // Tell every browser how the sources are doing, so the status line can say
  // "EMSC reconnecting" rather than silently going stale.
  const statusTimer = setInterval(() => relay.hub.broadcastStatus(relay.status()), 15_000);
  statusTimer.unref?.();

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(statusTimer);
        wss.close();
        server.close(() => resolve());
      }),
  };
}

function handleLive(socket: WebSocket, relay: Relay): void {
  relay.hub.add(socket);
  relay.hub.send(socket, {
    type: 'hello',
    protocol: 1,
    status: relay.status(),
  });

  socket.on('message', (raw: unknown) => {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isObject(message) || message.type !== 'subscribe') return;

    const subscription = relay.hub.subscribe(socket, {
      from: numberOr(message.from, undefined),
      minMag: numberOr(message.minMag, undefined),
    });
    // Answer a subscription with everything already known inside it, so the
    // browser needs no separate HTTP call to fill the globe.
    const events = relay.store.query({
      from: subscription.from,
      minMag: subscription.minMag,
      limit: numberOr(message.limit, 20_000),
    });
    relay.hub.send(socket, {
      type: 'snapshot',
      generated: Date.now(),
      window: subscription,
      events,
    });
  });
}

function handleHttp(req: IncomingMessage, res: ServerResponse, relay: Relay, config: RelayConfig): void {
  const origin = req.headers.origin;
  if (originAllowed(origin, config)) {
    res.setHeader('access-control-allow-origin', config.allowedOrigins.includes('*') ? '*' : (origin ?? '*'));
    res.setHeader('vary', 'origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Only GET' });

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/health' || path === '/') {
    return json(res, 200, { ok: true, ...relay.status() });
  }

  if (path === '/events') {
    const events = relay.store.query({
      from: numberOr(url.searchParams.get('from'), undefined),
      to: numberOr(url.searchParams.get('to'), undefined),
      minMag: numberOr(url.searchParams.get('minMag'), undefined),
      limit: numberOr(url.searchParams.get('limit'), 20_000),
    });
    return json(res, 200, { generated: Date.now(), count: events.length, events });
  }

  const one = path.match(/^\/events\/(.+)$/);
  if (one) {
    const event = relay.store.get(decodeURIComponent(one[1]!));
    return event ? json(res, 200, event) : json(res, 404, { error: 'No such event' });
  }

  return json(res, 404, { error: 'No such route' });
}

function originAllowed(origin: string | undefined, config: RelayConfig): boolean {
  // No Origin header: a direct request (curl, a server), which CORS does not govern.
  if (!origin) return true;
  return config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function numberOr<T>(value: unknown, fallback: T): number | T {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

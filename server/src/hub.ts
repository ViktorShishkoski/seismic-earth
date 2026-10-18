import type { WebSocket } from 'ws';
import type { MergedEvent } from './types.ts';
import type { RelayStatus } from './status.ts';

/**
 * The browsers currently watching.
 *
 * Each one subscribes to a window (how far back, which magnitudes) and is sent
 * a snapshot of it, then only the events that change inside it. Filtering here
 * rather than in the browser keeps a phone watching the past hour from
 * receiving a year of data.
 */

export interface Subscription {
  /** Oldest origin time the client cares about (ms since epoch). */
  from: number;
  minMag: number;
}

const DEFAULT_SUBSCRIPTION: Subscription = { from: 0, minMag: -Infinity };

interface Client {
  socket: WebSocket;
  subscription: Subscription;
  /** Set by the pong handler; a client that misses two beats is dropped. */
  alive: boolean;
}

export class Hub {
  private readonly clients = new Map<WebSocket, Client>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  get size(): number {
    return this.clients.size;
  }

  add(socket: WebSocket): Client {
    const client: Client = { socket, subscription: { ...DEFAULT_SUBSCRIPTION }, alive: true };
    this.clients.set(socket, client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
    return client;
  }

  subscribe(socket: WebSocket, subscription: Partial<Subscription>): Subscription {
    const client = this.clients.get(socket);
    if (!client) return { ...DEFAULT_SUBSCRIPTION };
    if (typeof subscription.from === 'number' && Number.isFinite(subscription.from)) {
      client.subscription.from = subscription.from;
    }
    if (typeof subscription.minMag === 'number') {
      client.subscription.minMag = subscription.minMag;
    }
    return { ...client.subscription };
  }

  send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  /** Pushes each client only the events inside its own window. */
  broadcast(events: readonly MergedEvent[]): void {
    if (events.length === 0) return;
    for (const client of this.clients.values()) {
      const wanted = events.filter((e) => matches(e, client.subscription));
      if (wanted.length > 0) this.send(client.socket, { type: 'upsert', events: wanted });
    }
  }

  broadcastStatus(status: RelayStatus): void {
    for (const client of this.clients.values()) this.send(client.socket, { type: 'status', status });
  }

  /**
   * Drops clients that stopped answering. A browser that sleeps or a tunnel
   * that dies leaves a socket that looks open but never closes.
   */
  startHeartbeat(intervalMs = 30_000): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.alive) {
          client.socket.terminate();
          this.clients.delete(client.socket);
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          this.clients.delete(client.socket);
        }
      }
    }, intervalMs);
    this.heartbeat.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  closeAll(): void {
    this.stopHeartbeat();
    for (const client of this.clients.values()) client.socket.close(1001, 'relay shutting down');
    this.clients.clear();
  }
}

export function matches(event: MergedEvent, subscription: Subscription): boolean {
  return event.time >= subscription.from && event.mag >= subscription.minMag;
}

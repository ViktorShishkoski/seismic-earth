import { WebSocket } from 'ws';
import { parseEmscCollection, parseEmscMessage } from '../normalize.ts';
import { newSourceStatus, type SourceStatus } from '../status.ts';
import type { SourceEvent } from '../types.ts';

/**
 * EMSC pushes.
 *
 * The Euro-Mediterranean Seismological Centre runs a standing WebSocket that
 * sends each new or revised event the moment it is published — no polling
 * delay. That is the reason this relay exists: it is the difference between
 * learning about an earthquake within seconds and waiting out a poll.
 *
 * A socket held open for days fails in ways a request does not, so this client
 * assumes it will break: it reconnects with a widening backoff, and treats a
 * socket that has gone quiet for too long as dead even though it still looks
 * open. Whatever happened while it was down is recovered from EMSC's FDSN
 * service on reconnect.
 *
 * The message shape follows EMSC's published documentation for the service.
 */

const WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket';
const FDSN_URL = 'https://www.seismicportal.eu/fdsnws/event/1/query';

export interface EmscSourceOptions {
  url?: string;
  fdsnUrl?: string;
  /** Longest gap with no message before the socket is assumed dead. */
  silenceMs?: number;
  /** First retry delay; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  historyDays?: number;
  backfillMinMag?: number;
  backfillLimit?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** Swappable in tests. */
  createSocket?: (url: string) => WebSocket;
}

export class EmscSource {
  readonly status: SourceStatus = newSourceStatus('emsc', 'stream');

  private readonly url: string;
  private readonly fdsnUrl: string;
  private readonly silenceMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly historyDays: number;
  private readonly backfillMinMag: number;
  private readonly backfillLimit: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly createSocket: (url: string) => WebSocket;

  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private attempt = 0;
  private stopped = false;
  /** True once the first connection has been made, so later ones backfill the gap. */
  private connectedBefore = false;

  private readonly onEvents: (events: SourceEvent[]) => void;

  constructor(onEvents: (events: SourceEvent[]) => void, options: EmscSourceOptions = {}) {
    this.onEvents = onEvents;
    this.url = options.url ?? WS_URL;
    this.fdsnUrl = options.fdsnUrl ?? FDSN_URL;
    this.silenceMs = options.silenceMs ?? 15 * 60_000;
    this.baseBackoffMs = options.backoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.historyDays = options.historyDays ?? 7;
    this.backfillMinMag = options.backfillMinMag ?? 2.5;
    this.backfillLimit = options.backfillLimit ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.backfill();
    this.connect();
    this.watchForSilence();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.retryTimer = this.silenceTimer = null;
    this.closeSocket();
    this.status.connected = false;
  }

  /** Catches up on everything published while the relay (or the socket) was down. */
  async backfill(): Promise<number> {
    const start = new Date(Date.now() - this.historyDays * 86_400_000).toISOString().slice(0, 19);
    const url = `${this.fdsnUrl}?format=json&starttime=${start}&minmag=${this.backfillMinMag}&limit=${this.backfillLimit}`;
    try {
      const response = await this.fetchFn(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { events, skipped } = parseEmscCollection(await response.json());
      this.status.lastContactAt = Date.now();
      this.status.received += events.length;
      this.status.rejected += skipped;
      this.onEvents(events);
      return events.length;
    } catch (err) {
      this.note(err);
      return 0;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.closeSocket();

    let socket: WebSocket;
    try {
      socket = this.createSocket(this.url);
    } catch (err) {
      this.note(err);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.status.connected = true;
      this.status.failures = 0;
      this.status.lastError = null;
      this.status.lastContactAt = Date.now();
      this.lastMessageAt = Date.now();
      this.attempt = 0;
      // A reconnect means a gap; ask FDSN what was missed.
      if (this.connectedBefore) void this.backfill();
      this.connectedBefore = true;
    });

    socket.on('message', (raw: unknown) => this.handleMessage(String(raw)));

    socket.on('close', () => {
      this.status.connected = false;
      if (!this.stopped) this.scheduleRetry();
    });

    socket.on('error', (err: Error) => {
      this.note(err);
      // 'close' follows 'error', and that is where the retry is scheduled.
    });
  }

  private handleMessage(raw: string): void {
    this.lastMessageAt = Date.now();
    this.status.lastContactAt = this.lastMessageAt;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.status.rejected++;
      return;
    }
    const parsed = parseEmscMessage(json);
    if (!parsed) {
      this.status.rejected++;
      return;
    }
    this.status.received++;
    this.status.lastEventAt = this.lastMessageAt;
    this.onEvents([parsed.event]);
  }

  /** A socket can stay open and silent; treat a long quiet spell as a failure. */
  private watchForSilence(): void {
    this.silenceTimer = setInterval(() => {
      if (this.stopped || !this.status.connected) return;
      if (Date.now() - this.lastMessageAt > this.silenceMs) {
        this.status.lastError = `no messages for ${Math.round(this.silenceMs / 60_000)} min — reconnecting`;
        this.connect();
      }
    }, 60_000);
    this.silenceTimer.unref?.();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    // Exponential backoff with jitter, so a restarting server is not hammered
    // and many relays do not all retry on the same tick.
    const delay = Math.min(this.baseBackoffMs * 2 ** this.attempt, this.maxBackoffMs);
    const jittered = delay * (0.5 + Math.random() * 0.5);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, jittered);
    this.retryTimer.unref?.();
  }

  private closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.removeAllListeners();
    // Tearing down a connection that is still shaking hands makes `ws` emit one
    // last error. Without a listener an EventEmitter rethrows it and takes the
    // process down — exactly when the network is flapping and we reconnect most.
    socket.on('error', () => {});
    try {
      socket.terminate();
    } catch {
      /* already gone */
    }
  }

  private note(err: unknown): void {
    this.status.connected = false;
    this.status.failures++;
    this.status.lastError = err instanceof Error ? err.message : String(err);
  }
}

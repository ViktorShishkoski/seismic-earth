import type { QuakeStore } from './QuakeStore.ts';
import type { Quake } from './quake.ts';
import { USGS_FEEDS, type FeedId, DEFAULT_FEED } from './usgs.ts';
import { liveSocketUrl, type FeedSnapshotEvent, type FeedStatus, type QuakeFeed, type RelayInfo } from './feed.ts';

/**
 * Talks to the relay in `server/`.
 *
 * The browser asks for a window ("everything in the past week above M 0") and
 * the relay answers with a snapshot, then sends each event that changes inside
 * that window as it happens — no polling, no waiting for the next minute to
 * tick over. Every event carries the networks that reported it, so the detail
 * card can show both solutions.
 *
 * A dropped connection is expected (laptops sleep, Wi-Fi moves) so the client
 * reconnects with a widening backoff and asks for a fresh snapshot each time,
 * which also repairs anything missed while it was away.
 */

/** How far back each window reaches, and the smallest magnitude the relay should send. */
const WINDOWS: Record<FeedId, { ms: number; minMag: number }> = {
  hour: { ms: 3_600_000, minMag: -Infinity },
  day: { ms: 86_400_000, minMag: -Infinity },
  week: { ms: 7 * 86_400_000, minMag: -Infinity },
  month: { ms: 30 * 86_400_000, minMag: 2.5 },
  year: { ms: 365 * 86_400_000, minMag: 4.5 },
};

interface RelayFeedOptions {
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Swappable in tests. */
  createSocket?: (url: string) => WebSocket;
}

export class RelayFeed implements QuakeFeed {
  readonly status: FeedStatus;

  private readonly socketUrl: string;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly snapshotListeners = new Set<(e: FeedSnapshotEvent) => void>();
  private readonly statusListeners = new Set<(s: FeedStatus) => void>();

  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private running = false;
  private loadedOnce = false;

  constructor(
    private readonly store: QuakeStore,
    url: string,
    options: RelayFeedOptions = {},
  ) {
    this.socketUrl = liveSocketUrl(url);
    this.baseBackoffMs = options.backoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 20_000;
    this.createSocket = options.createSocket ?? ((u) => new WebSocket(u));
    this.status = {
      feed: DEFAULT_FEED,
      mode: 'loading',
      transport: 'relay',
      generated: null,
      fetchedAt: null,
      nextRefreshAt: null, // a pushed stream has no next poll
      lastError: null,
    };
  }

  onSnapshot(listener: (e: FeedSnapshotEvent) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onStatus(listener: (s: FeedStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async start(feed: FeedId = this.status.feed): Promise<void> {
    // A different window, or a restart after a stop (coming back from a
    // replay): either way what is on screen is not this feed's any more.
    const changed = feed !== this.status.feed || !this.running;
    this.status.feed = feed;
    this.running = true;

    if (changed) {
      // A different question: clear and ask again.
      this.loadedOnce = false;
      this.store.clear();
      this.status.mode = 'loading';
      this.emitStatus();
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.subscribe();
    } else {
      this.connect();
    }
  }

  /** The relay pushes, so this just re-asks for the current window. */
  async refresh(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) this.subscribe();
    else this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.closeSocket();
  }

  dispose(): void {
    this.stop();
    this.snapshotListeners.clear();
    this.statusListeners.clear();
  }

  private connect(): void {
    if (!this.running) return;
    this.closeSocket();

    let socket: WebSocket;
    try {
      socket = this.createSocket(this.socketUrl);
    } catch (err) {
      this.fail(err);
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.status.lastError = null;
      this.subscribe();
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onclose = () => {
      if (this.status.relay) this.status.relay.connected = false;
      if (this.running) this.scheduleRetry('The relay connection dropped');
    };
    // `onclose` always follows `onerror`, and that is where the retry is scheduled.
    socket.onerror = () => {};
  }

  private subscribe(): void {
    const window = WINDOWS[this.status.feed];
    this.socket?.send(
      JSON.stringify({
        type: 'subscribe',
        from: Date.now() - window.ms,
        minMag: Number.isFinite(window.minMag) ? window.minMag : -1000,
      }),
    );
  }

  private handleMessage(raw: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const m = message as { type?: string; events?: Quake[]; status?: unknown; generated?: number };

    switch (m.type) {
      case 'hello':
        this.applyRelayStatus(m.status);
        break;

      case 'snapshot': {
        // A snapshot is the whole window, so it replaces what we hold.
        const initial = !this.loadedOnce;
        this.store.clear();
        const diff = this.store.applySnapshot(m.events ?? []);
        this.loadedOnce = true;
        this.status.mode = 'live';
        this.status.generated = m.generated ?? Date.now();
        this.status.fetchedAt = Date.now();
        this.emitSnapshot({ diff, initial });
        break;
      }

      case 'upsert': {
        // Incremental: merge in, never drop what is already on screen.
        const diff = this.store.merge(m.events ?? []);
        this.status.generated = Date.now();
        this.status.fetchedAt = Date.now();
        if (diff.added.length || diff.updated.length) this.emitSnapshot({ diff, initial: false });
        else this.emitStatus();
        break;
      }

      case 'status':
        this.applyRelayStatus(m.status);
        break;
    }
  }

  private applyRelayStatus(status: unknown): void {
    if (typeof status !== 'object' || status === null) return;
    const s = status as {
      sources?: RelayInfo['sources'];
      merged?: number;
      events?: number;
    };
    this.status.relay = {
      connected: true,
      sources: Array.isArray(s.sources) ? s.sources : [],
      merged: s.merged ?? 0,
      events: s.events ?? 0,
    };
    this.emitStatus();
  }

  private scheduleRetry(reason: string): void {
    if (!this.running || this.retryTimer) return;
    this.status.lastError = reason;
    const delay = Math.min(this.baseBackoffMs * 2 ** this.attempt, this.maxBackoffMs);
    this.attempt++;
    this.status.nextRefreshAt = Date.now() + delay;
    this.emitStatus();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.status.nextRefreshAt = null;
      this.connect();
    }, delay);
  }

  private fail(err: unknown): void {
    this.scheduleRetry(err instanceof Error ? err.message : String(err));
  }

  private closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }

  private emitSnapshot(event: FeedSnapshotEvent): void {
    for (const listener of this.snapshotListeners) listener(event);
    this.emitStatus();
  }

  private emitStatus(): void {
    for (const listener of this.statusListeners) listener(this.status);
  }
}

/** The label for a window, shared with the direct-USGS path. */
export const windowLabel = (feed: FeedId): string => USGS_FEEDS[feed].label;

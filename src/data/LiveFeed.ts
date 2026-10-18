import type { QuakeStore } from './QuakeStore.ts';
import { DEFAULT_FEED, USGS_FEEDS, fetchUsgsFeed, type FeedId, type FeedResult } from './usgs.ts';
import type { FeedMode, FeedSnapshotEvent, FeedStatus, QuakeFeed } from './feed.ts';

export type { FeedMode, FeedSnapshotEvent, FeedStatus } from './feed.ts';

export interface LiveFeedOptions {
  /** Overrides every feed's refresh interval (tests). Defaults to the per-feed value in USGS_FEEDS. */
  intervalMs?: number;
  timeoutMs?: number;
  /** Swappable for tests. */
  fetchFeed?: (feed: FeedId, signal: AbortSignal) => Promise<FeedResult>;
  /** Bundled snapshot shown when the live feed can't be reached at all. */
  loadSample?: (feed: FeedId) => Promise<FeedResult>;
}

/**
 * Polls a USGS summary feed and keeps the store in sync.
 *
 *  - Refreshes every 60 s (USGS regenerates the files about once a minute).
 *  - Pauses while the tab is hidden and catches up when it becomes visible.
 *  - Ignores responses that arrive after the user switched to another feed.
 *  - If the very first load fails, falls back to a bundled sample so the globe
 *    is never empty, and keeps retrying the live feed in the background.
 *
 * This is the no-server path: it is what the deployed demo uses, and what the
 * app falls back to when the relay in `server/` is not running.
 */
export class LiveFeed implements QuakeFeed {
  readonly status: FeedStatus;

  private readonly intervalOverride?: number;
  private readonly timeoutOverride?: number;
  private readonly fetchFeed: (feed: FeedId, signal: AbortSignal) => Promise<FeedResult>;
  private readonly loadSample?: (feed: FeedId) => Promise<FeedResult>;
  private readonly snapshotListeners = new Set<(e: FeedSnapshotEvent) => void>();
  private readonly statusListeners = new Set<(s: FeedStatus) => void>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private generation = 0; // bumps on every feed switch; stale responses are dropped
  private loadedOnce = false;
  private running = false;

  constructor(
    private readonly store: QuakeStore,
    options: LiveFeedOptions = {},
  ) {
    this.intervalOverride = options.intervalMs;
    this.timeoutOverride = options.timeoutMs;
    this.fetchFeed = options.fetchFeed ?? fetchUsgsFeed;
    this.loadSample = options.loadSample;
    this.status = {
      feed: DEFAULT_FEED,
      mode: 'loading',
      transport: 'usgs',
      generated: null,
      fetchedAt: null,
      nextRefreshAt: null,
      lastError: null,
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  onSnapshot(listener: (e: FeedSnapshotEvent) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onStatus(listener: (s: FeedStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Starts polling `feed` (or restarts on a different feed). */
  async start(feed: FeedId = this.status.feed): Promise<void> {
    // Coming back after a stop — from a replay, say — is a fresh start: what
    // is on screen is no longer this feed's, so the next snapshot is an
    // initial one and nothing in it counts as newly arrived.
    const afterStop = !this.running;
    this.running = true;
    if (feed !== this.status.feed || !this.loadedOnce || afterStop) {
      this.generation++;
      this.status.feed = feed;
      this.loadedOnce = false;
      this.store.clear();
      this.status.mode = 'loading';
      this.emitStatus();
    }
    await this.refresh();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.inFlight?.abort();
    this.status.nextRefreshAt = null;
    this.emitStatus();
  }

  private get intervalMs(): number {
    return this.intervalOverride ?? USGS_FEEDS[this.status.feed].refreshMs;
  }

  private get timeoutMs(): number {
    return this.timeoutOverride ?? USGS_FEEDS[this.status.feed].timeoutMs;
  }

  dispose(): void {
    this.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  /** Fetches now, then schedules the next poll. */
  async refresh(): Promise<void> {
    this.clearTimer();
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const generation = this.generation;

    try {
      const result = await this.fetchFeed(this.status.feed, controller.signal);
      if (generation !== this.generation) return; // user switched feeds meanwhile
      this.apply(result, 'live');
    } catch (err) {
      if (generation !== this.generation) return;
      const aborted = controller.signal.aborted;
      this.status.lastError = aborted ? 'The live feed timed out' : describeError(err);
      if (!this.loadedOnce) await this.tryLoadSample(generation);
      this.emitStatus();
    } finally {
      clearTimeout(timeout);
      if (this.inFlight === controller) this.inFlight = null;
      if (generation === this.generation) this.schedule();
    }
  }

  private apply(result: FeedResult, mode: FeedMode): void {
    const initial = !this.loadedOnce || this.status.mode !== mode;
    if (initial) this.store.clear();
    const diff = this.store.applySnapshot(result.quakes);
    this.loadedOnce = true;
    this.status.mode = mode;
    this.status.generated = result.generated;
    this.status.fetchedAt = Date.now();
    if (mode === 'live') this.status.lastError = null;
    for (const listener of this.snapshotListeners) listener({ diff, initial });
    this.emitStatus();
  }

  private async tryLoadSample(generation: number): Promise<void> {
    if (!this.loadSample) return;
    try {
      const sample = await this.loadSample(this.status.feed);
      if (generation === this.generation) this.apply(sample, 'sample');
    } catch (err) {
      console.warn('[feed] sample failed to load too:', err);
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.clearTimer();
    this.status.nextRefreshAt = Date.now() + this.intervalMs;
    this.timer = setTimeout(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        this.status.nextRefreshAt = null; // resume on visibilitychange
        return;
      }
      void this.refresh();
    }, this.intervalMs);
    this.emitStatus();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private readonly onVisibilityChange = () => {
    if (!this.running || document.hidden) return;
    const stale = this.status.fetchedAt === null || Date.now() - this.status.fetchedAt > this.intervalMs;
    if (stale && !this.inFlight) void this.refresh();
  };

  private emitStatus(): void {
    for (const listener of this.statusListeners) listener(this.status);
  }
}

function describeError(err: unknown): string {
  if (err instanceof TypeError) return 'Network error — the USGS feed could not be reached';
  return err instanceof Error ? err.message : String(err);
}

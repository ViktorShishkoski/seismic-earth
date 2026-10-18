import type { QuakeStore } from './QuakeStore.ts';
import type { FeedSnapshotEvent, FeedStatus, QuakeFeed } from './feed.ts';
import type { ReplayPreset } from './replay.ts';
import { fetchGeoJson, type FeedId, type FeedResult } from './usgs.ts';
import type { Quake } from './quake.ts';

export interface ReplayFeedOptions {
  /** Swappable for tests. */
  load?: (url: string) => Promise<FeedResult>;
  /** Which window the rest of the app should think it is looking at. */
  feedId?: FeedId;
}

/**
 * Replays a slice of the catalogue as though it were happening now.
 *
 * It pretends to be a live feed — same interface, same snapshot events — so
 * the markers, the toasts, the detail card and the wavefronts all behave
 * exactly as they do on the real stream. Only the clock is different, and the
 * clock is the whole point: run history at 45× and a day of aftershocks
 * becomes half a minute of watching a fault unzip.
 *
 * Events are kept sorted by time, which makes the visible set a contiguous
 * slice: everything between the trailing edge of the window and the cursor.
 * Advancing the clock moves two indices, never rescans the catalogue.
 */
export class ReplayFeed implements QuakeFeed {
  readonly status: FeedStatus;
  readonly preset: ReplayPreset;
  playing = true;
  speed: number;

  private readonly load: (url: string) => Promise<FeedResult>;
  private readonly snapshotListeners = new Set<(e: FeedSnapshotEvent) => void>();
  private readonly statusListeners = new Set<(s: FeedStatus) => void>();
  private events: Quake[] = [];
  private cursorMs: number;
  /** Index of the first event not yet reached, and of the oldest still shown. */
  private head = 0;
  private tail = 0;
  private loaded = false;
  private stopped = false;

  constructor(
    private readonly store: QuakeStore,
    preset: ReplayPreset,
    options: ReplayFeedOptions = {},
  ) {
    this.preset = preset;
    this.speed = preset.speed;
    this.cursorMs = preset.startMs;
    this.load = options.load ?? ((url) => fetchGeoJson(url));
    this.status = {
      feed: options.feedId ?? 'week',
      mode: 'loading',
      transport: 'usgs',
      generated: preset.startMs,
      fetchedAt: null,
      nextRefreshAt: null,
      lastError: null,
    };
  }

  /** Where the clock is now (ms since epoch) — the app's idea of "now". */
  get nowMs(): number {
    return this.cursorMs;
  }

  /** How far through the replay we are, 0…1. */
  get progress(): number {
    const span = this.preset.endMs - this.preset.startMs;
    return span <= 0 ? 1 : (this.cursorMs - this.preset.startMs) / span;
  }

  get finished(): boolean {
    return this.cursorMs >= this.preset.endMs;
  }

  async start(): Promise<void> {
    try {
      const result = await this.load(this.preset.url);
      if (this.stopped) return;
      // Only the span the replay can reach, oldest first.
      const from = this.preset.startMs - this.preset.trailingMs;
      this.events = result.quakes
        .filter((q) => q.time >= from && q.time <= this.preset.endMs)
        .sort((a, b) => a.time - b.time);
      this.loaded = true;
      this.status.mode = 'replay';
      this.status.fetchedAt = Date.now();
      this.status.lastError = null;
      this.seek(0);
      this.emitStatus();
    } catch (error) {
      this.status.mode = 'sample';
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.emitStatus();
      throw error;
    }
  }

  /**
   * Advances the clock by `dtSec` of real time. Called from the frame loop, so
   * the replay runs at the display's rate and pauses with the tab.
   */
  tick(dtSec: number): void {
    if (!this.loaded || !this.playing || this.finished) return;
    this.setCursor(this.cursorMs + dtSec * this.speed * 1000);
  }

  /** Jumps to a fraction of the way through. */
  seek(progress: number): void {
    const span = this.preset.endMs - this.preset.startMs;
    this.setCursor(this.preset.startMs + Math.min(Math.max(progress, 0), 1) * span, true);
  }

  /** Back to the beginning, playing again. */
  restart(): void {
    this.playing = true;
    this.seek(0);
  }

  private setCursor(ms: number, jumped = false): void {
    const next = Math.min(Math.max(ms, this.preset.startMs), this.preset.endMs);
    const backwards = next < this.cursorMs;
    this.cursorMs = next;
    this.status.generated = next;

    if (backwards) {
      // A scrub backwards invalidates both indices; find them again.
      this.head = 0;
      this.tail = 0;
    }
    const oldHead = this.head;
    const oldTail = this.tail;
    const trailingEdge = next - this.preset.trailingMs;
    while (this.head < this.events.length && this.events[this.head]!.time <= next) this.head++;
    while (this.tail < this.head && this.events[this.tail]!.time < trailingEdge) this.tail++;
    if (this.head === oldHead && this.tail === oldTail && !backwards) return;

    // Sorted by time, so what's on screen is one contiguous run.
    const diff = this.store.applySnapshot(this.events.slice(this.tail, this.head));
    const initial = jumped || backwards;
    for (const listener of this.snapshotListeners) listener({ diff, initial });
  }

  onSnapshot(listener: (event: FeedSnapshotEvent) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onStatus(listener: (status: FeedStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Nothing to refresh: the past is already in. */
  async refresh(): Promise<void> {
    this.restart();
  }

  stop(): void {
    this.playing = false;
  }

  dispose(): void {
    this.stopped = true;
    this.playing = false;
    this.snapshotListeners.clear();
    this.statusListeners.clear();
  }

  private emitStatus(): void {
    for (const listener of this.statusListeners) listener(this.status);
  }
}

import { MergeEngine } from './merge.ts';
import { EventStore } from './store.ts';
import { Hub } from './hub.ts';
import type { RelayStatus, SourceStatus } from './status.ts';
import type { MergedEvent, SourceEvent } from './types.ts';

/**
 * The relay itself: reports in, merged events out.
 *
 * Reports arrive from several sources at once — a WebSocket push, a poll, a
 * start-up backfill all landing together — so changes are collected and
 * flushed on a short timer instead of per event. A backfill of ten thousand
 * records becomes a handful of database transactions and one broadcast, not
 * ten thousand of each.
 */

export interface RelaySource {
  readonly status: SourceStatus;
  start(): Promise<void> | void;
  stop(): void;
}

export interface RelayOptions {
  /** How long to gather changes before writing and broadcasting them. */
  flushMs?: number;
  /** Events older than this are dropped from memory and storage. */
  retentionDays?: number;
  /** How often to prune. */
  pruneMs?: number;
  now?: () => number;
}

export class Relay {
  readonly merge: MergeEngine;
  readonly hub = new Hub();
  readonly startedAt: number;

  private readonly sources: RelaySource[] = [];
  private readonly pending = new Map<string, MergedEvent>();
  private readonly flushMs: number;
  private readonly retentionDays: number;
  private readonly pruneMs: number;
  private readonly now: () => number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  /** Last seen connectivity of each source, to notice the moment one changes. */
  private sourceHealth = '';
  /** Events that came from more than one network (for the health endpoint). */
  private mergedCount = 0;

  readonly store: EventStore;

  constructor(store: EventStore, options: RelayOptions = {}) {
    this.store = store;
    this.now = options.now ?? Date.now;
    this.flushMs = options.flushMs ?? 250;
    this.retentionDays = options.retentionDays ?? 90;
    this.pruneMs = options.pruneMs ?? 6 * 3600_000;
    this.startedAt = this.now();
    this.merge = new MergeEngine(this.now);
    // Carry on from what the last run stored.
    this.merge.load(this.store.query({ limit: 50_000 }));
    this.recountMerged();
  }

  addSource(source: RelaySource): void {
    this.sources.push(source);
  }

  async start(): Promise<void> {
    this.hub.startHeartbeat();
    this.pruneTimer = setInterval(() => this.prune(), this.pruneMs);
    this.pruneTimer.unref?.();
    // A network going down is news: tell the browsers at once rather than
    // leaving them to find out on the next periodic status broadcast.
    this.watchTimer = setInterval(() => this.watchSources(), 1_000);
    this.watchTimer.unref?.();
    // Sources start together: a slow backfill must not hold up a live stream.
    await Promise.allSettled(this.sources.map((s) => s.start()));
  }

  async stop(): Promise<void> {
    for (const source of this.sources) source.stop();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.pruneTimer = this.flushTimer = this.watchTimer = null;
    this.flush();
    this.hub.closeAll();
  }

  /** Feeds a batch of reports through the merge engine. */
  ingest(events: readonly SourceEvent[]): void {
    for (const event of events) {
      const { event: merged, change } = this.merge.ingest(event);
      if (change === 'unchanged') continue;
      if (change === 'merged' && merged.sources.length === 2) this.mergedCount++;
      this.pending.set(merged.id, merged);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.pending.size === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushMs);
    this.flushTimer.unref?.();
  }

  /** Writes everything that changed, then tells the browsers. */
  flush(): void {
    if (this.pending.size === 0) return;
    const events = [...this.pending.values()];
    this.pending.clear();
    this.store.saveAll(events);
    this.hub.broadcast(events);
  }

  private watchSources(): void {
    const health = this.sources.map((s) => `${s.status.name}:${s.status.connected}`).join('|');
    if (health === this.sourceHealth) return;
    this.sourceHealth = health;
    this.hub.broadcastStatus(this.status());
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionDays * 86_400_000;
    this.merge.evictBefore(cutoff);
    this.store.deleteBefore(cutoff);
    this.recountMerged();
  }

  private recountMerged(): void {
    this.mergedCount = this.merge.all().filter((e) => e.sources.length > 1).length;
  }

  status(): RelayStatus {
    const span = this.store.span();
    return {
      startedAt: this.startedAt,
      events: this.merge.size,
      stored: this.store.count,
      merged: this.mergedCount,
      clients: this.hub.size,
      sources: this.sources.map((s) => s.status),
      oldest: span.oldest,
      newest: span.newest,
    };
  }
}

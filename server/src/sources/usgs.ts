import { parseUsgsCollection } from '../normalize.ts';
import { newSourceStatus, type SourceStatus } from '../status.ts';
import type { SourceEvent } from '../types.ts';

/**
 * USGS has no push service, so the relay polls.
 *
 * The summary feeds are small static files regenerated about once a minute and
 * served from a CDN, so polling one every minute is cheap and is what they are
 * built for. One fetch brings back the whole window, which also carries
 * revisions: a magnitude a seismologist corrected an hour ago arrives as a
 * changed record in the next poll.
 *
 * History older than the feed window comes from the FDSN event service once,
 * at start-up.
 */

const SUMMARY = (path: string) => `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${path}.geojson`;
const FDSN = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

export interface UsgsSourceOptions {
  /** Which summary feed to poll. `all_day` catches new events and recent revisions. */
  feed?: string;
  pollMs?: number;
  timeoutMs?: number;
  /** How far back to backfill at start-up. */
  historyDays?: number;
  /** Backfilling a month of every tiny quake is pointless; this keeps it sane. */
  backfillMinMag?: number;
  /** Swappable in tests. */
  fetchFn?: typeof fetch;
  baseUrl?: string;
  fdsnUrl?: string;
}

export class UsgsSource {
  readonly status: SourceStatus = newSourceStatus('usgs', 'poll');

  private readonly feed: string;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly historyDays: number;
  private readonly backfillMinMag: number;
  private readonly fetchFn: typeof fetch;
  private readonly summaryUrl: string;
  private readonly fdsnUrl: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly onEvents: (events: SourceEvent[]) => void;

  constructor(onEvents: (events: SourceEvent[]) => void, options: UsgsSourceOptions = {}) {
    this.onEvents = onEvents;
    this.feed = options.feed ?? 'all_day';
    this.pollMs = options.pollMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.historyDays = options.historyDays ?? 30;
    this.backfillMinMag = options.backfillMinMag ?? 2.5;
    this.fetchFn = options.fetchFn ?? fetch;
    this.summaryUrl = options.baseUrl ?? SUMMARY(this.feed);
    this.fdsnUrl = options.fdsnUrl ?? FDSN;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.backfill();
    await this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status.connected = false;
  }

  /** Pulls the long history once, so the globe is not limited to the feed window. */
  async backfill(): Promise<number> {
    const start = new Date(Date.now() - this.historyDays * 86_400_000).toISOString().slice(0, 19);
    const url = `${this.fdsnUrl}?format=geojson&starttime=${start}&minmagnitude=${this.backfillMinMag}&orderby=time`;
    try {
      const events = await this.fetchEvents(url);
      this.onEvents(events);
      return events.length;
    } catch (err) {
      this.note(err);
      return 0;
    }
  }

  private async poll(): Promise<void> {
    try {
      const events = await this.fetchEvents(this.summaryUrl);
      this.status.connected = true;
      this.status.failures = 0;
      this.status.lastError = null;
      if (events.length > 0) this.status.lastEventAt = Date.now();
      this.onEvents(events);
    } catch (err) {
      this.note(err);
    } finally {
      this.schedule();
    }
  }

  private async fetchEvents(url: string): Promise<SourceEvent[]> {
    const response = await this.fetchFn(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { events, skipped } = parseUsgsCollection(await response.json());
    this.status.lastContactAt = Date.now();
    this.status.received += events.length;
    this.status.rejected += skipped;
    return events;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  private note(err: unknown): void {
    this.status.connected = false;
    this.status.failures++;
    this.status.lastError = err instanceof Error ? err.message : String(err);
  }
}

import type { Quake } from './quake.ts';

export interface StoreDiff {
  added: Quake[];
  /** Events whose magnitude, location or status was revised by the source. */
  updated: Quake[];
  /** Events that aged out of the feed's time window. */
  removed: Quake[];
}

export interface QuakeFilter {
  minMag: number;
  /** Quarry blasts and explosions show up in USGS feeds; hide them by default. */
  includeNonEarthquakes: boolean;
}

export const DEFAULT_FILTER: QuakeFilter = { minMag: -Infinity, includeNonEarthquakes: false };

/**
 * Holds the current set of events and works out what changed between two
 * snapshots of a feed. Each refresh of a USGS feed is a full snapshot, so
 * "new", "revised" and "expired" events are derived by comparing ids and
 * `updated` timestamps.
 */
export class QuakeStore {
  private readonly byId = new Map<string, Quake>();
  /** Bumps on every change so dependants (GPU buffer, lists) know to rebuild. */
  version = 0;

  get size(): number {
    return this.byId.size;
  }

  get(id: string): Quake | undefined {
    return this.byId.get(id);
  }

  all(): Quake[] {
    return [...this.byId.values()];
  }

  clear(): void {
    if (this.byId.size === 0) return;
    this.byId.clear();
    this.version++;
  }

  /** Replaces the contents with a fresh feed snapshot and reports the difference. */
  applySnapshot(quakes: readonly Quake[]): StoreDiff {
    const diff: StoreDiff = { added: [], updated: [], removed: [] };
    const seen = new Set<string>();

    for (const quake of quakes) {
      seen.add(quake.id);
      const existing = this.byId.get(quake.id);
      if (!existing) {
        diff.added.push(quake);
        this.byId.set(quake.id, quake);
      } else if (quake.updated > existing.updated) {
        diff.updated.push(quake);
        this.byId.set(quake.id, quake);
      }
    }

    for (const [id, quake] of this.byId) {
      if (!seen.has(id)) {
        diff.removed.push(quake);
        this.byId.delete(id);
      }
    }

    if (diff.added.length || diff.updated.length || diff.removed.length) this.version++;
    return diff;
  }

  /**
   * Folds in events that changed, leaving everything else alone.
   *
   * The relay pushes only what moved, so — unlike `applySnapshot` — an event
   * missing from this batch has not expired, it simply did not change.
   */
  merge(quakes: readonly Quake[]): StoreDiff {
    const diff: StoreDiff = { added: [], updated: [], removed: [] };
    for (const quake of quakes) {
      const existing = this.byId.get(quake.id);
      if (!existing) diff.added.push(quake);
      else if (quake.updated >= existing.updated) diff.updated.push(quake);
      else continue; // an older revision tells us nothing
      this.byId.set(quake.id, quake);
    }
    if (diff.added.length || diff.updated.length) this.version++;
    return diff;
  }

  /** Events that pass the filter, largest first (so small markers draw on top of big ones). */
  visible(filter: QuakeFilter): Quake[] {
    const out: Quake[] = [];
    for (const quake of this.byId.values()) {
      if (quake.mag < filter.minMag) continue;
      if (!filter.includeNonEarthquakes && quake.type !== 'earthquake') continue;
      out.push(quake);
    }
    return out.sort((a, b) => b.mag - a.mag || a.time - b.time);
  }

  /** The `count` strongest events that pass the filter. */
  strongest(filter: QuakeFilter, count: number): Quake[] {
    return this.visible(filter).slice(0, count);
  }
}

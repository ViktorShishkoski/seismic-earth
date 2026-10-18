import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Contribution, MergedEvent, SourceName } from './types.ts';

/**
 * Durable storage for the merged catalogue.
 *
 * SQLite in one file: the relay can restart without losing history, and the
 * browser can ask for any window without the public feeds being hit again.
 * Uses Node's built-in SQLite, so the relay has no native dependency to build.
 *
 * Every event is one row holding the preferred solution plus the raw
 * contributions as JSON, so nothing the networks said is thrown away.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  time          INTEGER NOT NULL,
  updated       INTEGER NOT NULL,
  lat           REAL    NOT NULL,
  lon           REAL    NOT NULL,
  depth_km      REAL    NOT NULL,
  mag           REAL    NOT NULL,
  mag_type      TEXT    NOT NULL,
  place         TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  tsunami       INTEGER NOT NULL,
  felt          INTEGER,
  alert         TEXT,
  sig           INTEGER NOT NULL,
  sources       TEXT    NOT NULL,
  preferred     TEXT    NOT NULL,
  mag_source    TEXT    NOT NULL,
  first_seen    INTEGER NOT NULL,
  last_changed  INTEGER NOT NULL
);
-- The two questions the API asks: "events in this window" and "the strongest of them".
CREATE INDEX IF NOT EXISTS events_by_time ON events (time DESC);
CREATE INDEX IF NOT EXISTS events_by_mag  ON events (mag DESC, time DESC);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface EventQuery {
  /** Inclusive lower bound on origin time (ms since epoch). */
  from?: number;
  /** Exclusive upper bound. */
  to?: number;
  minMag?: number;
  limit?: number;
}

interface Row {
  id: string;
  time: number;
  updated: number;
  lat: number;
  lon: number;
  depth_km: number;
  mag: number;
  mag_type: string;
  place: string;
  url: string;
  type: string;
  status: string;
  tsunami: number;
  felt: number | null;
  alert: string | null;
  sig: number;
  sources: string;
  preferred: string;
  mag_source: string;
  first_seen: number;
  last_changed: number;
}

export class EventStore {
  private readonly db: DatabaseSync;
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly setMetaStmt;
  private readonly getMetaStmt;

  /** `:memory:` keeps everything in RAM, which the tests use. */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL lets the API read while the ingest loop writes.
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);

    this.upsertStmt = this.db.prepare(`
      INSERT INTO events (id, time, updated, lat, lon, depth_km, mag, mag_type, place, url, type,
                          status, tsunami, felt, alert, sig, sources, preferred, mag_source,
                          first_seen, last_changed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        time = excluded.time, updated = excluded.updated, lat = excluded.lat, lon = excluded.lon,
        depth_km = excluded.depth_km, mag = excluded.mag, mag_type = excluded.mag_type,
        place = excluded.place, url = excluded.url, type = excluded.type, status = excluded.status,
        tsunami = excluded.tsunami, felt = excluded.felt, alert = excluded.alert, sig = excluded.sig,
        sources = excluded.sources, preferred = excluded.preferred, mag_source = excluded.mag_source,
        last_changed = excluded.last_changed
    `);
    this.getStmt = this.db.prepare('SELECT * FROM events WHERE id = ?');
    this.setMetaStmt = this.db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.getMetaStmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
  }

  close(): void {
    this.db.close();
  }

  get count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return row.n;
  }

  save(event: MergedEvent): void {
    this.upsertStmt.run(
      event.id,
      event.time,
      event.updated,
      event.lat,
      event.lon,
      event.depthKm,
      event.mag,
      event.magType,
      event.place,
      event.url,
      event.type,
      event.status,
      event.tsunami ? 1 : 0,
      event.felt,
      event.alert,
      event.sig,
      JSON.stringify(event.sources),
      event.preferredSource,
      event.magnitudeSource,
      event.firstSeen,
      event.lastChanged,
    );
  }

  /** One transaction for a whole backfill: thousands of rows in one commit. */
  saveAll(events: readonly MergedEvent[]): void {
    if (events.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const event of events) this.save(event);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get(id: string): MergedEvent | undefined {
    const row = this.getStmt.get(id) as Row | undefined;
    return row ? toEvent(row) : undefined;
  }

  query(q: EventQuery = {}): MergedEvent[] {
    const where: string[] = [];
    const params: Array<number> = [];
    if (q.from !== undefined) {
      where.push('time >= ?');
      params.push(q.from);
    }
    if (q.to !== undefined) {
      where.push('time < ?');
      params.push(q.to);
    }
    if (q.minMag !== undefined && Number.isFinite(q.minMag)) {
      where.push('mag >= ?');
      params.push(q.minMag);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(q.limit ?? 20_000, 50_000));
    const rows = this.db
      .prepare(`SELECT * FROM events ${clause} ORDER BY time DESC LIMIT ?`)
      .all(...params, limit) as unknown as Row[];
    return rows.map(toEvent);
  }

  /** Oldest and newest origin times held, for the health endpoint. */
  span(): { oldest: number | null; newest: number | null } {
    const row = this.db.prepare('SELECT MIN(time) AS oldest, MAX(time) AS newest FROM events').get() as {
      oldest: number | null;
      newest: number | null;
    };
    return row;
  }

  deleteBefore(cutoffMs: number): number {
    const before = this.count;
    this.db.prepare('DELETE FROM events WHERE time < ?').run(cutoffMs);
    return before - this.count;
  }

  setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.getMetaStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }
}

function toEvent(row: Row): MergedEvent {
  return {
    id: row.id,
    time: row.time,
    updated: row.updated,
    lat: row.lat,
    lon: row.lon,
    depthKm: row.depth_km,
    mag: row.mag,
    magType: row.mag_type,
    place: row.place,
    url: row.url,
    type: row.type,
    status: row.status,
    tsunami: row.tsunami === 1,
    felt: row.felt,
    alert: row.alert,
    sig: row.sig,
    sources: JSON.parse(row.sources) as Contribution[],
    preferredSource: row.preferred as SourceName,
    magnitudeSource: row.mag_source as SourceName,
    firstSeen: row.first_seen,
    lastChanged: row.last_changed,
  };
}

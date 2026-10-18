/** Relay settings, all overridable by environment variable. */
export interface RelayConfig {
  port: number;
  host: string;
  dbPath: string;
  /** Browser origins allowed to call the relay. `*` allows any. */
  allowedOrigins: string[];
  /** How far back to keep events. */
  retentionDays: number;
  /** How far back each source backfills at start-up. */
  historyDays: number;
  /** Smallest magnitude worth backfilling (live events are never filtered). */
  backfillMinMag: number;
  usgsPollMs: number;
  /** Set EMSC=off to run USGS-only (useful when the WebSocket is unreachable). */
  emscEnabled: boolean;
  usgsEnabled: boolean;
  /**
   * Where each network lives. Only worth setting to point at a mirror, or at a
   * stand-in while testing — the defaults are the real services.
   */
  usgsFeedUrl?: string;
  usgsFdsnUrl?: string;
  emscWsUrl?: string;
  emscFdsnUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    port: int(env.PORT, 8787),
    host: env.HOST ?? '127.0.0.1',
    dbPath: env.DB_PATH ?? 'server/data/seismic.db',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    retentionDays: int(env.RETENTION_DAYS, 90),
    historyDays: int(env.HISTORY_DAYS, 30),
    backfillMinMag: float(env.BACKFILL_MIN_MAG, 2.5),
    usgsPollMs: int(env.USGS_POLL_MS, 60_000),
    emscEnabled: flag(env.EMSC, true),
    usgsEnabled: flag(env.USGS, true),
    usgsFeedUrl: env.USGS_FEED_URL,
    usgsFdsnUrl: env.USGS_FDSN_URL,
    emscWsUrl: env.EMSC_WS_URL,
    emscFdsnUrl: env.EMSC_FDSN_URL,
  };
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isInteger(n) ? n : fallback;
}

function float(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) ? n : fallback;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !/^(0|false|off|no)$/i.test(value.trim());
}

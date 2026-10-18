import type { SourceName } from './types.ts';

/** What the relay reports about itself, for `/health` and the browser's status line. */
export interface SourceStatus {
  name: SourceName;
  /** How this source delivers: a pushed stream or a polled file. */
  mode: 'stream' | 'poll';
  connected: boolean;
  /** Last time anything arrived from it (ms since epoch), or null. */
  lastEventAt: number | null;
  /** Last successful fetch or message (ms since epoch), or null. */
  lastContactAt: number | null;
  /** Reports accepted since start. */
  received: number;
  /** Reports that failed to parse. */
  rejected: number;
  /** Consecutive failures; resets on success. */
  failures: number;
  lastError: string | null;
}

export interface RelayStatus {
  startedAt: number;
  /** Events held in memory. */
  events: number;
  /** Events in the database (all history). */
  stored: number;
  /** How many events came from more than one network. */
  merged: number;
  clients: number;
  sources: SourceStatus[];
  oldest: number | null;
  newest: number | null;
}

export function newSourceStatus(name: SourceName, mode: 'stream' | 'poll'): SourceStatus {
  return {
    name,
    mode,
    connected: false,
    lastEventAt: null,
    lastContactAt: null,
    received: 0,
    rejected: 0,
    failures: 0,
    lastError: null,
  };
}

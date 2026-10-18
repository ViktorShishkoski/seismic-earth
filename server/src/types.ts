import type { Quake } from '../../src/data/quake.ts';

/** The seismic networks the relay listens to. */
export type SourceName = 'usgs' | 'emsc';

export const SOURCE_NAMES: readonly SourceName[] = ['usgs', 'emsc'];

/**
 * One network's report of one earthquake.
 *
 * This is richer than the `Quake` the browser sees: it keeps the fields the
 * merge engine needs to judge which report is better (how many stations the
 * solution used, whether a seismologist reviewed it) and the ids other
 * agencies use for the same event.
 */
export interface SourceEvent {
  source: SourceName;
  /** Identifier within that network, e.g. "us7000abcd" or "20260216_0000042". */
  sourceId: string;
  /** Origin time, ms since the Unix epoch (UTC). */
  time: number;
  /** When the network last revised this solution. */
  updated: number;
  lat: number;
  lon: number;
  depthKm: number;
  mag: number;
  /** Magnitude scale: "mww", "mb", "ml"… Decides which magnitude the relay prefers. */
  magType: string;
  place: string;
  url: string;
  /** "earthquake", "quarry blast", "explosion"… */
  type: string;
  /** "reviewed" once a seismologist has checked it, otherwise "automatic". */
  status: string;
  tsunami: boolean;
  felt: number | null;
  alert: string | null;
  sig: number;
  /** Number of stations in the solution, when the feed reports it (a quality signal). */
  nst: number | null;
  /**
   * Ids this report says belong to the same event at other agencies. USGS lists
   * them in `ids`; EMSC names its contributing catalogue. A shared id is proof
   * two reports are the same quake, so the merge engine checks these first.
   */
  xrefs: string[];
}

/** What the relay keeps about each network's contribution to a merged event. */
export interface Contribution {
  source: SourceName;
  sourceId: string;
  time: number;
  updated: number;
  lat: number;
  lon: number;
  depthKm: number;
  mag: number;
  magType: string;
  status: string;
  nst: number | null;
  url: string;
  /** When the relay first saw this contribution (ms since epoch, relay clock). */
  receivedAt: number;
}

/**
 * One earthquake as the relay understands it: the preferred solution (the
 * `Quake` the browser renders) plus every network report behind it.
 */
export interface MergedEvent extends Quake {
  /** Stable id, assigned from the first report and never changed. */
  id: string;
  sources: Contribution[];
  /** Which network's solution the preferred position and time came from. */
  preferredSource: SourceName;
  /** Which network's solution the preferred magnitude came from. */
  magnitudeSource: SourceName;
  /** When the relay first learned of this event. */
  firstSeen: number;
  /** When any preferred value last changed. */
  lastChanged: number;
}

/** What `ingest` did with one incoming report. */
export type IngestChange = 'created' | 'merged' | 'updated' | 'unchanged';

export interface IngestResult {
  event: MergedEvent;
  change: IngestChange;
}

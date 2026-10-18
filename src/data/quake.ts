/**
 * The app's own earthquake record. Every data source (USGS today, EMSC from
 * Phase 4) is normalised into this shape, so the renderer and UI never see
 * a source-specific format.
 */
export interface Quake {
  /** Stable event id from the source network, e.g. "us7000abcd". */
  id: string;
  /** Origin time, ms since the Unix epoch (UTC). */
  time: number;
  /** Last time the source revised this event, ms since epoch. */
  updated: number;
  lat: number;
  lon: number;
  /** Kilometres below sea level. Can be slightly negative (above sea level) for shallow events. */
  depthKm: number;
  mag: number;
  /** Magnitude scale, e.g. "mww", "mb", "ml". */
  magType: string;
  place: string;
  /** Human event page at the source. */
  url: string;
  /** "earthquake", "quarry blast", "explosion", "ice quake", … */
  type: string;
  /** "automatic" until a seismologist reviews it, then "reviewed". */
  status: string;
  tsunami: boolean;
  /** Number of "Did you feel it?" reports, if any. */
  felt: number | null;
  /** PAGER alert level: green, yellow, orange, red — or null. */
  alert: string | null;
  /** USGS significance score (0–1000+), combines magnitude, felt reports and impact. */
  sig: number;
  /**
   * Every network that reported this earthquake. Only set when the data came
   * through the relay, which merges EMSC and USGS; the browser's own USGS
   * polling has nothing to merge, so it leaves this out.
   */
  sources?: QuakeContribution[];
  /** Which network's solution the position and depth above came from. */
  preferredSource?: string;
  /** Which network's solution the magnitude came from. */
  magnitudeSource?: string;
}

/** One network's own solution for an earthquake, as recorded by the relay. */
export interface QuakeContribution {
  source: string;
  sourceId: string;
  time: number;
  lat: number;
  lon: number;
  depthKm: number;
  mag: number;
  magType: string;
  status: string;
  /** Stations in that network's solution, when it says. */
  nst: number | null;
  url: string;
}

export type DepthClass = 'shallow' | 'intermediate' | 'deep';

/** Standard seismological depth classes. */
export function depthClass(depthKm: number): DepthClass {
  if (depthKm < 70) return 'shallow';
  if (depthKm < 300) return 'intermediate';
  return 'deep';
}

/**
 * Seismic energy relative to a magnitude-`ref` event.
 * Each whole magnitude step releases about 10^1.5 ≈ 31.6 times more energy.
 */
export function energyRatio(mag: number, ref = 0): number {
  return Math.pow(10, 1.5 * (mag - ref));
}

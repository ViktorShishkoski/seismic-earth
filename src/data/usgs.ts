import type { Quake } from './quake.ts';

/**
 * USGS real-time GeoJSON summary feeds.
 * Docs: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
 * No API key; CORS-enabled; regenerated about once a minute.
 */
export const USGS_FEEDS = {
  hour: { label: 'Past hour', path: 'all_hour', refreshMs: 60_000, timeoutMs: 15_000 },
  day: { label: 'Past day', path: 'all_day', refreshMs: 60_000, timeoutMs: 15_000 },
  week: { label: 'Past 7 days', path: 'all_week', refreshMs: 60_000, timeoutMs: 20_000 },
  month: { label: 'Past 30 days (M2.5+)', path: '2.5_month', refreshMs: 60_000, timeoutMs: 20_000 },
  // Not a summary feed: a query to the FDSN event service (~7,000 events, a few MB),
  // so it refreshes less often. The best window for seeing slabs in cutaway.
  year: { label: 'Past year (M4.5+)', path: null, refreshMs: 10 * 60_000, timeoutMs: 60_000 },
} as const;

export type FeedId = keyof typeof USGS_FEEDS;

export const DEFAULT_FEED: FeedId = 'week';

const YEAR_MS = 365 * 24 * 3600 * 1000;

export function feedUrl(feed: FeedId, nowMs = Date.now()): string {
  const path = USGS_FEEDS[feed].path;
  if (path) return `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${path}.geojson`;
  // Round the start time to the hour so repeated requests can be cached by the CDN.
  const start = new Date(Math.floor((nowMs - YEAR_MS) / 3_600_000) * 3_600_000).toISOString().slice(0, 19);
  return `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minmagnitude=4.5&orderby=time`;
}

export interface FeedResult {
  quakes: Quake[];
  /** When USGS generated this file (ms since epoch). */
  generated: number;
  title: string;
  /** Features that were dropped because they were malformed (no position, no magnitude…). */
  skipped: number;
}

/**
 * Parses a USGS GeoJSON FeatureCollection defensively: the feed is external
 * input, so every field is checked rather than trusted. Bad features are
 * counted and skipped instead of breaking the whole load.
 */
export function parseUsgsFeed(json: unknown): FeedResult {
  if (!isObject(json) || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
    throw new Error('Not a GeoJSON FeatureCollection');
  }

  const metadata = isObject(json.metadata) ? json.metadata : {};
  const quakes: Quake[] = [];
  let skipped = 0;

  for (const feature of json.features) {
    const quake = parseFeature(feature);
    if (quake) quakes.push(quake);
    else skipped++;
  }

  return {
    quakes,
    generated: num(metadata.generated) ?? Date.now(),
    title: str(metadata.title) ?? 'USGS earthquakes',
    skipped,
  };
}

function parseFeature(feature: unknown): Quake | null {
  if (!isObject(feature) || !isObject(feature.properties) || !isObject(feature.geometry)) return null;
  const p = feature.properties;
  const coords = feature.geometry.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  // GeoJSON order is [longitude, latitude, depth] — the classic lat/lon swap bug lives here.
  const lon = num(coords[0]);
  const lat = num(coords[1]);
  const depthKm = num(coords[2]) ?? 0;
  const mag = num(p.mag);
  const time = num(p.time);
  const id = str(feature.id) ?? str(p.code);

  if (lon === null || lat === null || mag === null || time === null || !id) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  return {
    id,
    time,
    updated: num(p.updated) ?? time,
    lat,
    lon,
    depthKm,
    mag,
    magType: str(p.magType) ?? '',
    place: str(p.place) ?? str(p.title) ?? 'Unknown location',
    url: str(p.url) ?? `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
    type: str(p.type) ?? 'earthquake',
    status: str(p.status) ?? 'automatic',
    tsunami: num(p.tsunami) === 1,
    felt: num(p.felt),
    alert: str(p.alert),
    sig: num(p.sig) ?? 0,
  };
}

/** Downloads and parses one feed. Throws on network, HTTP or format errors. */
export async function fetchUsgsFeed(feed: FeedId, signal?: AbortSignal): Promise<FeedResult> {
  return fetchGeoJson(feedUrl(feed), signal);
}

export async function fetchGeoJson(url: string, signal?: AbortSignal): Promise<FeedResult> {
  const response = await fetch(url, { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url, location.href).host}`);
  return parseUsgsFeed(await response.json());
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

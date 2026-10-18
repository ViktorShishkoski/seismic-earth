import type { SourceEvent } from './types.ts';

/**
 * Turns raw feed payloads into `SourceEvent`s.
 *
 * Both networks publish GeoJSON, but they disagree on almost every detail:
 * where the depth lives, whether time is epoch milliseconds or an ISO string,
 * what the place field is called. Everything here is checked rather than
 * trusted — these are external feeds, and one malformed record must never
 * take the relay down.
 *
 * (The browser has its own, smaller USGS parser in `src/data/usgs.ts`: it
 * builds the display model. This one keeps the extra fields the merge engine
 * needs, so the two have different jobs over the same bytes.)
 */

export interface ParseReport<T> {
  events: T[];
  /** Records that were dropped because a required field was missing or absurd. */
  skipped: number;
}

// ── USGS ────────────────────────────────────────────────────────────────────

/** Parses a USGS GeoJSON FeatureCollection (summary feed or FDSN query). */
export function parseUsgsCollection(json: unknown): ParseReport<SourceEvent> {
  const features = featureList(json);
  const events: SourceEvent[] = [];
  let skipped = 0;
  for (const feature of features) {
    const event = usgsFeature(feature);
    if (event) events.push(event);
    else skipped++;
  }
  return { events, skipped };
}

export function usgsFeature(feature: unknown): SourceEvent | null {
  if (!isObject(feature) || !isObject(feature.properties)) return null;
  const p = feature.properties;
  const coords = isObject(feature.geometry) ? feature.geometry.coordinates : null;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  // GeoJSON order is [longitude, latitude, depth] — the classic lat/lon swap bug lives here.
  const lon = num(coords[0]);
  const lat = num(coords[1]);
  const time = epochMs(p.time);
  const mag = num(p.mag);
  const sourceId = str(feature.id) ?? str(p.code);
  if (lon === null || lat === null || time === null || mag === null || !sourceId) return null;
  if (!validPosition(lat, lon)) return null;

  return {
    source: 'usgs',
    sourceId,
    time,
    updated: epochMs(p.updated) ?? time,
    lat,
    lon,
    depthKm: num(coords[2]) ?? 0,
    mag,
    magType: (str(p.magType) ?? '').toLowerCase(),
    place: str(p.place) ?? str(p.title) ?? 'Unknown location',
    url: str(p.url) ?? `https://earthquake.usgs.gov/earthquakes/eventpage/${sourceId}`,
    type: str(p.type) ?? 'earthquake',
    status: (str(p.status) ?? 'automatic').toLowerCase(),
    tsunami: num(p.tsunami) === 1,
    felt: num(p.felt),
    alert: str(p.alert),
    sig: num(p.sig) ?? 0,
    nst: num(p.nst),
    // USGS publishes every id it knows for the event as ",id1,id2,".
    xrefs: splitIds(str(p.ids)).filter((id) => id !== sourceId),
  };
}

// ── EMSC ────────────────────────────────────────────────────────────────────

/**
 * Parses one message from the EMSC real-time WebSocket.
 * Documented shape: `{ action: "create" | "update", data: <GeoJSON Feature> }`.
 * Some clients receive the bare Feature, so both are accepted.
 */
export function parseEmscMessage(json: unknown): { event: SourceEvent; action: string } | null {
  if (!isObject(json)) return null;
  const action = (str(json.action) ?? 'create').toLowerCase();
  const payload = isObject(json.data) ? json.data : json;
  const event = emscFeature(payload);
  return event ? { event, action } : null;
}

/** Parses an EMSC FDSN GeoJSON FeatureCollection (used to backfill on start). */
export function parseEmscCollection(json: unknown): ParseReport<SourceEvent> {
  const features = featureList(json);
  const events: SourceEvent[] = [];
  let skipped = 0;
  for (const feature of features) {
    const event = emscFeature(feature);
    if (event) events.push(event);
    else skipped++;
  }
  return { events, skipped };
}

export function emscFeature(feature: unknown): SourceEvent | null {
  if (!isObject(feature)) return null;
  const p = isObject(feature.properties) ? feature.properties : feature;
  const coords = isObject(feature.geometry) ? feature.geometry.coordinates : null;
  const hasCoords = Array.isArray(coords) && coords.length >= 2;

  // EMSC repeats the position in `properties`; the geometry is the fallback.
  const lat = num(p.lat) ?? (hasCoords ? num(coords[1]) : null);
  const lon = num(p.lon) ?? (hasCoords ? num(coords[0]) : null);
  // `properties.depth` is depth in km (positive down); geometry's third value
  // is an elevation (negative down), so it has to be flipped.
  const depth = num(p.depth) ?? (hasCoords && coords.length > 2 ? negate(num(coords[2])) : 0);
  const time = epochMs(p.time);
  const mag = num(p.mag);
  const sourceId = str(p.unid) ?? str(feature.id) ?? str(p.source_id);
  if (lat === null || lon === null || time === null || mag === null || !sourceId) return null;
  if (!validPosition(lat, lon)) return null;

  const sourceCatalog = str(p.source_catalog);
  const foreignId = str(p.source_id);
  return {
    source: 'emsc',
    sourceId,
    time,
    updated: epochMs(p.lastupdate) ?? time,
    lat,
    lon,
    depthKm: depth ?? 0,
    mag,
    magType: (str(p.magtype) ?? '').toLowerCase(),
    // EMSC names a Flynn-Engdahl seismic region rather than a nearby town.
    place: str(p.flynn_region) ?? str(p.region) ?? 'Unknown region',
    url: `https://www.emsc-csem.org/Earthquake_information/earthquake.php?id=${sourceId}`,
    type: emscType(str(p.evtype)),
    // EMSC marks reviewed solutions with auth "EMSC"; automatic ones come from EMSC-RTS.
    status: sourceCatalog && /rts/i.test(sourceCatalog) ? 'automatic' : 'reviewed',
    tsunami: false,
    felt: null,
    alert: null,
    sig: 0,
    nst: num(p.nbstations) ?? num(p.nst),
    // The contributing agency's own id for the event, when EMSC relays one.
    xrefs: foreignId && foreignId !== sourceId ? [foreignId] : [],
  };
}

/** EMSC event types: "ke"/"se" are quakes, "sm"/"km" mining, "kx"/"sx" explosions. */
function emscType(evtype: string | null): string {
  if (!evtype) return 'earthquake';
  const t = evtype.toLowerCase();
  if (t.endsWith('m')) return 'mining explosion';
  if (t.endsWith('x') || t.endsWith('n')) return 'explosion';
  return 'earthquake';
}

// ── helpers ─────────────────────────────────────────────────────────────────

function featureList(json: unknown): unknown[] {
  if (!isObject(json)) throw new Error('Not a GeoJSON object');
  if (!Array.isArray(json.features)) throw new Error('Not a GeoJSON FeatureCollection');
  return json.features;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // EMSC sends some numbers as strings.
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function negate(v: number | null): number | null {
  return v === null ? null : -v;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** USGS sends epoch milliseconds; EMSC sends ISO 8601 strings. */
function epochMs(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n;
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function splitIds(ids: string | null): string[] {
  return ids ? ids.split(',').filter((id) => id.length > 0) : [];
}

function validPosition(lat: number, lon: number): boolean {
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

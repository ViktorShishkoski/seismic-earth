import { greatCircleKm } from '../../src/geo/coords.ts';
import type { Contribution, IngestResult, MergedEvent, SourceEvent, SourceName } from './types.ts';

/**
 * Merging two seismic networks into one catalogue.
 *
 * The same earthquake is detected independently by USGS and EMSC, usually
 * within a minute of each other, and the two solutions never agree exactly:
 * origin times differ by seconds, epicentres by tens of kilometres, and
 * magnitudes by a few tenths because the networks use different scales. If
 * the relay simply forwarded both, every quake would draw twice.
 *
 * So each incoming report is matched against what the relay already knows:
 *
 *   1. **By identifier.** USGS publishes every id it knows for an event
 *      (`ids`), and EMSC names the agency it relayed. A shared id is proof,
 *      so it wins outright.
 *   2. **By space and time.** Otherwise the report must land inside an
 *      ellipsoid around a known event — close enough in time, distance *and*
 *      magnitude at once. Among the events that qualify, the nearest wins.
 *
 * A matched report becomes another *contribution* to the same event, and the
 * preferred solution is recomputed from all of them (see `preferredSolution`).
 */

/** Half-axes of the match ellipsoid: a report must satisfy all three at once. */
export const MATCH = {
  /** Origin times of independent solutions for one quake rarely differ by more. */
  timeSec: 45,
  /** Epicentres can sit this far apart for a remote event recorded by few stations. */
  distanceKm: 350,
  /** Networks use different magnitude scales, so a fair gap is expected. */
  magnitude: 1.5,
} as const;

/**
 * How much the relay trusts each network's hypocentre when nothing else
 * separates two solutions. USGS runs the global ANSS catalogue, which is the
 * usual reference; EMSC is often quicker and better inside Europe.
 */
const SOURCE_PRIORITY: Record<SourceName, number> = { usgs: 2, emsc: 1 };

/**
 * Magnitude scales, best first.
 *
 * Moment magnitude (mw…) measures the energy actually released and does not
 * saturate for large earthquakes, so it is the modern standard and what USGS
 * itself prefers above about M 4.5. The older body- and surface-wave scales
 * come next, and local/duration scales — fine for small nearby quakes but
 * unreliable for big distant ones — come last.
 */
const MAG_TYPE_RANK: Array<{ test: RegExp; rank: number }> = [
  { test: /^mw/, rank: 4 }, // mww, mwc, mwb, mwr, mw
  { test: /^(ms|mb)/, rank: 3 }, // surface wave, body wave
  { test: /^(ml|mlg|mwg)/, rank: 2 }, // local
  { test: /^(md|mfa|mh|me|mint)/, rank: 1 }, // duration, felt, energy
];

export function magTypeRank(magType: string): number {
  const t = magType.toLowerCase();
  for (const { test, rank } of MAG_TYPE_RANK) if (test.test(t)) return rank;
  return 0;
}

function isReviewed(status: string): boolean {
  return status.toLowerCase() === 'reviewed';
}

/**
 * How well two reports match, as a distance in the match ellipsoid.
 * Below 1 the reports are the same earthquake; 0 would be an exact match.
 * Returns Infinity when any single difference already breaks a half-axis.
 */
export function matchScore(a: SourceEvent | Contribution, b: SourceEvent | Contribution): number {
  const dt = Math.abs(a.time - b.time) / 1000;
  if (dt > MATCH.timeSec) return Infinity;
  const dm = Math.abs(a.mag - b.mag);
  if (dm > MATCH.magnitude) return Infinity;
  const km = greatCircleKm(a.lat, a.lon, b.lat, b.lon);
  if (km > MATCH.distanceKm) return Infinity;
  return Math.hypot(dt / MATCH.timeSec, km / MATCH.distanceKm, dm / MATCH.magnitude);
}

/**
 * Builds the solution the browser sees from every contribution.
 *
 * Position, depth and origin time come from one network's solution — mixing
 * a latitude from one agency with a depth from another would invent a
 * hypocentre nobody computed. The magnitude is chosen separately, because the
 * best-located solution is not always the one with the best magnitude scale.
 */
export function preferredSolution(contributions: readonly Contribution[]): {
  hypocentre: Contribution;
  magnitude: Contribution;
} {
  const hypocentre = [...contributions].sort(compareHypocentre)[0]!;
  const magnitude = [...contributions].sort(compareMagnitude)[0]!;
  return { hypocentre, magnitude };
}

/** Best hypocentre first: reviewed, then more stations, then network, then newest. */
function compareHypocentre(a: Contribution, b: Contribution): number {
  const reviewed = Number(isReviewed(b.status)) - Number(isReviewed(a.status));
  if (reviewed !== 0) return reviewed;
  // Only trust the station count when both report it and the gap is real (>20%).
  if (a.nst !== null && b.nst !== null) {
    const bigger = Math.max(a.nst, b.nst);
    if (bigger > 0 && Math.abs(a.nst - b.nst) / bigger > 0.2) return b.nst - a.nst;
  }
  const priority = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
  if (priority !== 0) return priority;
  return b.updated - a.updated;
}

/** Best magnitude first: better scale, then reviewed, then newest. */
function compareMagnitude(a: Contribution, b: Contribution): number {
  const rank = magTypeRank(b.magType) - magTypeRank(a.magType);
  if (rank !== 0) return rank;
  const reviewed = Number(isReviewed(b.status)) - Number(isReviewed(a.status));
  if (reviewed !== 0) return reviewed;
  const priority = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
  if (priority !== 0) return priority;
  return b.updated - a.updated;
}

function toContribution(e: SourceEvent, receivedAt: number): Contribution {
  return {
    source: e.source,
    sourceId: e.sourceId,
    time: e.time,
    updated: e.updated,
    lat: e.lat,
    lon: e.lon,
    depthKm: e.depthKm,
    mag: e.mag,
    magType: e.magType,
    status: e.status,
    nst: e.nst,
    url: e.url,
    receivedAt,
  };
}

const BUCKET_MS = 60_000;

/**
 * Keeps the merged catalogue in memory and decides what each new report means.
 *
 * Candidate lookup is bucketed by minute, so matching one report costs a few
 * comparisons rather than a scan of the whole catalogue.
 */
export class MergeEngine {
  private readonly events = new Map<string, MergedEvent>();
  /** "usgs:us7000abcd" → merged id, for reports the relay has already seen. */
  private readonly bySourceId = new Map<string, string>();
  /** Any agency id mentioned by any report → merged id. */
  private readonly byXref = new Map<string, string>();
  /** Minute bucket → merged ids starting in it. */
  private readonly buckets = new Map<number, Set<string>>();
  /** The fields each merged event was last published with, to spot real changes. */
  private readonly fingerprints = new Map<string, string>();

  private readonly now: () => number;

  // Written out rather than as a parameter property: Node runs this file by
  // stripping the types, and that shorthand has no runtime equivalent to strip to.
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get size(): number {
    return this.events.size;
  }

  all(): MergedEvent[] {
    return [...this.events.values()];
  }

  get(id: string): MergedEvent | undefined {
    return this.events.get(id);
  }

  /** Loads merged events from storage on start-up (rebuilding the indexes). */
  load(events: Iterable<MergedEvent>): void {
    for (const event of events) {
      this.events.set(event.id, event);
      this.index(event);
      this.fingerprints.set(event.id, fingerprint(event));
    }
  }

  /** Folds one network's report into the catalogue. */
  ingest(incoming: SourceEvent): IngestResult {
    const receivedAt = this.now();
    const key = `${incoming.source}:${incoming.sourceId}`;
    const existingId = this.bySourceId.get(key) ?? this.findByXref(incoming);
    const existing = existingId ? this.events.get(existingId) : undefined;

    if (existing) {
      const known = existing.sources.find(
        (c) => c.source === incoming.source && c.sourceId === incoming.sourceId,
      );
      const contribution = toContribution(incoming, known?.receivedAt ?? receivedAt);
      // A revision that is not actually newer tells us nothing.
      if (known && incoming.updated <= known.updated && sameSolution(known, contribution)) {
        return { event: existing, change: 'unchanged' };
      }
      const sources = existing.sources.filter(
        (c) => !(c.source === incoming.source && c.sourceId === incoming.sourceId),
      );
      sources.push(contribution);
      const updated = this.rebuild(existing, sources, incoming, receivedAt);
      return { event: updated, change: known ? 'updated' : 'merged' };
    }

    const match = this.findBySpaceTime(incoming);
    if (match) {
      const sources = [...match.sources, toContribution(incoming, receivedAt)];
      const updated = this.rebuild(match, sources, incoming, receivedAt);
      return { event: updated, change: 'merged' };
    }

    return { event: this.create(incoming, receivedAt), change: 'created' };
  }

  /** Drops events older than `cutoffMs` from memory (storage keeps them). */
  evictBefore(cutoffMs: number): number {
    let removed = 0;
    for (const event of [...this.events.values()]) {
      if (event.time >= cutoffMs) continue;
      this.events.delete(event.id);
      this.fingerprints.delete(event.id);
      this.buckets.get(bucketOf(event.time))?.delete(event.id);
      for (const c of event.sources) this.bySourceId.delete(`${c.source}:${c.sourceId}`);
      for (const [xref, id] of this.byXref) if (id === event.id) this.byXref.delete(xref);
      removed++;
    }
    return removed;
  }

  private findByXref(incoming: SourceEvent): string | undefined {
    // Either this report names an id we know, or a known report named this one.
    for (const xref of incoming.xrefs) {
      const id = this.byXref.get(xref) ?? this.bySourceId.get(`usgs:${xref}`) ?? this.bySourceId.get(`emsc:${xref}`);
      if (id) return id;
    }
    return this.byXref.get(incoming.sourceId);
  }

  private findBySpaceTime(incoming: SourceEvent): MergedEvent | undefined {
    const span = Math.ceil((MATCH.timeSec * 1000) / BUCKET_MS);
    const centre = bucketOf(incoming.time);
    let best: MergedEvent | undefined;
    let bestScore = 1;

    for (let b = centre - span; b <= centre + span; b++) {
      for (const id of this.buckets.get(b) ?? []) {
        const candidate = this.events.get(id);
        if (!candidate) continue;
        // Two reports from the same network are different events by definition:
        // a network does not publish one quake twice under two ids.
        if (candidate.sources.some((c) => c.source === incoming.source && c.sourceId !== incoming.sourceId)) {
          if (candidate.sources.every((c) => c.source === incoming.source)) continue;
        }
        for (const contribution of candidate.sources) {
          if (contribution.source === incoming.source) continue;
          const score = matchScore(incoming, contribution);
          if (score < bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
      }
    }
    return best;
  }

  private create(incoming: SourceEvent, receivedAt: number): MergedEvent {
    const contribution = toContribution(incoming, receivedAt);
    const event: MergedEvent = {
      ...solutionFields([contribution], incoming),
      id: `${incoming.source}:${incoming.sourceId}`,
      sources: [contribution],
      preferredSource: incoming.source,
      magnitudeSource: incoming.source,
      firstSeen: receivedAt,
      lastChanged: receivedAt,
    };
    this.events.set(event.id, event);
    this.index(event, incoming);
    this.fingerprints.set(event.id, fingerprint(event));
    return event;
  }

  /** Recomputes the preferred solution after the contributions changed. */
  private rebuild(
    existing: MergedEvent,
    sources: Contribution[],
    incoming: SourceEvent,
    receivedAt: number,
  ): MergedEvent {
    const oldBucket = bucketOf(existing.time);
    const merged: MergedEvent = {
      ...existing,
      ...solutionFields(sources, incoming, existing),
      id: existing.id, // the id is assigned once and never moves
      sources,
      firstSeen: existing.firstSeen,
      lastChanged: existing.lastChanged,
    };
    const print = fingerprint(merged);
    if (print !== this.fingerprints.get(existing.id)) {
      merged.lastChanged = receivedAt;
      this.fingerprints.set(existing.id, print);
    }

    this.events.set(merged.id, merged);
    if (bucketOf(merged.time) !== oldBucket) {
      this.buckets.get(oldBucket)?.delete(merged.id);
    }
    this.index(merged, incoming);
    return merged;
  }

  private index(event: MergedEvent, incoming?: SourceEvent): void {
    bucket(this.buckets, bucketOf(event.time)).add(event.id);
    for (const c of event.sources) {
      this.bySourceId.set(`${c.source}:${c.sourceId}`, event.id);
      this.byXref.set(c.sourceId, event.id);
    }
    for (const xref of incoming?.xrefs ?? []) this.byXref.set(xref, event.id);
  }
}

/**
 * The display fields, chosen across contributions. `latest` is the report that
 * just arrived; `previous` carries forward facts (felt reports, a tsunami
 * evaluation) that only one network publishes and that never un-happen.
 */
function solutionFields(
  sources: readonly Contribution[],
  latest: SourceEvent,
  previous?: MergedEvent,
) {
  const { hypocentre, magnitude } = preferredSolution(sources);
  const fromLatest = (c: Contribution) => c.source === latest.source && c.sourceId === latest.sourceId;

  // USGS names the nearest town ("22km NNE of Hualian, Taiwan"); EMSC names a
  // broad seismic region. The more specific description wins.
  const usgsPlace = latest.source === 'usgs' ? latest.place : previous?.place;
  const place = latest.source === 'usgs' || !previous ? latest.place : (usgsPlace ?? latest.place);

  return {
    time: hypocentre.time,
    updated: Math.max(...sources.map((c) => c.updated)),
    lat: hypocentre.lat,
    lon: hypocentre.lon,
    depthKm: hypocentre.depthKm,
    mag: magnitude.mag,
    magType: magnitude.magType,
    place,
    url: fromLatest(hypocentre) ? latest.url : hypocentre.url,
    type: latest.type,
    status: sources.some((c) => isReviewed(c.status)) ? 'reviewed' : 'automatic',
    // Impact facts: whichever network knows the most.
    tsunami: (previous?.tsunami ?? false) || latest.tsunami,
    felt: maxOrNull(previous?.felt ?? null, latest.felt),
    alert: latest.alert ?? previous?.alert ?? null,
    sig: Math.max(previous?.sig ?? 0, latest.sig),
    preferredSource: hypocentre.source,
    magnitudeSource: magnitude.source,
  };
}

/** The values the browser draws: a change in any of them is worth pushing. */
function fingerprint(e: MergedEvent): string {
  return [e.time, e.lat, e.lon, e.depthKm, e.mag, e.magType, e.status, e.place, e.sources.length].join('|');
}

function sameSolution(a: Contribution, b: Contribution): boolean {
  return a.time === b.time && a.lat === b.lat && a.lon === b.lon && a.depthKm === b.depthKm && a.mag === b.mag;
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function bucketOf(timeMs: number): number {
  return Math.floor(timeMs / BUCKET_MS);
}

function bucket(map: Map<number, Set<string>>, key: number): Set<string> {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  return set;
}

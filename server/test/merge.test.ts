import { describe, expect, it } from 'vitest';
import { MATCH, MergeEngine, magTypeRank, matchScore, preferredSolution } from '../src/merge.ts';
import { parseUsgsCollection } from '../src/normalize.ts';
import type { SourceEvent } from '../src/types.ts';
import nepalWeek from './fixtures/usgs-2015-nepal-week.json';

/** A USGS report, with sensible defaults for everything the test doesn't care about. */
function usgs(over: Partial<SourceEvent> = {}): SourceEvent {
  return {
    source: 'usgs',
    sourceId: 'us1000abcd',
    time: Date.UTC(2026, 1, 16, 12, 0, 0),
    updated: Date.UTC(2026, 1, 16, 12, 5, 0),
    lat: 38.3,
    lon: 142.4,
    depthKm: 29,
    mag: 6.1,
    magType: 'mww',
    place: '70km E of Ishinomaki, Japan',
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us1000abcd',
    type: 'earthquake',
    status: 'reviewed',
    tsunami: false,
    felt: null,
    alert: null,
    sig: 500,
    nst: 120,
    xrefs: [],
    ...over,
  };
}

/** The same quake as EMSC would report it: a different id, scale and region name. */
function emsc(over: Partial<SourceEvent> = {}): SourceEvent {
  return usgs({
    source: 'emsc',
    sourceId: '20260216_0000042',
    magType: 'mb',
    place: 'NEAR EAST COAST OF HONSHU, JAPAN',
    url: 'https://www.emsc-csem.org/Earthquake_information/earthquake.php?id=20260216_0000042',
    status: 'automatic',
    nst: 40,
    sig: 0,
    ...over,
  });
}

describe('matchScore', () => {
  it('is 0 for identical solutions and below 1 for a realistic pair', () => {
    const a = usgs();
    expect(matchScore(a, { ...a, source: 'emsc' } as never)).toBe(0);
    // 8 s apart, ~25 km apart, 0.3 magnitude apart: comfortably the same quake.
    expect(matchScore(a, emsc({ time: a.time + 8_000, lat: 38.1, lon: 142.3, mag: 5.8 }))).toBeLessThan(0.5);
  });

  it('rejects a report that breaks any single half-axis, however close the others', () => {
    const a = usgs();
    expect(matchScore(a, emsc({ time: a.time + 46_000 }))).toBe(Infinity);
    expect(matchScore(a, emsc({ mag: a.mag + 1.6 }))).toBe(Infinity);
    expect(matchScore(a, emsc({ lat: a.lat + 5 }))).toBe(Infinity); // ~555 km
  });

  it('rejects reports that are individually borderline but jointly too far', () => {
    const a = usgs();
    // 40 s and ~300 km and 1.3 magnitude: each inside its gate, together outside the ellipsoid.
    const score = matchScore(a, emsc({ time: a.time + 40_000, lat: a.lat + 2.7, mag: a.mag - 1.3 }));
    expect(score).toBeGreaterThan(1);
  });
});

describe('magnitude scales', () => {
  it('ranks moment magnitude above body and local scales', () => {
    expect(magTypeRank('mww')).toBeGreaterThan(magTypeRank('mb'));
    expect(magTypeRank('mb')).toBeGreaterThan(magTypeRank('ml'));
    expect(magTypeRank('ml')).toBeGreaterThan(magTypeRank('md'));
    expect(magTypeRank('')).toBe(0);
  });
});

describe('MergeEngine', () => {
  it('merges the two networks’ reports of one quake into a single event', () => {
    const engine = new MergeEngine();
    const a = engine.ingest(usgs());
    const b = engine.ingest(emsc({ time: usgs().time + 6_000, lat: 38.21, lon: 142.33, mag: 5.9 }));

    expect(a.change).toBe('created');
    expect(b.change).toBe('merged');
    expect(engine.size).toBe(1);
    expect(b.event.sources.map((c) => c.source).sort()).toEqual(['emsc', 'usgs']);
  });

  it('keeps the id it assigned first, so the browser never sees a marker change identity', () => {
    const engine = new MergeEngine();
    const first = engine.ingest(emsc()).event.id;
    const after = engine.ingest(usgs({ time: emsc().time + 5_000 })).event;
    expect(after.id).toBe(first);
    expect(after.id).toBe('emsc:20260216_0000042');
  });

  it('never merges two reports from the same network', () => {
    const engine = new MergeEngine();
    engine.ingest(usgs({ sourceId: 'us-a' }));
    // A second USGS event in the same place seconds later is an aftershock, not a duplicate.
    const second = engine.ingest(usgs({ sourceId: 'us-b', time: usgs().time + 20_000, mag: 5.4 }));
    expect(second.change).toBe('created');
    expect(engine.size).toBe(2);
  });

  it('matches on a shared identifier even when the solutions sit far apart', () => {
    const engine = new MergeEngine();
    engine.ingest(emsc({ sourceId: '20260216_0000042' }));
    // USGS lists the EMSC id in `ids`, which settles it regardless of distance.
    const result = engine.ingest(
      usgs({ lat: 10, lon: 10, time: usgs().time + 10 * 60_000, xrefs: ['20260216_0000042'] }),
    );
    expect(result.change).toBe('merged');
    expect(engine.size).toBe(1);
  });

  it('prefers moment magnitude over a local scale, whichever network reported it', () => {
    const engine = new MergeEngine();
    engine.ingest(usgs({ mag: 6.1, magType: 'ml', status: 'automatic' }));
    const merged = engine.ingest(emsc({ mag: 6.6, magType: 'mww', time: usgs().time + 4_000 })).event;
    expect(merged.mag).toBe(6.6);
    expect(merged.magType).toBe('mww');
    expect(merged.magnitudeSource).toBe('emsc');
  });

  it('prefers a reviewed hypocentre over an automatic one', () => {
    const engine = new MergeEngine();
    engine.ingest(emsc({ status: 'automatic', lat: 38.0, lon: 142.0, depthKm: 10 }));
    const merged = engine.ingest(
      usgs({ status: 'reviewed', lat: 38.297, lon: 142.373, depthKm: 29, time: emsc().time + 3_000 }),
    ).event;
    expect(merged.lat).toBe(38.297);
    expect(merged.depthKm).toBe(29);
    expect(merged.preferredSource).toBe('usgs');
  });

  it('takes the hypocentre and its depth from one solution, never a blend of both', () => {
    const engine = new MergeEngine();
    engine.ingest(usgs({ status: 'reviewed', lat: 38.3, lon: 142.4, depthKm: 29 }));
    const merged = engine.ingest(
      emsc({ status: 'automatic', lat: 38.1, lon: 142.1, depthKm: 10, time: usgs().time + 5_000 }),
    ).event;
    const chosen = merged.sources.find((c) => c.source === merged.preferredSource)!;
    expect([merged.lat, merged.lon, merged.depthKm]).toEqual([chosen.lat, chosen.lon, chosen.depthKm]);
  });

  it('prefers the solution built from more stations when neither is reviewed', () => {
    const engine = new MergeEngine();
    engine.ingest(usgs({ status: 'automatic', nst: 12, lat: 38.0, lon: 142.0 }));
    const merged = engine.ingest(
      emsc({ status: 'automatic', nst: 95, lat: 38.4, lon: 142.5, time: usgs().time + 4_000 }),
    ).event;
    expect(merged.preferredSource).toBe('emsc');
    expect(merged.lat).toBe(38.4);
  });

  it('keeps the place name that names a town over the one that names a region', () => {
    const engine = new MergeEngine();
    engine.ingest(usgs({ place: '70km E of Ishinomaki, Japan' }));
    const merged = engine.ingest(emsc({ time: usgs().time + 5_000 })).event;
    expect(merged.place).toBe('70km E of Ishinomaki, Japan');
  });

  it('applies a revision in place and reports it as an update', () => {
    const engine = new MergeEngine();
    const created = engine.ingest(usgs({ mag: 6.1, status: 'automatic' }));
    const revised = engine.ingest(
      usgs({ mag: 6.4, status: 'reviewed', updated: usgs().updated + 60_000 }),
    );
    expect(revised.change).toBe('updated');
    expect(engine.size).toBe(1);
    expect(revised.event.mag).toBe(6.4);
    expect(revised.event.status).toBe('reviewed');
    expect(revised.event.lastChanged).toBeGreaterThanOrEqual(created.event.firstSeen);
  });

  it('ignores a repeat of a report it already has', () => {
    const engine = new MergeEngine();
    engine.ingest(usgs());
    expect(engine.ingest(usgs()).change).toBe('unchanged');
  });

  it('carries forward impact facts that only one network publishes', () => {
    const engine = new MergeEngine();
    engine.ingest(usgs({ tsunami: true, felt: 240, alert: 'yellow' }));
    // EMSC knows none of this; the merged event must not lose it.
    const merged = engine.ingest(emsc({ time: usgs().time + 5_000 })).event;
    expect(merged.tsunami).toBe(true);
    expect(merged.felt).toBe(240);
    expect(merged.alert).toBe('yellow');
  });

  it('forgets events older than the cutoff', () => {
    const engine = new MergeEngine();
    engine.ingest(usgs({ sourceId: 'old', time: Date.UTC(2020, 0, 1) }));
    engine.ingest(usgs({ sourceId: 'new', time: Date.UTC(2026, 0, 1) }));
    expect(engine.evictBefore(Date.UTC(2023, 0, 1))).toBe(1);
    expect(engine.size).toBe(1);
  });
});

describe('preferredSolution', () => {
  it('can take the position from one network and the magnitude from the other', () => {
    const engine = new MergeEngine();
    // USGS reviewed the location but only has a local magnitude;
    // EMSC is automatic but computed a moment magnitude.
    engine.ingest(usgs({ status: 'reviewed', magType: 'ml', mag: 5.2, lat: 38.3 }));
    const merged = engine.ingest(
      emsc({ status: 'automatic', magType: 'mww', mag: 5.7, lat: 38.0, time: usgs().time + 3_000 }),
    ).event;
    const { hypocentre, magnitude } = preferredSolution(merged.sources);
    expect(hypocentre.source).toBe('usgs');
    expect(magnitude.source).toBe('emsc');
    expect(merged.lat).toBe(38.3);
    expect(merged.mag).toBe(5.7);
  });
});

describe('against the real 2015 Nepal aftershock sequence', () => {
  const { events } = parseUsgsCollection(nepalWeek);

  it('loads a busy real week', () => {
    expect(events.length).toBeGreaterThan(150);
    expect(events.some((e) => e.mag >= 7.8)).toBe(true); // the 25 April M7.8 itself
  });

  it('keeps every real event separate — aftershocks are not duplicates', () => {
    const engine = new MergeEngine();
    for (const event of events) engine.ingest(event);
    expect(engine.size).toBe(events.length);
  });

  it('merges a simulated EMSC view of the same week back down to one event each', () => {
    const engine = new MergeEngine();
    // EMSC reporting the same quakes: different ids, its own scale, and the
    // scatter two independent networks really show (seconds, tens of km, tenths of a unit).
    let seed = 7;
    const noise = (span: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return ((seed / 2147483648) * 2 - 1) * span;
    };
    for (const event of events) {
      engine.ingest(event);
      engine.ingest({
        ...event,
        source: 'emsc',
        sourceId: `emsc-${event.sourceId}`,
        time: event.time + noise(9_000),
        lat: event.lat + noise(0.25),
        lon: event.lon + noise(0.25),
        depthKm: Math.max(0, event.depthKm + noise(12)),
        mag: event.mag + noise(0.35),
        magType: 'mb',
        status: 'automatic',
        place: 'NEPAL REGION',
        nst: 30,
        xrefs: [],
      });
    }
    expect(engine.size).toBe(events.length);
    expect(engine.all().every((e) => e.sources.length === 2)).toBe(true);
  });

  it('does not merge the one real pair that lands inside the gates (same network)', () => {
    // 25 April 2015: two distinct Nepal aftershocks 38 s and 67 km apart, 0.2 magnitude apart.
    const a = events.find((e) => e.sourceId === 'us20002944');
    const b = events.find((e) => e.sourceId === 'us20002bfd');
    expect(a && b).toBeTruthy();
    expect(matchScore(a!, b!)).toBeLessThan(1); // they would match on the numbers alone…

    const engine = new MergeEngine();
    engine.ingest(a!);
    engine.ingest(b!);
    expect(engine.size).toBe(2); // …but one network does not report a quake twice
  });

  it('merge criteria are the documented half-axes', () => {
    expect(MATCH).toEqual({ timeSec: 45, distanceKm: 350, magnitude: 1.5 });
  });
});

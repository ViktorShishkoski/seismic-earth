import { beforeEach, describe, expect, it } from 'vitest';
import { QuakeStore } from '../src/data/QuakeStore.ts';
import { ReplayFeed } from '../src/data/ReplayFeed.ts';
import { replayPresets } from '../src/data/replay.ts';
import type { ReplayPreset } from '../src/data/replay.ts';
import type { FeedResult } from '../src/data/usgs.ts';
import type { Quake } from '../src/data/quake.ts';

const T0 = Date.UTC(2011, 2, 11, 6, 0, 0);
const MIN = 60_000;

function quake(offsetMin: number, mag = 5, id = `q${offsetMin}`): Quake {
  return {
    id,
    time: T0 + offsetMin * MIN,
    updated: T0 + offsetMin * MIN,
    mag,
    magType: 'mw',
    place: `event at +${offsetMin} min`,
    lat: 38,
    lon: 142,
    depthKm: 25,
    type: 'earthquake',
    status: 'reviewed',
    url: '',
    felt: null,
    alert: null,
    sig: 0,
    tsunami: false,
  };
}

/** Events at −120, −30, 0, +10, +30 and +90 minutes around the cursor's start. */
const CATALOG = [quake(-120), quake(-30), quake(0), quake(10), quake(30), quake(90)];

const PRESET: ReplayPreset = {
  id: 'test',
  name: 'Test',
  when: 'some time',
  blurb: 'a made-up sequence',
  url: 'memory://catalog',
  startMs: T0,
  endMs: T0 + 120 * MIN,
  speed: 60, // one data-minute per real second
  trailingMs: 60 * MIN,
  minMag: 4,
  camera: { lat: 38, lon: 142, distance: 2.5 },
};

function feedWith(preset = PRESET, catalog = CATALOG) {
  const store = new QuakeStore();
  const result: FeedResult = { quakes: catalog, generated: T0, title: 'test', skipped: 0 };
  const feed = new ReplayFeed(store, preset, { load: async () => result });
  const snapshots: Array<{ added: string[]; removed: string[]; initial: boolean }> = [];
  feed.onSnapshot(({ diff, initial }) =>
    snapshots.push({
      added: diff.added.map((q) => q.id),
      removed: diff.removed.map((q) => q.id),
      initial,
    }),
  );
  return { store, feed, snapshots };
}

describe('replaying the catalogue', () => {
  let ctx: ReturnType<typeof feedWith>;

  beforeEach(async () => {
    ctx = feedWith();
    await ctx.feed.start();
  });

  it('opens with the history already inside the trailing window', () => {
    // −120 min is outside the one-hour trail; −30 and 0 are in it.
    expect(ctx.store.all().map((q) => q.id).sort()).toEqual(['q-30', 'q0']);
    expect(ctx.feed.nowMs).toBe(T0);
    expect(ctx.feed.status.mode).toBe('replay');
    expect(ctx.feed.status.generated).toBe(T0);
    expect(ctx.snapshots.at(-1)!.initial).toBe(true);
  });

  it('lets events arrive exactly when they happened', () => {
    ctx.snapshots.length = 0;
    ctx.feed.tick(9); // 9 real seconds = 9 data minutes: nothing due yet
    expect(ctx.snapshots).toEqual([]);

    ctx.feed.tick(1.5); // now past +10 min
    expect(ctx.snapshots.map((s) => s.added)).toEqual([['q10']]);
    expect(ctx.snapshots.at(-1)!.initial).toBe(false);
    expect(ctx.store.get('q10')).toBeDefined();
  });

  it('runs at the speed it is told', () => {
    ctx.feed.speed = 600; // ten data-minutes per real second
    ctx.feed.tick(1);
    expect(ctx.feed.nowMs).toBe(T0 + 10 * MIN);
    expect(ctx.store.get('q10')).toBeDefined();
    expect(ctx.store.get('q30')).toBeUndefined();
  });

  it('drops events out of the back of the window as the clock runs', () => {
    ctx.snapshots.length = 0;
    ctx.feed.speed = 6000;
    ctx.feed.tick(1); // +100 min, so the trailing edge is at +40 min
    const removed = ctx.snapshots.flatMap((s) => s.removed);
    expect(removed).toContain('q-30');
    expect(removed).toContain('q0');
    // q10 came and went inside the same jump, so it was never on screen.
    expect(ctx.store.all().map((q) => q.id)).toEqual(['q90']);
  });

  it('stops at the end instead of running off into empty time', () => {
    ctx.feed.speed = 1e6;
    ctx.feed.tick(1);
    expect(ctx.feed.nowMs).toBe(PRESET.endMs);
    expect(ctx.feed.finished).toBe(true);
    expect(ctx.feed.progress).toBe(1);
    ctx.feed.tick(1);
    expect(ctx.feed.nowMs).toBe(PRESET.endMs);
  });

  it('holds still while paused', () => {
    ctx.feed.playing = false;
    ctx.feed.tick(30);
    expect(ctx.feed.nowMs).toBe(T0);
    ctx.feed.playing = true;
    ctx.feed.tick(30);
    expect(ctx.feed.nowMs).toBe(T0 + 30 * MIN);
  });

  it('rebuilds the whole window when scrubbed backwards', () => {
    ctx.feed.seek(1); // to the end
    expect(ctx.store.all().map((q) => q.id).sort()).toEqual(['q90']);
    ctx.snapshots.length = 0;
    ctx.feed.seek(0.25); // back to +30 min
    expect(ctx.feed.nowMs).toBe(T0 + 30 * MIN);
    expect(ctx.store.all().map((q) => q.id).sort()).toEqual(['q-30', 'q0', 'q10', 'q30']);
    // A jump is not a stream of arrivals: nothing should toast or pulse.
    expect(ctx.snapshots.at(-1)!.initial).toBe(true);
  });

  it('reports how far through it is', () => {
    expect(ctx.feed.progress).toBe(0);
    ctx.feed.tick(60); // 60 data-minutes of a 120-minute replay
    expect(ctx.feed.progress).toBeCloseTo(0.5, 6);
    ctx.feed.restart();
    expect(ctx.feed.progress).toBe(0);
    expect(ctx.feed.playing).toBe(true);
  });

  it('ignores a catalogue that reaches outside the replay', () => {
    const far = [...CATALOG, quake(10_000, 7, 'future'), quake(-10_000, 7, 'ancient')];
    const other = feedWith(PRESET, far);
    return other.feed.start().then(() => {
      other.feed.seek(1);
      expect(other.store.get('future')).toBeUndefined();
      expect(other.store.get('ancient')).toBeUndefined();
    });
  });

  it('surfaces a load failure instead of pretending to replay', async () => {
    const store = new QuakeStore();
    const feed = new ReplayFeed(store, PRESET, {
      load: async () => {
        throw new Error('404 from the sample file');
      },
    });
    await expect(feed.start()).rejects.toThrow('404');
    expect(feed.status.lastError).toContain('404');
    expect(feed.status.mode).toBe('sample');
    feed.tick(10);
    expect(feed.nowMs).toBe(T0); // the clock never started
  });
});

describe('the bundled replays', () => {
  const presets = replayPresets('/');

  it('all point at a bundled catalogue and a sane span', () => {
    expect(presets.length).toBeGreaterThanOrEqual(3);
    for (const p of presets) {
      expect(p.url).toMatch(/^\/data\/usgs-sample-.*\.geojson$/);
      expect(p.endMs).toBeGreaterThan(p.startMs);
      // Long enough for the S wave to cross the planet, short enough to watch.
      const minutes = (p.endMs - p.startMs) / MIN;
      expect(minutes).toBeGreaterThan(30);
      expect(minutes).toBeLessThan(24 * 60);
      expect(p.speed).toBeGreaterThan(1);
      expect(Math.abs(p.camera.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(p.camera.lon)).toBeLessThanOrEqual(180);
      expect(p.trailingMs).toBeGreaterThan(0);
    }
  });

  it('starts each one shortly before the event it is named for', () => {
    const tohoku = presets.find((p) => p.id === 'tohoku')!;
    // The M9.0 originated at 05:46:24 UTC on 11 March 2011.
    const mainShock = Date.UTC(2011, 2, 11, 5, 46, 24);
    expect(tohoku.startMs).toBeLessThan(mainShock);
    expect(mainShock - tohoku.startMs).toBeLessThan(15 * MIN);
    expect(tohoku.endMs).toBeGreaterThan(mainShock + 60 * MIN);
  });

  it('gives every replay a distinct id', () => {
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
  });
});

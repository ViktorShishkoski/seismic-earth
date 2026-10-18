import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuakeStore } from '../src/data/QuakeStore.ts';
import { LiveFeed } from '../src/data/LiveFeed.ts';
import type { Quake } from '../src/data/quake.ts';
import type { FeedResult } from '../src/data/usgs.ts';

function quake(id: string, over: Partial<Quake> = {}): Quake {
  return {
    id,
    time: 1_000,
    updated: 1_000,
    lat: 0,
    lon: 0,
    depthKm: 10,
    mag: 3,
    magType: 'ml',
    place: id,
    url: '',
    type: 'earthquake',
    status: 'automatic',
    tsunami: false,
    felt: null,
    alert: null,
    sig: 0,
    ...over,
  };
}

describe('QuakeStore.applySnapshot', () => {
  it('reports everything as added on first load', () => {
    const store = new QuakeStore();
    const diff = store.applySnapshot([quake('a'), quake('b')]);
    expect(diff.added.map((q) => q.id)).toEqual(['a', 'b']);
    expect(diff.updated).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(store.size).toBe(2);
  });

  it('finds new, revised and expired events between two snapshots', () => {
    const store = new QuakeStore();
    store.applySnapshot([quake('a'), quake('b'), quake('c')]);
    const v = store.version;
    const diff = store.applySnapshot([
      quake('a'), // unchanged
      quake('b', { mag: 3.4, updated: 2_000 }), // revised by a seismologist
      quake('d'), // new
    ]); // c aged out of the window

    expect(diff.added.map((q) => q.id)).toEqual(['d']);
    expect(diff.updated.map((q) => q.id)).toEqual(['b']);
    expect(diff.removed.map((q) => q.id)).toEqual(['c']);
    expect(store.get('b')!.mag).toBe(3.4);
    expect(store.version).toBeGreaterThan(v);
  });

  it('ignores a re-sent event that is not newer', () => {
    const store = new QuakeStore();
    store.applySnapshot([quake('a', { updated: 5_000, mag: 4 })]);
    const v = store.version;
    const diff = store.applySnapshot([quake('a', { updated: 4_000, mag: 3 })]);
    expect(diff.updated).toEqual([]);
    expect(store.get('a')!.mag).toBe(4);
    expect(store.version).toBe(v);
  });
});

describe('QuakeStore.visible', () => {
  const store = new QuakeStore();
  store.applySnapshot([
    quake('small', { mag: 1.2 }),
    quake('big', { mag: 6.1 }),
    quake('mid', { mag: 4.0 }),
    quake('blast', { mag: 2.0, type: 'quarry blast' }),
  ]);

  it('filters by magnitude and hides non-earthquakes by default', () => {
    expect(store.visible({ minMag: 2, includeNonEarthquakes: false }).map((q) => q.id)).toEqual(['big', 'mid']);
    expect(store.visible({ minMag: -Infinity, includeNonEarthquakes: true })).toHaveLength(4);
  });

  it('sorts largest first so small markers draw on top', () => {
    const mags = store.visible({ minMag: -Infinity, includeNonEarthquakes: false }).map((q) => q.mag);
    expect(mags).toEqual([...mags].sort((a, b) => b - a));
  });
});

describe('LiveFeed', () => {
  afterEach(() => vi.useRealTimers());

  const result = (quakes: Quake[], generated = 1): FeedResult => ({ quakes, generated, title: 't', skipped: 0 });

  it('loads, then polls on an interval and reports new events as non-initial', async () => {
    vi.useFakeTimers();
    const store = new QuakeStore();
    const responses = [result([quake('a')]), result([quake('a'), quake('b')], 2)];
    const fetchFeed = vi.fn(async () => responses.shift() ?? result([quake('a'), quake('b')], 3));
    const feed = new LiveFeed(store, { fetchFeed, intervalMs: 60_000 });
    const events: Array<{ added: string[]; initial: boolean }> = [];
    feed.onSnapshot(({ diff, initial }) => events.push({ added: diff.added.map((q) => q.id), initial }));

    await feed.start('day');
    expect(feed.status.mode).toBe('live');
    expect(events).toEqual([{ added: ['a'], initial: true }]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
    expect(events[1]).toEqual({ added: ['b'], initial: false });
    feed.dispose();
  });

  it('falls back to the bundled sample when the first load fails, then recovers', async () => {
    vi.useFakeTimers();
    const store = new QuakeStore();
    let online = false;
    const fetchFeed = vi.fn(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return result([quake('live-1')]);
    });
    const loadSample = vi.fn(async () => result([quake('sample-1'), quake('sample-2')], 1517968154000));
    const feed = new LiveFeed(store, { fetchFeed, loadSample, intervalMs: 60_000 });

    await feed.start('week');
    expect(feed.status.mode).toBe('sample');
    expect(feed.status.lastError).toMatch(/could not be reached/);
    expect(store.size).toBe(2);

    online = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(feed.status.mode).toBe('live');
    expect(store.all().map((q) => q.id)).toEqual(['live-1']); // sample replaced, not merged
    feed.dispose();
  });

  it('drops a slow response from a feed the user already switched away from', async () => {
    const store = new QuakeStore();
    let resolveSlow: (r: FeedResult) => void = () => {};
    const fetchFeed = vi.fn((feedId: string) =>
      feedId === 'month'
        ? new Promise<FeedResult>((resolve) => (resolveSlow = resolve))
        : Promise.resolve(result([quake('hour-1')])),
    );
    const feed = new LiveFeed(store, { fetchFeed });

    const slow = feed.start('month');
    await feed.start('hour');
    resolveSlow(result([quake('month-1'), quake('month-2')]));
    await slow;

    expect(feed.status.feed).toBe('hour');
    expect(store.all().map((q) => q.id)).toEqual(['hour-1']);
    feed.dispose();
  });
});

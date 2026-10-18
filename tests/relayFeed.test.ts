import { describe, expect, it, vi } from 'vitest';
import { QuakeStore } from '../src/data/QuakeStore.ts';
import { RelayFeed } from '../src/data/RelayFeed.ts';
import { liveSocketUrl, relayUrl } from '../src/data/feed.ts';
import type { Quake } from '../src/data/quake.ts';

function quake(id: string, over: Partial<Quake> = {}): Quake {
  return {
    id,
    time: Date.UTC(2026, 1, 16, 12),
    updated: Date.UTC(2026, 1, 16, 12, 2),
    lat: 38.3,
    lon: 142.4,
    depthKm: 29,
    mag: 6,
    magType: 'mww',
    place: id,
    url: '',
    type: 'earthquake',
    status: 'reviewed',
    tsunami: false,
    felt: null,
    alert: null,
    sig: 0,
    ...over,
  };
}

/** A stand-in for the browser's WebSocket that the test drives by hand. */
class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  deliver(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  get subscriptions() {
    return this.sent.map((s) => JSON.parse(s) as { type: string; from: number; minMag: number });
  }
}

const connectedFeed = async (store: QuakeStore) => {
  const feed = new RelayFeed(store, 'http://localhost:8787', {
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    backoffMs: 5,
  });
  await feed.start('week');
  FakeSocket.last!.open();
  return { feed, socket: FakeSocket.last! };
};

describe('finding the relay', () => {
  it('uses one named in the URL, and "off" disables it', () => {
    expect(relayUrl('?relay=http://10.0.0.5:9000', 'example.com')).toBe('http://10.0.0.5:9000');
    expect(relayUrl('?relay=off', 'localhost')).toBeNull();
  });

  it('looks for a local relay while developing, and never on a deployed site', () => {
    expect(relayUrl('', 'localhost')).toBe('http://localhost:8787');
    expect(relayUrl('', '127.0.0.1')).toBe('http://localhost:8787');
    // The demo on GitHub Pages has no server behind it; it must not try.
    expect(relayUrl('', 'viktor.github.io')).toBeNull();
  });

  it('builds the WebSocket URL from the HTTP one, keeping TLS', () => {
    expect(liveSocketUrl('http://localhost:8787')).toBe('ws://localhost:8787/live');
    expect(liveSocketUrl('https://relay.example.com')).toBe('wss://relay.example.com/live');
  });
});

describe('RelayFeed', () => {
  it('subscribes to the window it was started with', async () => {
    const { socket } = await connectedFeed(new QuakeStore());
    const [subscription] = socket.subscriptions;
    expect(subscription!.type).toBe('subscribe');
    // A week back, give or take the moment the test ran.
    expect(Date.now() - subscription!.from).toBeCloseTo(7 * 86_400_000, -5);
  });

  it('fills the globe from the snapshot and reports it as the initial load', async () => {
    const store = new QuakeStore();
    const { feed, socket } = await connectedFeed(store);
    const seen: boolean[] = [];
    feed.onSnapshot((e) => seen.push(e.initial));

    socket.deliver({ type: 'snapshot', generated: Date.now(), events: [quake('a'), quake('b')] });
    expect(store.size).toBe(2);
    expect(seen).toEqual([true]);
    expect(feed.status.mode).toBe('live');
    expect(feed.status.transport).toBe('relay');
  });

  it('adds pushed events without dropping the ones already on screen', async () => {
    const store = new QuakeStore();
    const { feed, socket } = await connectedFeed(store);
    socket.deliver({ type: 'snapshot', events: [quake('a'), quake('b')] });

    const added: string[] = [];
    feed.onSnapshot((e) => added.push(...e.diff.added.map((q) => q.id)));
    socket.deliver({ type: 'upsert', events: [quake('c')] });

    expect(store.size).toBe(3); // a and b are still there
    expect(added).toEqual(['c']);
  });

  it('applies a revision pushed for an event it already has', async () => {
    const store = new QuakeStore();
    const { feed, socket } = await connectedFeed(store);
    socket.deliver({ type: 'snapshot', events: [quake('a', { mag: 6 })] });

    const updated: number[] = [];
    feed.onSnapshot((e) => updated.push(...e.diff.updated.map((q) => q.mag)));
    socket.deliver({
      type: 'upsert',
      events: [quake('a', { mag: 6.4, updated: Date.UTC(2026, 1, 16, 13) })],
    });

    expect(store.size).toBe(1);
    expect(updated).toEqual([6.4]);
    expect(store.get('a')!.mag).toBe(6.4);
  });

  it('carries the networks behind each event through to the store', async () => {
    const store = new QuakeStore();
    const { socket } = await connectedFeed(store);
    socket.deliver({
      type: 'snapshot',
      events: [
        quake('emsc:x', {
          preferredSource: 'usgs',
          magnitudeSource: 'usgs',
          sources: [
            { source: 'usgs', sourceId: 'us1', time: 0, lat: 0, lon: 0, depthKm: 10, mag: 6.2, magType: 'mww', status: 'reviewed', nst: 140, url: '' },
            { source: 'emsc', sourceId: '2026x', time: 0, lat: 0, lon: 0, depthKm: 11, mag: 5.9, magType: 'mb', status: 'automatic', nst: 40, url: '' },
          ],
        }),
      ],
    });
    expect(store.get('emsc:x')!.sources).toHaveLength(2);
    expect(store.get('emsc:x')!.preferredSource).toBe('usgs');
  });

  it('re-subscribes when the window changes, and starts the globe empty', async () => {
    const store = new QuakeStore();
    const { feed, socket } = await connectedFeed(store);
    socket.deliver({ type: 'snapshot', events: [quake('a')] });
    expect(store.size).toBe(1);

    await feed.start('hour');
    expect(store.size).toBe(0);
    const last = socket.subscriptions.at(-1)!;
    expect(Date.now() - last.from).toBeCloseTo(3_600_000, -4);
  });

  it('asks the relay only for the magnitudes a window covers', async () => {
    const { feed, socket } = await connectedFeed(new QuakeStore());
    await feed.start('year');
    expect(socket.subscriptions.at(-1)!.minMag).toBe(4.5);
  });

  it('reconnects after the relay drops, and re-reads the window', async () => {
    vi.useFakeTimers();
    try {
      const store = new QuakeStore();
      const feed = new RelayFeed(store, 'http://localhost:8787', {
        createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
        backoffMs: 50,
      });
      await feed.start('week');
      const first = FakeSocket.last!;
      first.open();
      first.deliver({ type: 'snapshot', events: [quake('a')] });

      first.drop();
      expect(feed.status.lastError).toMatch(/dropped/);

      await vi.advanceTimersByTimeAsync(60);
      const second = FakeSocket.last!;
      expect(second).not.toBe(first);
      second.open();
      // The fresh snapshot repairs anything missed while it was away.
      expect(second.subscriptions.at(-1)!.type).toBe('subscribe');
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores nonsense from the relay instead of breaking', async () => {
    const store = new QuakeStore();
    const { socket } = await connectedFeed(store);
    socket.onmessage!({ data: 'not json' });
    socket.deliver({ type: 'unknown' });
    socket.deliver(null);
    expect(store.size).toBe(0);
  });
});

describe('QuakeStore.merge', () => {
  it('adds and updates without removing anything absent', () => {
    const store = new QuakeStore();
    store.applySnapshot([quake('a'), quake('b')]);
    const diff = store.merge([quake('b', { mag: 7, updated: Date.UTC(2026, 1, 17) }), quake('c')]);
    expect(diff.added.map((q) => q.id)).toEqual(['c']);
    expect(diff.updated.map((q) => q.id)).toEqual(['b']);
    expect(diff.removed).toEqual([]);
    expect(store.size).toBe(3); // 'a' was not in the batch but has not expired
  });

  it('ignores a push that is older than what it already holds', () => {
    const store = new QuakeStore();
    store.applySnapshot([quake('a', { mag: 7, updated: 5_000 })]);
    const diff = store.merge([quake('a', { mag: 6, updated: 4_000 })]);
    expect(diff.updated).toEqual([]);
    expect(store.get('a')!.mag).toBe(7);
  });
});

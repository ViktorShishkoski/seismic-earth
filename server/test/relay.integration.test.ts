import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { EventStore } from '../src/store.ts';
import { Relay } from '../src/relay.ts';
import { createApi } from '../src/api.ts';
import { UsgsSource } from '../src/sources/usgs.ts';
import { EmscSource } from '../src/sources/emsc.ts';
import { loadConfig } from '../src/config.ts';
import type { MergedEvent } from '../src/types.ts';

/**
 * The whole relay, end to end.
 *
 * Nothing is stubbed inside the relay: a real HTTP server serves a fake USGS
 * feed, a real WebSocket server stands in for EMSC's push stream, and a real
 * browser-side WebSocket client connects to the relay. Only the two public
 * networks are ours, so the test can make the same earthquake arrive twice,
 * drop the stream, and check what the browser ends up seeing.
 */

const TOHOKU = { lat: 38.297, lon: 142.373, depthKm: 29, time: Date.UTC(2026, 1, 16, 5, 46, 24) };

/** A USGS summary feed we control. */
function usgsFeature(over: Partial<Record<string, unknown>> = {}, geometry?: number[]) {
  return {
    type: 'Feature',
    id: 'us2026abcd',
    properties: {
      mag: 6.2,
      place: '70km E of Ishinomaki, Japan',
      time: TOHOKU.time,
      updated: TOHOKU.time + 120_000,
      magType: 'mww',
      type: 'earthquake',
      status: 'reviewed',
      tsunami: 1,
      sig: 600,
      nst: 140,
      ids: ',us2026abcd,',
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us2026abcd',
      ...over,
    },
    geometry: { type: 'Point', coordinates: geometry ?? [TOHOKU.lon, TOHOKU.lat, TOHOKU.depthKm] },
  };
}

/** An EMSC WebSocket message in the shape their service documents. */
function emscMessage(over: Partial<Record<string, unknown>> = {}, action = 'create') {
  return JSON.stringify({
    action,
    data: {
      type: 'Feature',
      id: '20260216_0000042',
      geometry: { type: 'Point', coordinates: [142.31, 38.2, -11] },
      properties: {
        unid: '20260216_0000042',
        time: new Date(TOHOKU.time + 7_000).toISOString(),
        lastupdate: new Date(TOHOKU.time + 90_000).toISOString(),
        lat: 38.2,
        lon: 142.31,
        depth: 11,
        mag: 5.9,
        magtype: 'mb',
        evtype: 'ke',
        auth: 'EMSC',
        source_catalog: 'EMSC-RTS',
        flynn_region: 'NEAR EAST COAST OF HONSHU, JAPAN',
        ...over,
      },
    },
  });
}

async function waitFor(check: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const port = (server: Server) => (server.address() as AddressInfo).port;

describe('the relay, end to end', () => {
  let usgsServer: Server;
  let usgsFeed: unknown;
  let usgsHits = 0;
  let emscServer: WebSocketServer;
  let emscSockets: WebSocket[] = [];
  let emscBackfill: unknown;

  let store: EventStore;
  let relay: Relay;
  let api: ReturnType<typeof createApi>;
  let base: string;
  let client: WebSocket | null = null;

  beforeEach(async () => {
    usgsHits = 0;
    usgsFeed = { type: 'FeatureCollection', metadata: {}, features: [] };
    emscBackfill = { type: 'FeatureCollection', features: [] };

    // Fake USGS: one endpoint serving both the summary feed and the FDSN query.
    usgsServer = createServer((req, res) => {
      usgsHits++;
      const body = JSON.stringify(req.url?.includes('fdsn') ? { type: 'FeatureCollection', features: [] } : usgsFeed);
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });
    await new Promise<void>((r) => usgsServer.listen(0, '127.0.0.1', r));

    // Fake EMSC: a WebSocket that pushes whatever the test sends.
    emscSockets = [];
    emscServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    emscServer.on('connection', (ws) => emscSockets.push(ws));
    await new Promise<void>((r) => emscServer.on('listening', r));

    store = new EventStore(':memory:');
    relay = new Relay(store, { flushMs: 20, retentionDays: 90 });
    relay.addSource(
      new UsgsSource((events) => relay.ingest(events), {
        baseUrl: `http://127.0.0.1:${port(usgsServer)}/summary`,
        fdsnUrl: `http://127.0.0.1:${port(usgsServer)}/fdsn`,
        pollMs: 80,
      }),
    );
    relay.addSource(
      new EmscSource((events) => relay.ingest(events), {
        url: `ws://127.0.0.1:${(emscServer.address() as AddressInfo).port}`,
        fdsnUrl: `http://127.0.0.1:${port(usgsServer)}/emsc-fdsn`,
        backoffMs: 20,
        maxBackoffMs: 60,
        fetchFn: (async () =>
          new Response(JSON.stringify(emscBackfill), { headers: { 'content-type': 'application/json' } })) as typeof fetch,
      }),
    );

    const config = { ...loadConfig({}), allowedOrigins: ['*'] };
    api = createApi(relay, config);
    await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${port(api.server)}`;
    await relay.start();
    // `start` returns once the backfills are done; the stream connects just after.
    await waitFor(() => emscSockets.length > 0, 5_000, 'the EMSC stream to connect');
  });

  const sourceStatus = (name: string) => relay.status().sources.find((s) => s.name === name)!;

  afterEach(async () => {
    client?.close();
    await relay.stop();
    await api.close();
    store.close();
    emscServer.close();
    await new Promise<void>((r) => usgsServer.close(() => r()));
  });

  /** Opens a browser-side connection and subscribes to everything. */
  async function connect(subscribe: Record<string, unknown> = {}) {
    const socket = new WebSocket(`ws://127.0.0.1:${port(api.server)}/live`);
    client = socket;
    const messages: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', from: 0, minMag: -Infinity, ...subscribe }));
    await waitFor(() => messages.some((m) => m.type === 'snapshot'), 5_000, 'snapshot');
    const latest = () => messages.flatMap((m) => (m.events ?? []) as MergedEvent[]);
    return { socket, messages, latest };
  }

  it('greets a browser and sends a snapshot of what it already knows', async () => {
    usgsFeed = { type: 'FeatureCollection', features: [usgsFeature()] };
    await waitFor(() => relay.merge.size === 1, 5_000, 'the USGS poll');
    relay.flush();

    const { messages } = await connect();
    const hello = messages.find((m) => m.type === 'hello') as { protocol: number };
    const snapshot = messages.find((m) => m.type === 'snapshot') as { events: MergedEvent[] };
    expect(hello.protocol).toBe(1);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]!.place).toBe('70km E of Ishinomaki, Japan');
  });

  it('pushes an EMSC event to the browser without waiting for a poll', async () => {
    const { latest } = await connect();
    const sentAt = Date.now();
    emscSockets[0]!.send(emscMessage());

    await waitFor(() => latest().length > 0, 3_000, 'the pushed event');
    expect(Date.now() - sentAt).toBeLessThan(1_500); // pushed, not polled
    const event = latest()[0]!;
    expect(event.id).toBe('emsc:20260216_0000042');
    expect(event.mag).toBe(5.9);
    expect(event.place).toBe('NEAR EAST COAST OF HONSHU, JAPAN');
  });

  it('merges the same quake reported by both networks into one event', async () => {
    const { latest, messages } = await connect();

    // EMSC sees it first, as it usually does.
    emscSockets[0]!.send(emscMessage());
    await waitFor(() => latest().length > 0, 3_000, 'the EMSC report');

    // USGS publishes its own solution a moment later.
    usgsFeed = { type: 'FeatureCollection', features: [usgsFeature()] };
    await waitFor(
      () => latest().some((e) => e.sources.length === 2),
      5_000,
      'the merge',
    );

    expect(relay.merge.size).toBe(1);
    const merged = latest().at(-1)!;
    expect(merged.id).toBe('emsc:20260216_0000042'); // the id it was first given
    expect(merged.sources.map((s) => s.source).sort()).toEqual(['emsc', 'usgs']);
    // USGS reviewed it with 140 stations, so its hypocentre and moment magnitude win.
    expect(merged.preferredSource).toBe('usgs');
    expect(merged.mag).toBe(6.2);
    expect(merged.magType).toBe('mww');
    expect(merged.lat).toBe(TOHOKU.lat);
    expect(merged.tsunami).toBe(true);
    // The browser was told once per change, never about two separate quakes.
    const ids = new Set(messages.flatMap((m) => ((m.events ?? []) as MergedEvent[]).map((e) => e.id)));
    expect([...ids]).toEqual(['emsc:20260216_0000042']);
  });

  it('passes a revision through to the browser', async () => {
    const { latest } = await connect();
    emscSockets[0]!.send(emscMessage());
    await waitFor(() => latest().length > 0, 3_000, 'the first report');

    // EMSC revises the magnitude upward a minute later.
    emscSockets[0]!.send(
      emscMessage({ mag: 6.4, magtype: 'mw', lastupdate: new Date(TOHOKU.time + 300_000).toISOString() }, 'update'),
    );
    await waitFor(() => latest().some((e) => e.mag === 6.4), 3_000, 'the revision');
    expect(relay.merge.size).toBe(1);
  });

  it('only sends events inside the window the browser asked for', async () => {
    const { latest } = await connect({ minMag: 6 });
    emscSockets[0]!.send(emscMessage({ unid: 'small', mag: 4.1 }));
    emscSockets[0]!.send(emscMessage({ unid: 'big', mag: 6.8, lat: -20, lon: -178 }));

    await waitFor(() => latest().length > 0, 3_000, 'the large event');
    await new Promise((r) => setTimeout(r, 300));
    expect(latest().map((e) => e.mag)).toEqual([6.8]);
    expect(relay.merge.size).toBe(2); // both were stored; only one was sent
  });

  it('reconnects after the EMSC stream drops, and catches up on what it missed', async () => {
    await connect();
    await waitFor(() => sourceStatus('emsc').connected, 3_000, 'the EMSC connection');

    // What EMSC will report happened during the outage.
    emscBackfill = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            unid: 'missed-while-down',
            time: new Date(TOHOKU.time).toISOString(),
            lat: -21,
            lon: -177.5,
            depth: 540,
            mag: 5.5,
            magtype: 'mb',
            flynn_region: 'FIJI REGION',
          },
          geometry: { type: 'Point', coordinates: [-177.5, -21, -540] },
        },
      ],
    };

    emscSockets[0]!.close();
    await waitFor(() => emscSockets.length > 1, 5_000, 'the reconnect');
    await waitFor(() => relay.merge.get('emsc:missed-while-down') !== undefined, 5_000, 'the catch-up backfill');

    expect(sourceStatus('emsc').connected).toBe(true);
  });

  it('keeps serving USGS while EMSC is unreachable', async () => {
    emscSockets[0]?.close();
    emscServer.close();
    usgsFeed = { type: 'FeatureCollection', features: [usgsFeature()] };

    await waitFor(() => relay.merge.size === 1, 5_000, 'the USGS poll');
    expect(sourceStatus('usgs').connected).toBe(true);
    expect(relay.status().events).toBe(1);
  });

  it('serves the REST API', async () => {
    usgsFeed = { type: 'FeatureCollection', features: [usgsFeature()] };
    await waitFor(() => relay.merge.size === 1, 5_000, 'the USGS poll');
    relay.flush();

    const health = await (await fetch(`${base}/health`)).json();
    expect(health.ok).toBe(true);
    expect(health.sources.map((s: { name: string }) => s.name).sort()).toEqual(['emsc', 'usgs']);

    const list = await (await fetch(`${base}/events?minMag=5`)).json();
    expect(list.count).toBe(1);
    expect(list.events[0].mag).toBe(6.2);

    const empty = await (await fetch(`${base}/events?minMag=9`)).json();
    expect(empty.count).toBe(0);

    const one = await (await fetch(`${base}/events/usgs:us2026abcd`)).json();
    expect(one.sources).toHaveLength(1);

    expect((await fetch(`${base}/events/nope`)).status).toBe(404);
    expect((await fetch(`${base}/nothing-here`)).status).toBe(404);
  });

  it('survives rubbish from the networks and from browsers', async () => {
    const { socket } = await connect();
    // A malformed feed must not stop the poller.
    usgsFeed = { type: 'FeatureCollection', features: [{ type: 'Feature' }, usgsFeature()] };
    await waitFor(() => relay.merge.size === 1, 5_000, 'the good event out of a bad feed');
    expect(sourceStatus('usgs').rejected).toBeGreaterThan(0);

    // Nonsense over the socket must not close it.
    emscSockets[0]!.send('not json at all');
    emscSockets[0]!.send(JSON.stringify({ action: 'create', data: { properties: {} } }));
    socket.send('neither is this');
    socket.send(JSON.stringify({ type: 'unknown-command' }));

    await new Promise((r) => setTimeout(r, 200));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(sourceStatus('emsc').rejected).toBeGreaterThan(0);
  });

  it('remembers everything across a restart', async () => {
    usgsFeed = { type: 'FeatureCollection', features: [usgsFeature()] };
    await waitFor(() => relay.merge.size === 1, 5_000, 'the first event');
    relay.flush();

    // A second relay on the same database picks up where the first left off.
    const restarted = new Relay(store, { flushMs: 20 });
    expect(restarted.merge.size).toBe(1);
    expect(restarted.merge.get('usgs:us2026abcd')!.place).toBe('70km E of Ishinomaki, Japan');
    await restarted.stop();
  });
});

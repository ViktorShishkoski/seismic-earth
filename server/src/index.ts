import { loadConfig } from './config.ts';
import { EventStore } from './store.ts';
import { Relay } from './relay.ts';
import { createApi } from './api.ts';
import { UsgsSource } from './sources/usgs.ts';
import { EmscSource } from './sources/emsc.ts';

/**
 * Seismic Earth relay.
 *
 * Listens to EMSC's push stream and polls USGS, merges the two into one
 * catalogue, keeps the history in SQLite, and pushes every change to the
 * browsers watching. Run it with `npm run server`.
 */

const config = loadConfig();
const store = new EventStore(config.dbPath);
const relay = new Relay(store, { retentionDays: config.retentionDays });

if (config.usgsEnabled) {
  relay.addSource(
    new UsgsSource((events) => relay.ingest(events), {
      pollMs: config.usgsPollMs,
      historyDays: config.historyDays,
      backfillMinMag: config.backfillMinMag,
      baseUrl: config.usgsFeedUrl,
      fdsnUrl: config.usgsFdsnUrl,
    }),
  );
}

if (config.emscEnabled) {
  relay.addSource(
    new EmscSource((events) => relay.ingest(events), {
      historyDays: Math.min(config.historyDays, 7), // EMSC's FDSN window is smaller
      backfillMinMag: config.backfillMinMag,
      url: config.emscWsUrl,
      fdsnUrl: config.emscFdsnUrl,
    }),
  );
}

const api = createApi(relay, config);

api.server.listen(config.port, config.host, () => {
  const started = store.count;
  console.log(`Seismic Earth relay → http://${config.host}:${config.port}`);
  console.log(`  sources   ${[config.usgsEnabled && 'USGS (poll)', config.emscEnabled && 'EMSC (stream)'].filter(Boolean).join(' + ') || 'none'}`);
  console.log(`  database  ${config.dbPath}${started > 0 ? ` (${started.toLocaleString()} events carried over)` : ''}`);
  console.log(`  browser   open the app and it will use this relay automatically`);
});

void relay.start().then(() => {
  const s = relay.status();
  console.log(`  ready     ${s.events.toLocaleString()} events, ${s.merged.toLocaleString()} seen by both networks`);
  for (const source of s.sources) {
    const state = source.connected ? 'connected' : (source.lastError ?? 'not connected');
    console.log(`            ${source.name.toUpperCase()}: ${source.received.toLocaleString()} reports, ${state}`);
  }
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down…');
    void (async () => {
      await relay.stop();
      await api.close();
      store.close();
      process.exit(0);
    })();
  });
}

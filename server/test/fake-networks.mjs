/**
 * Stand-ins for the USGS and EMSC services, so the relay can be exercised
 * without waiting for a real earthquake (or an internet connection).
 *
 *   node server/test/fake-networks.mjs
 *   DB_PATH=server/data/demo.db \
 *     USGS_FEED_URL=http://127.0.0.1:9101/summary USGS_FDSN_URL=http://127.0.0.1:9101/fdsn \
 *     EMSC_WS_URL=ws://127.0.0.1:9102 EMSC_FDSN_URL=http://127.0.0.1:9101/emsc-fdsn \
 *     npm run server
 *
 * Then drive it:
 *   POST /control/emsc        an EMSC WebSocket message, pushed to the relay
 *   POST /control/usgs        replace what the USGS summary feed returns
 *   POST /control/drop-emsc   close the stream (the relay should reconnect)
 *   POST /control/stop-emsc   take the EMSC server down entirely
 *   POST /control/start-emsc  bring it back
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const state = { usgs: { type: 'FeatureCollection', metadata: {}, features: [] } };
const emscClients = new Set();

const http = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('access-control-allow-origin', '*');
  if (url.pathname === '/control/usgs' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.usgs = JSON.parse(body);
      res.writeHead(200).end('ok');
    });
    return;
  }
  if (url.pathname === '/control/emsc' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      for (const ws of emscClients) ws.send(body);
      res.writeHead(200).end(String(emscClients.size));
    });
    return;
  }
  if (url.pathname === '/control/stop-emsc' && req.method === 'POST') {
    wss.close();
    res.writeHead(200).end('ok');
    return;
  }
  if (url.pathname === '/control/start-emsc' && req.method === 'POST') {
    startEmsc();
    res.writeHead(200).end('ok');
    return;
  }
  if (url.pathname === '/control/drop-emsc' && req.method === 'POST') {
    for (const ws of emscClients) ws.close();
    res.writeHead(200).end('ok');
    return;
  }
  if (url.pathname === '/emsc-fdsn') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'FeatureCollection', features: [] }));
    return;
  }
  if (url.pathname === '/fdsn') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'FeatureCollection', features: [] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state.usgs));
});
http.listen(9101, '127.0.0.1', () => console.log('fake-networks http on 9101'));

let wss;
function startEmsc() {
  wss = new WebSocketServer({ port: 9102, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    emscClients.add(ws);
    ws.on('close', () => emscClients.delete(ws));
  });
  wss.on('error', () => {});
}
startEmsc();
console.log('fake EMSC ws on 9102');

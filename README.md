# Seismic Earth

A real-time, GPU-rendered planet where earthquakes stream in from global seismic networks, sink to their true depth to reveal subducting tectonic plates, and send seismic waves across the surface.

Built with **raw WebGPU** (no engine), **WGSL** shaders and **TypeScript**.

> **Status: Phase 5 — Showpiece.** A WebGPU globe of the world's earthquakes, a cutaway view that sinks each quake to its true depth to reveal subducting slabs, a relay service that merges EMSC's push stream with USGS, and a time machine that replays real sequences — Tōhoku, Illapel, Gorkha — with the P and S wavefronts spreading from each epicentre at the speed the travel-time tables say they did.

---

## Run it

Requires **Node.js 22.12 or newer** and a WebGPU browser (current Chrome, Edge, Firefox or Safari).

```bash
npm install
npm run dev        # opens http://localhost:5173 — the globe, polling USGS directly
```

That is the whole app. The relay is optional: run it and the globe switches to
it automatically, for live pushes and both networks merged.

```bash
npm run dev:all    # the relay and the web app together
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Web app with instant reload (no server needed) |
| `npm run server` | The relay on `http://localhost:8787` |
| `npm run dev:all` | Both at once |
| `npm test` | All 175 tests (Vitest) |
| `npm run typecheck` | TypeScript check, no output files |
| `npm run build` | Type-check, then build a static site into `dist/` |
| `npm run preview` | Serve the built `dist/` locally |

The relay needs no build step and no native modules: Node runs its TypeScript
directly, and storage uses Node's own SQLite.

### Controls

| Input | Action |
| --- | --- |
| Drag (mouse, touch, pen) | Rotate the globe; release mid-drag to fling it |
| Scroll / pinch | Zoom |
| Hover a quake | Quick summary |
| Click a quake | Details card (click empty space or press <kbd>Esc</kbd> to close) |
| Click a row in "Strongest" | Fly there and open its details |
| Subduction zones (panel) | Fly beside a slab and look along its trench, in cutaway |
| Time machine (panel) | Replay a real sequence; transport bar appears at the bottom |
| <kbd>C</kbd> | Toggle cutaway |
| <kbd>W</kbd> | Toggle the seismic wavefronts |
| <kbd>R</kbd> | Back to the globe view |
| <kbd>Space</kbd> | Toggle the idle auto-spin |

Views are shareable: every setting lives in the URL, e.g. `?feed=year&view=cutaway&dx=2&sun=studio&plates=0`.
A replay has one too — `?replay=tohoku` opens straight into it.
Add `?relay=off` to ignore a running relay, or `?relay=http://host:8787` to use one elsewhere.

**Best first look:** **Time machine → Tōhoku**. The clock starts six minutes before
the M9.0 of 11 March 2011; watch the blue P front pull away from the orange S front
and cross the Pacific, then the aftershocks arrive in their hundreds.

**Second look:** pick **1 y**, switch to **Cutaway**, then click **Tonga** under Subduction zones.

---

## Deploy (GitHub Pages)

The workflow runs the tests, builds, and publishes `main` to GitHub Pages. GitHub only runs workflows from `.github/workflows/`, so the first time, move it there:

```powershell
# Windows PowerShell, in the project folder
New-Item -ItemType Directory -Force .github\workflows | Out-Null
Move-Item deploy\github-pages.yml .github\workflows\deploy.yml
```

1. Create a GitHub repository and push this folder to its `main` branch.
2. In the repository: **Settings → Pages → Source: GitHub Actions**.
3. Every push to `main` now redeploys. The URL is shown on the workflow run and in Settings → Pages (usually `https://<user>.github.io/<repo>/`).

The build uses relative paths (`base: './'` in `vite.config.ts`), so the same `dist/` also works on Cloudflare Pages, Netlify or any static host.

---

---

## The relay

`npm run dev` is the whole app: the browser polls USGS itself and needs no
server. The relay adds what a browser cannot do on its own.

| | Browser alone | With the relay |
| --- | --- | --- |
| Networks | USGS | USGS **+ EMSC** |
| New quakes | next poll, up to 60 s | **pushed**, typically under a second |
| Magnitude | whatever USGS reports | the better of the two scales |
| History | the feed's own window | everything the relay has stored |

```bash
npm run server       # http://localhost:8787
```

Open the app and it finds the relay by itself; the status line changes from
`Live · USGS` to `Live · USGS + EMSC`. Clicking a quake that both networks saw
shows each one's own solution and which was used.

| Setting | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `DB_PATH` | `server/data/seismic.db` | Where history is kept |
| `HISTORY_DAYS` | `30` | How far back to backfill at start-up |
| `RETENTION_DAYS` | `90` | How long to keep events |
| `BACKFILL_MIN_MAG` | `2.5` | Smallest magnitude worth backfilling (live events are never filtered) |
| `EMSC` / `USGS` | `on` | Set either to `off` to run on one network |
| `ALLOWED_ORIGINS` | localhost dev ports | Browser origins allowed to connect |

### Endpoints

```
GET  /health          relay and per-network status
GET  /events?from&to&minMag&limit
GET  /events/:id      one event with every network report behind it
WS   /live            subscribe to a window; snapshot, then changes as they happen
```

### Seeing a merge without waiting for an earthquake

Two networks reporting the same quake is the thing worth demonstrating, and
real ones do not arrive on cue. `server/test/fake-networks.mjs` stands in for
both services so you can push events by hand — see the comment at the top of
that file for the commands.

### A caveat worth knowing

The EMSC message format is built from their published documentation, not from a
recorded live session — nothing here has been run against the real socket yet.
The parser is defensive and the tests cover the documented shape, but the first
thing to check when you run it for real is the `EMSC` line in `/health`: if
`rejected` climbs while `received` stays at zero, the shape differs and
`server/src/normalize.ts` is the one place to fix it.

---

## Phase checklist

**Phase 1 — Foundations** ✅
- [x] WebGPU device and canvas setup with a clear message when WebGPU is missing
- [x] Textured Earth with GPU-generated mipmaps, 4× MSAA, linear-light shading
- [x] Quaternion orbit camera: free rotation over the poles, fling inertia, smooth zoom, north-up settling, idle spin

**Phase 2 — MVP** ✅
- [x] USGS GeoJSON feeds fetched straight from the browser: past hour, day, 7 days, 30 days (M2.5+)
- [x] Defensive parsing: malformed features are skipped and counted, never fatal
- [x] Polling every 60 s with snapshot diffing (new / revised / expired events), paused in background tabs
- [x] Offline fallback: a bundled real USGS week (Feb 2018) when the live feed can't be reached
- [x] One instanced draw call for every quake: size by magnitude, colour by depth, older events fade
- [x] Recent quakes (< 1 h) pulse; new arrivals during the session raise a notification
- [x] Horizon culling in the vertex shader (no z-fighting with the surface)
- [x] CPU picking for hover tooltips and click-to-inspect, with a details card linking to USGS
- [x] Quaternion-slerp fly-to; magnitude filter; depth and size legends; strongest-events list
- [x] Phone layout (panel and card share a bottom sheet)
- [x] GitHub Actions: test → build → deploy to Pages
- [x] 62 unit tests (parser, store diffing, polling and fallback, packing, colour ramp, picking, camera, formatting)
- [ ] **Gate:** public demo link works → push to GitHub and enable Pages

**Phase 3 — Depth and science** ✅
- [x] Cutaway view: every quake sinks to its true depth, with ×1 / ×2 / ×3 depth exaggeration, animated in and out
- [x] Translucent crust (more opaque at the rim) and the outer core at 2,890 km for scale
- [x] Quakes on the far side stay visible through the crust but dimmed; the core hides what's behind it
- [x] Slab tours: Japan, Tonga, Andes and Marianas, seen edge-on along each trench
- [x] Camera look-at target (orbit any point, not just the centre), kept above the surface
- [x] Focus fade in slab views, so neighbouring slabs don't crowd the line of sight
- [x] Plate boundaries from PB2002 (5,824 segments), one instanced draw, by type: convergent, divergent, transform
- [x] Real sun from the UTC time, night side with city lights and a twilight band; Studio light still available
- [x] Past-year M4.5+ window from the USGS FDSN event API (~7,000 events), refreshed every 10 min
- [x] Offline sample per window: Feb 2018 week for short windows, the full 2015 M4.5+ year for 30 d / 1 y
- [x] Picking matches the shader in every view: true-depth positions, core occlusion, nearest-first, focus
- [x] Every setting in the URL; keyboard shortcuts keep working after clicking a control
- [x] 94 unit tests (adds solar position, plate data, true-depth placement, core occlusion, slab views, URL settings)
- [x] **Gate:** subduction slabs visible under Japan — at ×2 the Pacific slab is a clear sheet dipping west

**Phase 4 — Live pipeline** ✅
- [x] Relay service: EMSC's WebSocket stream + USGS polling, merged into one catalogue
- [x] Deduplication by shared identifier first, then a time/distance/magnitude ellipsoid
- [x] Preferred solution per event: moment magnitude over local scales, reviewed over automatic, more stations over fewer
- [x] Never a blended hypocentre — position, depth and time always come from one network's solution
- [x] SQLite history (Node's built-in, no native module), surviving restarts
- [x] REST API (`/health`, `/events`, `/events/:id`) and a `/live` WebSocket with per-client windows
- [x] Reconnect with exponential backoff and jitter; a silent socket is treated as dead; gaps refilled from FDSN
- [x] Browser picks the relay when it is running and falls back to direct USGS when it is not
- [x] Detail card shows every network that reported the quake, and which solution was used
- [x] Status line names the live networks and says when one is reconnecting
- [x] 141 tests, including the relay running end to end against stand-in networks
- [x] **Gate:** a quake pushed by EMSC and then published by USGS appears once, with both solutions on its card

**Phase 5 — Showpiece** ✅
- [x] P and S wavefronts from the USGS travel-time tables, interpolated on the GPU — not a constant-speed ripple
- [x] Compute shader scans every quake each frame and compacts the still-radiating ones into a short list with an atomic counter
- [x] Each pixel asks when the wave reaches *it*, so both fronts curve correctly without inverting the table
- [x] Time machine: Tōhoku 2011, Illapel 2015, Gorkha 2015 and Hualien 2018, replayed from the real catalogue
- [x] Transport bar: play/pause, scrub, ×1 / ×15 / ×45 / ×120, and the data clock in UTC; `?replay=tohoku` in the URL
- [x] A replay drives the same snapshot pipeline as the live feed, so markers, toasts, cards and fronts all behave identically
- [x] Statistics panel: Gutenberg–Richter plot with the fitted law drawn over it, depth histogram, released energy, median depth
- [x] Completeness by goodness of fit (Wiemer & Wyss), so a mixed-coverage window is flagged rather than given a meaningless slope
- [x] 175 tests (adds travel times, replay clock and windowing, catalogue statistics)
- [x] **Gate:** at 45×, the P front from the M9.0 reaches the far side of the Pacific in about twenty seconds of watching — and the readback confirms the compute pass found it

---

## How it works

The app runs either of two ways, and nothing downstream of the feed can tell
which — both satisfy the same `QuakeFeed` interface.

**Without the relay** (what the deployed demo does):

```
USGS GeoJSON ──poll every 60 s──▶ LiveFeed ──▶ QuakeStore ──diff──▶ renderer + UI
                                   └─ bundled sample if unreachable
```

**With the relay** (`npm run server`):

```
EMSC WebSocket ──push──┐
                       ├─▶ merge ──▶ SQLite ──▶ /live WebSocket ──▶ RelayFeed ──▶ QuakeStore ──▶ renderer + UI
USGS feed ──poll───────┘      │
                        one event per quake,
                        both solutions kept
```

```
src/
  main.ts                    Wires data, scene and UI together; frame loop
  data/
    quake.ts                 The app's own earthquake type (all sources normalise to it)
    usgs.ts                  USGS feed URLs and a defensive GeoJSON parser
    QuakeStore.ts            Current events + snapshot diffing (added / updated / removed)
    LiveFeed.ts              Polling, timeouts, stale-response guard, offline fallback
    RelayFeed.ts             WebSocket client for the relay: snapshot, then pushes
    feed.ts                  The interface both feeds satisfy, and relay discovery
    pack.ts                  Quake → 32-byte GPU instance
    ReplayFeed.ts            Replays a slice of the catalogue as if it were live
    replay.ts                The time machine's destinations
    statistics.ts            Gutenberg–Richter, completeness, depth mix, released energy
    plates.ts                PB2002 plate boundaries: parsing, styles, GPU segments
  render/
    SceneRenderer.ts         Render targets + the single render pass all layers draw into
    FrameUniforms.ts         Camera/light/viewport/scene uniforms shared by every layer (bind group 0)
    CoreLayer.ts             The outer core, shown in cutaway
    GlobeLayer.ts            The crust: opaque, or a translucent shell in cutaway
    PlateLayer.ts            Plate boundaries as instanced screen-space lines
    QuakeLayer.ts            Instanced earthquake markers
    WaveLayer.ts             P/S wavefronts: a compute scan, then one additive pass over the globe
    markerStyle.ts           Depth colour ramp and magnitude size curve (one source of truth)
    shaders/                 frame.wgsl (shared), core, globe, plates, quakes, waveScan (compute), waves
  geo/
    coords.ts                lat/lon/depth ↔ 3D, UVs, great-circle distance
    sphere.ts                UV sphere mesh
    sun.ts                   Subsolar point from the UTC time
    travelTime.ts            USGS P and S travel-time tables, interpolation, GPU packing
    picking.ts               True-depth placement, horizon and core tests, marker picking
  camera/
    OrbitCamera.ts           Quaternion camera with a look-at target, fly-to (DOM-free, unit-tested)
    slabViews.ts             The subduction-zone tours
    CameraController.ts      Pointer, wheel, pinch and keyboard input
  gpu/                       Device setup, textures, mipmap generation
  ui/                        Panel, overlays (card, tooltip, toast, status), picking input, URL settings, formatting
server/
  src/
    index.ts                 Entry point: config, wiring, graceful shutdown
    config.ts                Settings, all overridable by environment variable
    types.ts                 SourceEvent (one network's report) and MergedEvent
    normalize.ts             USGS and EMSC payloads → SourceEvent, defensively
    merge.ts                 Matching and preferred-solution rules
    store.ts                 SQLite schema and queries
    relay.ts                 Reports in, merged events out; batching and pruning
    hub.ts                   Connected browsers and their windows
    api.ts                   HTTP routes and the /live WebSocket
    sources/usgs.ts          Polling and FDSN backfill
    sources/emsc.ts          WebSocket stream, reconnect, silence detection
  test/                      Unit tests, an end-to-end test, and stand-in networks
tests/                       Vitest unit tests + a real USGS fixture
public/
  textures/                  Earth day, water mask, night lights
  data/                      Plate boundaries; offline samples (USGS week of Feb 2018, 2015 M4.5+, Tōhoku 9–18 Mar 2011)
```

## Design decisions

**World frame.** Right-handed, Y up: +Y is the North Pole, +Z is 0° N 0° E, +X is 0° N 90° E. One unit = one Earth radius (6,371 km). Everything that places something on the planet goes through `src/geo/coords.ts`. GeoJSON stores `[longitude, latitude, depth]`; the parser is the one place that order is handled.

**One draw call for all earthquakes.** Each quake is a 32-byte instance (position, magnitude, depth, time, flags). The vertex shader expands it into a camera-facing quad; the fragment shader carves out the disc, a dark outline (so markers read on bright desert and ice), the pulse ring and the hover/selection ring. Thousands of markers cost one draw call.

**Waves are asked backwards.** The obvious way to draw an expanding front is to work out where it is now and test every pixel against a moving circle — which means inverting the travel-time table every frame, and gets the curvature wrong as soon as the front is large enough to matter. Instead each pixel measures its own angular distance from the epicentre and looks up when the wave arrives *there*; it lights up when the elapsed time matches. One table lookup per pixel per front, both fronts from the same lookup, and the curvature is right because the table already knows that a ray diving deeper travels faster.

**The scan is a compute pass, not a CPU filter.** Only a handful of quakes are radiating at any moment, but finding them means checking all of them — tens of thousands in the year window. The data is already on the GPU for the markers, so a compute shader walks the same instance buffer and compacts the live ones into a 16-slot list with an atomic counter. The counter is allowed to overshoot; the renderer clamps what it reads, so a violent minute draws the first sixteen fronts rather than overflowing anything.

**A replay is a feed.** The time machine does not get a rendering mode of its own. `ReplayFeed` satisfies the same `QuakeFeed` interface as the live sources and emits the same snapshot events, so markers, toasts, the detail card, the statistics and the wavefronts all behave exactly as they do on the real stream — the only difference is which clock `dataNow()` reads. Because the events are sorted by time, what is on screen is a contiguous slice of the catalogue, and advancing the clock moves two indices rather than rescanning.

**Statistics that admit when they are meaningless.** A worldwide "all magnitudes" window mixes a dense Californian network that records M1 with global coverage that misses anything under about M4.5. Fit one Gutenberg–Richter slope across that and you get b ≈ 0.3, which is not physics — it is a map of who was listening. So the completeness magnitude is chosen by goodness of fit rather than by the fullest bin, and when no threshold explains 90% of the distribution the panel says *mixed coverage — not one population* instead of printing a confident number.

**Size in screen pixels.** Marker radius = 4 px × 1.5^(M − 4), clamped, with a gentle zoom factor. It's perceptual, not physical: energy grows ~32× per magnitude unit, so energy-true sizes would make an M7 a million times bigger than an M3 and hide every small quake.

**Colour by depth.** Analogous warm hues whose perceptual lightness (OKLab L 0.91 → 0.54) falls steadily from shallow to deep, with stops at the standard depth classes (shallow < 70 km, intermediate 70–300, deep 300–700). The shader, the legend and the badges all read the same stops from `markerStyle.ts`.

**Horizon culling instead of depth testing.** Markers sit exactly on the surface, so depth-testing them against the globe would flicker (z-fighting). The vertex shader instead hides any point whose angle from the camera is beyond the horizon (`dot(p, eye/|eye|) > 1/|eye|`) and fades markers near the limb. The CPU picker uses the same test, so you can't click a quake on the far side.

**Float precision for time.** A float32 can't hold "milliseconds since 1970" precisely, so times are uploaded as seconds relative to the moment of upload.

**Snapshot diffing.** Each USGS refresh is a complete snapshot of the window. Comparing ids and `updated` timestamps gives new, revised (agencies refine magnitude and location in the first hours) and expired events. That drives the notifications and keeps an open details card current.

**Cutaway draw order.** The core is drawn first and writes depth. The crust follows as a translucent shell: it is depth-tested against the core but writes no depth, so the quakes drawn after it still show through. The markers switch to a depth-tested pipeline, so the core hides those behind it. One shared `quake_radius()` in `frame.wgsl` places quakes for every shader, and `picking.ts` mirrors it, so what you see is what you can click.

**Looking across a slab, not down on it.** From above, a slab's quakes only differ in colour. Edge-on, looking along the trench, they line up into a dipping sheet (the Wadati–Benioff zone). The camera orbits a look-at target that can sit inside the planet; each tour puts it at the slab's middle depth and looks along the trench. A focus fade drops quakes more than ~1,000 km from the region, so other slabs along the line of sight don't crowd the view (like the swath a seismologist projects onto a cross-section).

**Real sun.** The subsolar point comes from the Astronomical Almanac's low-precision solar formulas: declination from the sun's ecliptic longitude, and longitude from the right ascension minus Greenwich sidereal time. Tests check it against the equinox, both solstices and the equation of time. Because the world frame is Earth-fixed, the sun direction is simply the vector to that point.

**Two networks, one earthquake.** USGS and EMSC detect the same quakes
independently, and their solutions never agree exactly — origin times differ by
seconds, epicentres by tens of kilometres, magnitudes by tenths because the
networks use different scales. The relay matches a new report against what it
knows in two passes: a shared identifier settles it outright (USGS publishes
every id it knows for an event), and otherwise the report must fall inside an
ellipsoid of time, distance *and* magnitude at once — 45 s, 350 km, 1.5
magnitude units on the three axes. Two reports from the *same* network are
never merged: a network does not publish one quake twice, and that guard is
what keeps a dense aftershock sequence intact. Checked against the real 2015
Nepal sequence, only one pair of genuinely distinct events falls inside the
gates on the numbers alone — and both are USGS, so the guard catches it.

**Which solution to believe.** Once two reports are one event, the relay does
not average them. Position, depth and origin time come from a single network's
solution, because mixing a latitude from one agency with a depth from another
invents a hypocentre nobody computed; it prefers reviewed over automatic, then
more stations, then the global catalogue. The magnitude is chosen separately —
moment magnitude first, since it measures the energy released and does not
saturate for large quakes, which is why USGS itself prefers it. The detail card
shows both solutions and marks which one was used, so the choice is visible
rather than hidden.

**Assume the stream will break.** A WebSocket held open for days fails in ways
a request does not: it drops, and it also goes quiet while still looking open.
The relay reconnects with exponential backoff and jitter, treats a long silence
as a failure, and refills whatever it missed from EMSC's FDSN service on
reconnect — so an outage costs latency, not data. Tearing down a half-open
socket needs its own care: `ws` emits one last error, and without a listener
that takes the process down, which is exactly when the network is flapping.

**Never an empty globe.** If the live feed can't be reached on the first load, a bundled real week of USGS data is shown and clearly labelled, and the live feed keeps being retried.

## Roadmap

1. **Foundations** — textured globe and orbit camera ✅
2. **MVP** — live USGS feed, instanced markers, picking, deploy ✅ (deploy: your push)
3. **Depth and science** — cutaway with true depth, slab tours, plate boundaries, real sun ✅
4. **Live pipeline** — relay merging EMSC + USGS, WebSocket push, history in SQLite ✅
5. **Showpiece** — compute-shader P/S waves, historical replays, statistics panel ✅
6. **Polish** — atmosphere, performance write-up, demo GIF

## Credits

- Earthquake data: [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/) real-time feeds and FDSN event service (public domain). Offline samples: a USGS "all week" snapshot from 1–7 Feb 2018, via [vega-datasets](https://github.com/vega/vega-datasets), and the USGS worldwide catalogs, via [helloworlddata/usgs-earthquakes](https://github.com/helloworlddata/usgs-earthquakes) — the 2015 M4.5+ year, and M4.0+ for 9–18 March 2011, which is the Tōhoku replay.
- Seismic travel times: USGS Earthquake Hazards Program, ["Earthquake travel times"](https://www.usgs.gov/programs/earthquake-hazards/earthquake-travel-times) — P and S arrival times for a 33 km source, every 5° of epicentral distance.
- Completeness estimate: Wiemer, S. & Wyss, M. (2000), *Minimum magnitude of completeness in earthquake catalogs*, Bulletin of the Seismological Society of America 90(4), 859–869. Slope estimate: Aki, K. (1965) and Utsu, T. (1965).
- EMSC real-time service: [Euro-Mediterranean Seismological Centre](https://www.emsc-csem.org/), via the [SeismicPortal](https://www.seismicportal.eu/realtime.html) WebSocket and FDSN services.
- Plate boundaries: Bird, P. (2003), *An updated digital model of plate boundaries*, Geochemistry, Geophysics, Geosystems 4(3), 1027 — PB2002, via [fraxen/tectonicplates](https://github.com/fraxen/tectonicplates).
- Earth imagery: NASA Visible Earth / Blue Marble and Black Marble (public domain), via the [three-globe](https://github.com/vasturiano/three-globe) example assets.

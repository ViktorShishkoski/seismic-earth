# Development log

Seismic Earth was built in five passes, each one ending at a check that either
held or sent the work back. Kept here because the gates are the interesting
part: what had to be true before the next phase could start.

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

**Phase 6 — Polish** (open)
- [ ] Atmospheric scattering on the limb
- [ ] A written performance pass: frame budget, where the milliseconds go
- [ ] Omori's law fitted to the Tōhoku aftershock sequence in the statistics panel

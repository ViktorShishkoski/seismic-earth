import './style.css';
import { mat4, vec3 } from 'gl-matrix';
import { initGpu, observeCanvasSize, WebGPUUnavailableError } from './gpu/device.ts';
import { MipmapGenerator } from './gpu/mipmaps.ts';
import { loadTexture } from './gpu/texture.ts';
import { latLonToCartesian } from './geo/coords.ts';
import { createSphere } from './geo/sphere.ts';
import { pickMarker } from './geo/picking.ts';
import { subsolarPoint } from './geo/sun.ts';
import { OrbitCamera } from './camera/OrbitCamera.ts';
import { CameraController } from './camera/CameraController.ts';
import { SLAB_VIEWS, slabCameraView } from './camera/slabViews.ts';
import { SceneRenderer } from './render/SceneRenderer.ts';
import { GlobeLayer } from './render/GlobeLayer.ts';
import { CoreLayer } from './render/CoreLayer.ts';
import { PlateLayer } from './render/PlateLayer.ts';
import { QuakeLayer } from './render/QuakeLayer.ts';
import { WaveLayer } from './render/WaveLayer.ts';
import { QuakeStore, type QuakeFilter } from './data/QuakeStore.ts';
import { LiveFeed } from './data/LiveFeed.ts';
import { RelayFeed } from './data/RelayFeed.ts';
import { ReplayFeed } from './data/ReplayFeed.ts';
import { replayPresets, type ReplayPreset } from './data/replay.ts';
import { relayAvailable, relayUrl, type FeedSnapshotEvent, type QuakeFeed } from './data/feed.ts';
import { fetchGeoJson, type FeedId } from './data/usgs.ts';
import { loadPlateBoundaries } from './data/plates.ts';
import type { Quake } from './data/quake.ts';
import { FrameStats, describeAdapter, showFallback } from './ui/hud.ts';
import { Panel, isNarrowScreen } from './ui/Panel.ts';
import { DetailCard, StatusLine, Toast, Tooltip } from './ui/Overlays.ts';
import { PointerPicking } from './ui/PointerPicking.ts';
import { Stats } from './ui/Stats.ts';
import { TimeMachine } from './ui/TimeMachine.ts';
import { parseSettings, serializeSettings } from './ui/urlState.ts';

const BASE = import.meta.env.BASE_URL;
const TOAST_MIN_MAG = 2.5;

/** Bundled data shown when the live feed can't be reached: a real USGS snapshot that matches the window. */
const SAMPLES = {
  week: { url: `${BASE}data/usgs-sample-2018-02.geojson`, label: '1–7 Feb 2018' },
  year: { url: `${BASE}data/usgs-sample-2015-m45.geojson`, label: '2015, M4.5+' },
};
const sampleFor = (feed: FeedId) => (feed === 'month' || feed === 'year' ? SAMPLES.year : SAMPLES.week);

/** How long each window is, in seconds: older events fade over the last 90% of it. */
const WINDOW_SEC: Record<FeedId, number> = {
  hour: 3600,
  day: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400,
  year: 365 * 86_400,
};

async function main(): Promise<void> {
  const canvas = document.getElementById('globe') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('Missing <canvas id="globe">');

  // ── GPU ────────────────────────────────────────────────────────────────
  const gpu = await initGpu(canvas);
  const gpuLabel = document.getElementById('stat-gpu');
  if (gpuLabel) gpuLabel.textContent = describeAdapter(gpu.adapterInfo);
  gpu.device.lost.then((info) => {
    if (info.reason !== 'destroyed') showFallback(`The GPU device was lost: ${info.message}`);
  });

  // The textures are the slowest thing to load, so start them before anything
  // that has to wait on the network.
  const mips = new MipmapGenerator(gpu.device);
  const texturesReady = Promise.all([
    loadTexture(gpu.device, mips, `${BASE}textures/earth-day.jpg`, { srgb: true, label: 'earth day', fallback: [40, 80, 140, 255] }),
    loadTexture(gpu.device, mips, `${BASE}textures/earth-water.png`, { srgb: false, label: 'water mask', fallback: [0, 0, 0, 255] }),
    loadTexture(gpu.device, mips, `${BASE}textures/earth-night.jpg`, { srgb: true, label: 'night lights', fallback: [0, 0, 0, 255] }),
  ]);
  const platesReady = loadPlateBoundaries(`${BASE}data/plate-boundaries.json`);

  // ── State shared by the data, the scene and the UI ─────────────────────
  const settings = parseSettings(location.search);
  const filter: QuakeFilter = { minMag: settings.minMag, includeNonEarthquakes: false };
  const store = new QuakeStore();
  // Prefer the relay in `server/` when it is running: it merges EMSC's push
  // stream with USGS and sends changes the moment they happen. Without it the
  // browser polls USGS itself, which is what the deployed demo does.
  const relay = relayUrl();
  const liveFeed: QuakeFeed =
    relay && (await relayAvailable(relay))
      ? new RelayFeed(store, relay)
      : new LiveFeed(store, { loadSample: (id) => fetchGeoJson(sampleFor(id).url) });
  /** Whichever feed is driving the globe: the live one, or a replay of the past. */
  let feed: QuakeFeed = liveFeed;
  let replay: ReplayFeed | null = null;
  /** Ids that arrived during this session (they pulse until they're an hour old). */
  const arrivedIds = new Set<string>();
  let selectedId: string | null = null;

  /** Values that animate toward the settings, so mode switches glide instead of jumping. */
  const live = {
    cutaway: settings.view === 'cutaway' ? 1 : 0,
    depthScale: settings.depthScale as number,
    night: settings.sun === 'real' ? 1 : 0,
  };

  /** The region a slab view concentrates on (quakes outside it fade). */
  const focus = { dir: vec3.fromValues(0, 0, 1), radiusKm: 1000 };

  /**
   * "Now" on the data's clock: real time when live, the sample's own time when
   * offline, and the replay cursor when replaying. Ages, fades and wavefronts
   * are all measured from this rather than from the wall clock.
   */
  const dataNow = () =>
    (feed.status.mode === 'sample' || feed.status.mode === 'replay') && feed.status.generated
      ? feed.status.generated
      : Date.now();

  const saveUrl = () => history.replaceState(null, '', `${location.pathname}${serializeSettings(settings)}${location.hash}`);

  // ── Scene ──────────────────────────────────────────────────────────────
  // Start the data flowing while the textures decode.
  void feed.start(settings.feed);

  const [day, water, night] = await texturesReady;
  const scene = new SceneRenderer(gpu);
  // Draw order matters: the core first (it hides the far side in cutaway), then the crust
  // (opaque, or a translucent shell in cutaway), then the lines and markers on top.
  scene.add(new CoreLayer(gpu, scene.frame));
  scene.add(new GlobeLayer(gpu, scene.frame, createSphere(128, 256), { day: day.texture, water: water.texture, night: night.texture }));
  const plateLayer = new PlateLayer(gpu, scene.frame);
  plateLayer.visible = settings.plates;
  scene.add(plateLayer);
  const quakeLayer = new QuakeLayer(gpu, scene.frame);
  // The fronts read the markers' own instance buffer in a compute pass, so they
  // are added after the quake layer owns it but drawn before the markers.
  const waveLayer = new WaveLayer(gpu, scene.frame, createSphere(96, 192), quakeLayer);
  waveLayer.strength = settings.waves ? 1 : 0;
  scene.add(waveLayer);
  scene.add(quakeLayer);
  platesReady
    .then((plates) => plateLayer.setBoundaries(plates))
    .catch((err) => console.warn('[plates] could not load plate boundaries:', err));

  // Open over the Pacific Ring of Fire, where most of the world's earthquakes happen.
  const camera = new OrbitCamera({ lat: 22, lon: -175, distance: 3.6 });
  const controller = new CameraController(canvas, camera);
  observeCanvasSize(gpu, (w, h) => scene.resize(w, h));

  // ── UI ─────────────────────────────────────────────────────────────────
  const tooltip = new Tooltip();
  const toast = new Toast((q) => select(q, true));
  const card = new DetailCard(
    () => select(null),
    (q) => camera.flyTo(q.lat, q.lon),
  );
  const status = new StatusLine(() => void feed.refresh());
  const statsPanel = new Stats();
  const renderStatus = () =>
    status.render(feed.status, sampleFor(feed.status.feed).label, replay ? `${replay.preset.name} ${replay.preset.when}` : '');

  function setFeed(id: FeedId): void {
    if (replay) goLive();
    if (id === feed.status.feed) return;
    select(null);
    arrivedIds.clear();
    settings.feed = id;
    panel.setFeed(id);
    applyFade();
    saveUrl();
    void feed.start(id);
  }

  function setView(view: 'surface' | 'cutaway'): void {
    settings.view = view;
    panel.setViewMode(view);
    saveUrl();
  }

  const panel = new Panel({
    onFeedChange: setFeed,
    onMinMagChange: (minMag) => {
      filter.minMag = settings.minMag = minMag;
      saveUrl();
      rebuild();
    },
    onPick: (q) => select(q, true),
    onViewModeChange: setView,
    onDepthScaleChange: (scale) => {
      settings.depthScale = scale;
      panel.setDepthScale(scale);
      saveUrl();
    },
    onSlabView: (id) => {
      const view = SLAB_VIEWS.find((v) => v.id === id);
      if (!view) return;
      if (replay) goLive();
      select(null);
      // Slabs need density: short windows hold too few deep quakes to trace one.
      if (settings.feed !== 'year' && settings.feed !== 'month') setFeed('year');
      if (settings.view !== 'cutaway') setView('cutaway');
      focus.radiusKm = view.focusKm;
      vec3.set(focus.dir, ...latLonToCartesian(view.lat, view.lon));
      quakeLayer.setFocus(focus.dir, focus.radiusKm);
      camera.flyToView(slabCameraView(view, settings.depthScale));
    },
    onSunModeChange: (mode) => {
      settings.sun = mode;
      panel.setSunMode(mode);
      updateSunHint();
      saveUrl();
    },
    onPlatesChange: (visible) => {
      settings.plates = plateLayer.visible = visible;
      saveUrl();
    },
    onWavesChange: (visible) => {
      settings.waves = visible;
      waveLayer.strength = visible ? 1 : 0;
      saveUrl();
    },
    onExpandOnNarrowScreen: () => select(null),
  });
  panel.setFeed(settings.feed);
  panel.setMinMag(settings.minMag);
  panel.setViewMode(settings.view);
  panel.setDepthScale(settings.depthScale);
  panel.setSunMode(settings.sun);
  panel.setPlates(settings.plates);
  panel.setWaves(settings.waves);

  // ── Time machine ───────────────────────────────────────────────────────
  const presets = replayPresets(BASE);
  /** The magnitude filter to restore when the replay ends. */
  let minMagBeforeReplay: number | null = null;
  const timeMachine = new TimeMachine(presets, {
    onReplay: (preset) => void startReplay(preset),
    onPlayPause: () => {
      if (!replay) return;
      if (replay.finished) replay.restart();
      else replay.playing = !replay.playing;
      timeMachine.setPlaying(replay.playing, replay.finished);
    },
    onSeek: (progress) => replay?.seek(progress),
    onSpeed: (speed) => {
      if (!replay) return;
      replay.speed = speed;
      timeMachine.setSpeed(speed);
    },
    onLive: goLive,
  });

  /**
   * Hands the globe over to a replay: the live feed stands down, the store is
   * emptied, and the catalogue slice is played back through the same snapshot
   * events the live feed uses.
   */
  async function startReplay(preset: ReplayPreset): Promise<void> {
    select(null);
    liveFeed.stop();
    replay?.dispose();
    arrivedIds.clear();
    store.clear();
    const next = new ReplayFeed(store, preset, { feedId: settings.feed });
    replay = next;
    feed = next;
    settings.replay = preset.id;
    // Each replay has a magnitude floor that suits its catalogue; the filter
    // the person had chosen is put back when they return to the present.
    minMagBeforeReplay ??= settings.minMag;
    filter.minMag = settings.minMag = preset.minMag;
    panel.setMinMag(preset.minMag);
    timeMachine.show(preset);
    timeMachine.setPlaying(true);
    attach(next);
    camera.flyTo(preset.camera.lat, preset.camera.lon, preset.camera.distance);
    camera.autoSpin = false;
    saveUrl();
    renderStatus();
    try {
      await next.start();
    } catch (error) {
      toast.message(`Could not load that replay: ${error instanceof Error ? error.message : String(error)}`);
      goLive();
    }
  }

  /** Back to the present. */
  function goLive(): void {
    if (!replay) return;
    replay.dispose();
    replay = null;
    feed = liveFeed;
    settings.replay = null;
    if (minMagBeforeReplay !== null) {
      filter.minMag = settings.minMag = minMagBeforeReplay;
      panel.setMinMag(minMagBeforeReplay);
      minMagBeforeReplay = null;
    }
    timeMachine.hide();
    select(null);
    arrivedIds.clear();
    store.clear();
    attach(liveFeed);
    camera.autoSpin = true;
    saveUrl();
    renderStatus();
    void liveFeed.start(settings.feed);
  }

  function applyFade(): void {
    const w = WINDOW_SEC[settings.feed];
    quakeLayer.setFade(w * 0.1, w);
  }
  applyFade();

  function updateSunHint(): void {
    const sun = subsolarPoint(Date.now());
    panel.setSunPoint(sun.lat, sun.lon, settings.sun);
  }
  updateSunHint();
  setInterval(updateSunHint, 30_000);

  /** Re-derives everything that depends on the store or the filter. */
  function rebuild(): void {
    const visible = store.visible(filter);
    quakeLayer.setQuakes(visible, dataNow(), arrivedIds);
    quakeLayer.selectedIndex = selectedId ? visible.findIndex((q) => q.id === selectedId) : -1;
    quakeLayer.hoveredIndex = -1;
    tooltip.hide();
    refreshPanel();
    statsDirty = true;
  }

  // A replay can change the set many times a second; the charts don't need to
  // keep up with that, so they redraw on a slower beat.
  let statsDirty = true;
  setInterval(() => {
    if (!statsDirty) return;
    statsDirty = false;
    statsPanel.render(quakeLayer.quakes);
  }, 500);

  function refreshPanel(): void {
    const visible = quakeLayer.quakes;
    const total = store.visible({ minMag: -Infinity, includeNonEarthquakes: false }).length;
    panel.update(visible.length, total, visible.slice(0, 5), dataNow());
  }

  function select(quake: Quake | null, fly = false): void {
    selectedId = quake?.id ?? null;
    quakeLayer.selectedIndex = quake ? quakeLayer.quakes.findIndex((q) => q.id === quake.id) : -1;
    camera.autoSpinHold = quake !== null;
    if (quake) {
      card.show(quake, dataNow());
      if (isNarrowScreen()) panel.collapse();
      if (fly) camera.flyTo(quake.lat, quake.lon);
    } else {
      card.hide();
    }
  }

  function onSnapshot({ diff, initial: isInitial }: FeedSnapshotEvent): void {
    if (!isInitial) {
      for (const q of diff.added) arrivedIds.add(q.id);
      const notable = diff.added
        .filter((q) => q.type === 'earthquake' && q.mag >= Math.max(TOAST_MIN_MAG, filter.minMag))
        .sort((a, b) => b.mag - a.mag);
      if (notable[0]) toast.show(notable[0], notable.length - 1);
    }
    rebuild();
    // Keep the card in sync with revisions, and close it if the event left the window.
    if (selectedId) {
      const fresh = store.get(selectedId);
      if (fresh) card.show(fresh, dataNow());
      else select(null);
    }
  }

  /** Points the UI at a feed, dropping the previous one's listeners. */
  let detach = () => {};
  function attach(source: QuakeFeed): void {
    detach();
    const offSnapshot = source.onSnapshot(onSnapshot);
    const offStatus = source.onStatus(renderStatus);
    detach = () => {
      offSnapshot();
      offStatus();
    };
  }
  attach(feed);
  if (settings.replay) {
    const preset = presets.find((p) => p.id === settings.replay);
    if (preset) void startReplay(preset);
  }
  // The feed started before the textures finished decoding, so a snapshot may
  // already have arrived and been missed: catch up on whatever is in the store.
  rebuild();
  renderStatus();
  setInterval(renderStatus, 1000);
  setInterval(refreshPanel, 30_000);

  // ── Picking ────────────────────────────────────────────────────────────
  const lastViewProj = mat4.create();
  const lastEye = vec3.create();
  new PointerPicking(canvas, {
    pick: (x, y) =>
      pickMarker(quakeLayer.quakes, lastViewProj, lastEye, canvas.clientWidth, canvas.clientHeight, { x, y }, {
        cutaway: live.cutaway,
        depthScale: live.depthScale,
        markerAltitude: camera.markerAltitude(),
        focus: { dir: focus.dir, radiusKm: focus.radiusKm, strength: camera.slabWeight() },
      }),
    onHover: (index, clientX, clientY) => {
      quakeLayer.hoveredIndex = index;
      canvas.classList.toggle('over-quake', index >= 0);
      const q = quakeLayer.quakes[index];
      if (q) tooltip.show(q, clientX, clientY, dataNow());
      else tooltip.hide();
    },
    onClick: (index) => select(quakeLayer.quakes[index] ?? null),
  });

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Escape') select(null);
    if (e.key === 'c' || e.key === 'C') setView(settings.view === 'cutaway' ? 'surface' : 'cutaway');
    if (e.key === 'w' || e.key === 'W') {
      const on = waveLayer.strength <= 0.001;
      settings.waves = on;
      waveLayer.strength = on ? 1 : 0;
      panel.setWaves(on);
      saveUrl();
    }
  });

  // ── Frame loop ─────────────────────────────────────────────────────────
  const stats = new FrameStats(document.getElementById('stat-fps'), document.getElementById('stat-ms'));
  const sunDir = vec3.create();
  const studioDir = vec3.create();
  const realDir = vec3.create();
  let last = performance.now();
  const start = last;
  let firstFrame = true;

  const frame = (now: number) => {
    const t0 = performance.now();
    const rawDt = (now - last) / 1000;
    const dt = Math.min(rawDt, 0.1); // clamp so a tab switch doesn't teleport the camera
    last = now;

    // The replay clock runs off the frame loop, so it pauses with the tab and
    // never outruns what has been drawn.
    if (replay) {
      const wasPlaying = replay.playing && !replay.finished;
      replay.tick(dt);
      timeMachine.update(replay.nowMs, replay.progress);
      if (wasPlaying && replay.finished) timeMachine.setPlaying(false, true);
    }

    camera.update(dt);

    // Ease the animated settings toward their targets (≈ 0.6 s).
    const ease = 1 - Math.exp(-dt * 6);
    live.cutaway += ((settings.view === 'cutaway' ? 1 : 0) - live.cutaway) * ease;
    live.depthScale += (settings.depthScale - live.depthScale) * ease;
    live.night += ((settings.sun === 'real' ? 1 : 0) - live.night) * ease;
    if (Math.abs(live.cutaway - Math.round(live.cutaway)) < 0.001) live.cutaway = Math.round(live.cutaway);

    // Studio light: fixed to the camera, upper-left. Real sun: the subsolar point right now.
    const { right, up, back } = camera.basis();
    vec3.zero(studioDir);
    vec3.scaleAndAdd(studioDir, studioDir, right, -0.55);
    vec3.scaleAndAdd(studioDir, studioDir, up, 0.45);
    vec3.scaleAndAdd(studioDir, studioDir, back, 0.7);
    vec3.normalize(studioDir, studioDir);
    const sun = subsolarPoint(Date.now());
    vec3.set(realDir, ...latLonToCartesian(sun.lat, sun.lon));
    vec3.lerp(sunDir, studioDir, realDir, live.night);
    vec3.normalize(sunDir, sunDir);

    const aspect = canvas.width / Math.max(canvas.height, 1);
    camera.viewProjection(aspect, lastViewProj);
    vec3.copy(lastEye, camera.eye);
    quakeLayer.dataNowSec = (dataNow() - quakeLayer.epochMs) / 1000;

    scene.render({
      viewProj: lastViewProj as Float32Array,
      cameraPos: lastEye,
      sunDir,
      time: (now - start) / 1000,
      exposure: 1.1,
      ambient: 0.035 + 0.025 * live.night, // a touch of moonlight so the night side isn't black
      width: canvas.width,
      height: canvas.height,
      pixelRatio: canvas.width / Math.max(canvas.clientWidth, 1),
      cutaway: live.cutaway,
      depthScale: live.depthScale,
      nightLights: live.night,
      markerAltitude: camera.markerAltitude(),
      focus: camera.slabWeight(),
    });

    stats.tick(rawDt, performance.now() - t0);
    if (firstFrame) {
      firstFrame = false;
      document.body.dataset.ready = 'true'; // lets automated tests know the globe is up
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Handy in the browser console: seismic.camera.autoSpin = false, seismic.select(...)
  Object.assign(window, {
    seismic: {
      gpu, camera, controller, scene, quakeLayer, waveLayer, plateLayer, store,
      filter, settings, live, select, presets,
      get feed() { return feed; },
      get replay() { return replay; },
      startReplay, goLive,
    },
  });
}

/** Text fields and sliders keep their keys; buttons and checkboxes don't block the shortcuts. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !['checkbox', 'radio', 'button'].includes(target.type);
}

main().catch((err: unknown) => {
  console.error(err);
  const reason =
    err instanceof WebGPUUnavailableError
      ? err.message
      : `Something went wrong while starting the renderer: ${err instanceof Error ? err.message : String(err)}`;
  showFallback(reason);
});

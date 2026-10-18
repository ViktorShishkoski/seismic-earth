import type { Quake } from '../data/quake.ts';
import { USGS_FEEDS, type FeedId } from '../data/usgs.ts';
import { BOUNDARY_STYLE, BOUNDARY_TYPES } from '../data/plates.ts';
import { SLAB_VIEWS } from '../camera/slabViews.ts';
import { DEPTH_STOPS, MARKER_SIZE, depthColorCss } from '../render/markerStyle.ts';
import { escapeHtml, formatCount, formatLatLon, formatMag, relativeTime } from './format.ts';

export type ViewMode = 'surface' | 'cutaway';
export type SunMode = 'real' | 'studio';
export const DEPTH_SCALES = [1, 2, 3] as const;
export type DepthScale = (typeof DEPTH_SCALES)[number];

export interface PanelCallbacks {
  onFeedChange(feed: FeedId): void;
  onMinMagChange(minMag: number): void;
  onPick(quake: Quake): void;
  onViewModeChange(mode: ViewMode): void;
  onDepthScaleChange(scale: DepthScale): void;
  onSlabView(id: string): void;
  onSunModeChange(mode: SunMode): void;
  onPlatesChange(visible: boolean): void;
  onWavesChange(visible: boolean): void;
  onExpandOnNarrowScreen?(): void;
}

export function isNarrowScreen(): boolean {
  return window.matchMedia('(max-width: 720px)').matches;
}

const MIN_MAG_ALL = -1; // slider's left end means "show everything"

const FEED_HINTS: Record<FeedId, string> = {
  hour: 'Past hour, all magnitudes',
  day: 'Past 24 hours, all magnitudes',
  week: 'Past 7 days, all magnitudes',
  month: 'Past 30 days, magnitude 2.5 and above (USGS feed limit)',
  year: 'Past year, magnitude 4.5 and above — the best window for seeing slabs',
};

/** The control panel: data window, filters, view, display, legends and the strongest-events list. */
export class Panel {
  private readonly feedHint = byId('feed-hint');
  private readonly minMag = byId<HTMLInputElement>('min-mag');
  private readonly minMagValue = byId<HTMLOutputElement>('min-mag-value');
  private readonly count = byId('quake-count');
  private readonly countLabel = byId('count-label');
  private readonly strongest = byId<HTMLOListElement>('strongest');
  private readonly details = byId<HTMLDetailsElement>('panel-details');
  private readonly depthScaleGroup = byId('depth-scale-buttons');
  private readonly sunHint = byId('sun-hint');
  private readonly plates = byId<HTMLInputElement>('plates-toggle');
  private readonly waves = byId<HTMLInputElement>('waves-toggle');
  private readonly plateLegend = byId('plate-legend-row');
  private listed: Quake[] = [];

  constructor(callbacks: PanelCallbacks) {
    segmented('feed-buttons', 'feed', (v) => callbacks.onFeedChange(v as FeedId));
    segmented('view-buttons', 'view', (v) => callbacks.onViewModeChange(v as ViewMode));
    segmented('depth-scale-buttons', 'scale', (v) => callbacks.onDepthScaleChange(Number(v) as DepthScale));
    segmented('sun-buttons', 'sun', (v) => callbacks.onSunModeChange(v as SunMode));

    this.minMag.addEventListener('input', () => {
      const value = this.readMinMag();
      this.showMinMag(value);
      callbacks.onMinMagChange(value);
    });

    this.waves.addEventListener('change', () => callbacks.onWavesChange(this.waves.checked));

    this.plates.addEventListener('change', () => {
      this.plateLegend.hidden = !this.plates.checked;
      callbacks.onPlatesChange(this.plates.checked);
    });

    this.strongest.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-index]');
      const quake = row ? this.listed[Number(row.dataset.index)] : undefined;
      if (quake) callbacks.onPick(quake);
    });

    const slabs = byId('slab-buttons');
    slabs.innerHTML = SLAB_VIEWS.map(
      (v) => `<button type="button" data-slab="${v.id}"><strong>${escapeHtml(v.name)}</strong><span>${escapeHtml(v.note)}</span></button>`,
    ).join('');
    slabs.addEventListener('click', (event) => {
      const id = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-slab]')?.dataset.slab;
      if (id) callbacks.onSlabView(id);
    });

    this.renderDepthLegend();
    this.renderSizeLegend();
    this.renderPlateLegend();

    // Start collapsed on small screens so the globe stays visible.
    if (isNarrowScreen()) this.collapse();

    // On a phone the panel and the detail card share the bottom of the screen:
    // opening the panel tells the app to close the card.
    this.details.addEventListener('toggle', () => {
      if (this.details.open && isNarrowScreen()) callbacks.onExpandOnNarrowScreen?.();
    });
  }

  collapse(): void {
    this.details.open = false;
  }

  setFeed(feed: FeedId): void {
    markActive('feed-buttons', 'feed', feed);
    this.feedHint.textContent = FEED_HINTS[feed] ?? USGS_FEEDS[feed].label;
  }

  setMinMag(minMag: number): void {
    this.minMag.value = String(Math.max(MIN_MAG_ALL, minMag));
    this.showMinMag(minMag);
  }

  setViewMode(mode: ViewMode): void {
    markActive('view-buttons', 'view', mode);
    this.depthScaleGroup.classList.toggle('disabled', mode !== 'cutaway');
    for (const b of this.depthScaleGroup.querySelectorAll('button')) b.disabled = mode !== 'cutaway';
  }

  setDepthScale(scale: DepthScale): void {
    markActive('depth-scale-buttons', 'scale', String(scale));
  }

  setSunMode(mode: SunMode): void {
    markActive('sun-buttons', 'sun', mode);
  }

  setSunPoint(lat: number, lon: number, mode: SunMode): void {
    this.sunHint.textContent =
      mode === 'real' ? `Sun overhead now: ${formatLatLon(lat, lon)}` : 'Even light from the viewer, no night side';
  }

  setWaves(visible: boolean): void {
    this.waves.checked = visible;
  }

  setPlates(visible: boolean): void {
    this.plates.checked = visible;
    this.plateLegend.hidden = !visible;
  }

  /** Updates the headline count and the strongest list. */
  update(visible: number, total: number, strongest: Quake[], nowMs: number): void {
    this.count.textContent = formatCount(visible);
    this.countLabel.textContent =
      visible === total ? `earthquake${visible === 1 ? '' : 's'}` : `of ${formatCount(total)} earthquakes`;

    this.listed = strongest;
    this.strongest.innerHTML =
      strongest.length === 0
        ? '<li class="empty">No earthquakes match these filters.</li>'
        : strongest
            .map(
              (q, i) => `<li><button type="button" data-index="${i}">
                <span class="mag-badge" style="--c:${depthColorCss(q.depthKm)}">${q.mag.toFixed(1)}</span>
                <span class="row-text"><span class="row-place">${escapeHtml(q.place)}</span>
                <span class="row-meta">${relativeTime(q.time, nowMs)} · ${Math.round(q.depthKm)} km</span></span>
              </button></li>`,
            )
            .join('');
  }

  private readMinMag(): number {
    const v = Number(this.minMag.value);
    return v <= MIN_MAG_ALL ? -Infinity : v;
  }

  private showMinMag(value: number): void {
    this.minMagValue.textContent = Number.isFinite(value) ? `≥ ${formatMag(value).slice(2)}` : 'all';
  }

  private renderDepthLegend(): void {
    // Stops are evenly spaced (the ramp is piecewise), so the bar matches the shader exactly.
    const n = DEPTH_STOPS.length - 1;
    const gradient = DEPTH_STOPS.map((s, i) => `${s.hex} ${(i / n) * 100}%`).join(', ');
    const ticks = DEPTH_STOPS.map((s, i) => `<span style="left:${(i / n) * 100}%">${s.depthKm}</span>`).join('');
    // Class bands: shallow 0–70 (stops 0–2), intermediate 70–300 (2–4), deep 300–700 (4–5).
    byId('depth-legend').innerHTML = `
      <div class="ramp" style="background: linear-gradient(to right, ${gradient})"></div>
      <div class="ticks">${ticks}</div>
      <div class="bands">
        <span style="width:${(2 / n) * 100}%">Shallow</span>
        <span style="width:${(2 / n) * 100}%">Intermediate</span>
        <span style="width:${(1 / n) * 100}%">Deep</span>
      </div>`;
  }

  private renderSizeLegend(): void {
    const { basePx, growth, minPx, maxPx } = MARKER_SIZE;
    const mags = [2, 4, 6, 8];
    byId('size-legend').innerHTML = mags
      .map((m) => {
        const r = Math.min(maxPx, Math.max(minPx, basePx * Math.pow(growth, m - 4)));
        return `<span class="size-item"><span class="dot" style="width:${r * 2}px;height:${r * 2}px"></span>${m}</span>`;
      })
      .join('');
  }

  private renderPlateLegend(): void {
    byId('plate-legend').innerHTML = BOUNDARY_TYPES.map((type) => {
      const s = BOUNDARY_STYLE[type];
      return `<li><span class="line" style="--c:${s.hex};--w:${s.widthPx}px"></span><span><strong>${s.label}</strong> <span class="muted">${s.detail}</span></span></li>`;
    }).join('');
  }
}

/** Wires a group of `button[data-<key>]` as a single-choice control. */
function segmented(groupId: string, key: string, onChange: (value: string) => void): void {
  const group = byId(groupId);
  group.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(`button[data-${key}]`);
    const value = button?.dataset[key];
    if (button && !button.disabled && value !== undefined) onChange(value);
  });
}

function markActive(groupId: string, key: string, value: string): void {
  for (const button of byId(groupId).querySelectorAll<HTMLButtonElement>(`button[data-${key}]`)) {
    const active = button.dataset[key] === value;
    button.setAttribute('aria-checked', String(active));
    button.classList.toggle('active', active);
  }
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

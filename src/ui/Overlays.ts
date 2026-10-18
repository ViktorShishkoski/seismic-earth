import type { Quake, QuakeContribution } from '../data/quake.ts';
import type { FeedStatus } from '../data/feed.ts';
import { depthColorCss } from '../render/markerStyle.ts';
import { byId } from './Panel.ts';
import {
  escapeHtml,
  formatCountdown,
  formatDataClock,
  formatDepth,
  formatDepthClass,
  formatLatLon,
  formatLocal,
  formatMag,
  formatUtc,
  relativeTime,
} from './format.ts';

/** How each network is named on screen. */
const SOURCE_LABEL: Record<string, string> = {
  usgs: 'USGS',
  emsc: 'EMSC',
};

const sourceName = (source: string): string => SOURCE_LABEL[source] ?? source.toUpperCase();

/** Small label that follows the pointer while hovering a marker. */
export class Tooltip {
  private readonly el = byId('tooltip');
  private currentId: string | null = null;

  show(quake: Quake, x: number, y: number, nowMs: number): void {
    if (this.currentId !== quake.id) {
      this.currentId = quake.id;
      this.el.innerHTML = `<strong>${formatMag(quake.mag)}</strong> · ${escapeHtml(formatDepth(quake.depthKm))}
        <span>${escapeHtml(quake.place)}</span><span class="muted">${relativeTime(quake.time, nowMs)}</span>`;
    }
    this.el.hidden = false;
    // Keep it on screen: flip to the left/top near the right/bottom edges.
    const { innerWidth: w, innerHeight: h } = window;
    const box = this.el.getBoundingClientRect();
    const left = x + 16 + box.width > w ? x - 16 - box.width : x + 16;
    const top = y + 16 + box.height > h ? y - 16 - box.height : y + 16;
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  hide(): void {
    this.el.hidden = true;
    this.currentId = null;
  }
}

/** Details of the selected earthquake. */
export class DetailCard {
  private readonly el = byId('card');
  private quake: Quake | null = null;

  constructor(
    private readonly onClose: () => void,
    private readonly onFlyTo: (quake: Quake) => void,
  ) {
    this.el.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
      if (action === 'close') this.onClose();
      if (action === 'fly' && this.quake) this.onFlyTo(this.quake);
    });
  }

  get current(): Quake | null {
    return this.quake;
  }

  show(quake: Quake, nowMs: number): void {
    this.quake = quake;
    const color = depthColorCss(quake.depthKm);
    const badges = [
      quake.tsunami ? '<span class="badge warn">Tsunami evaluation</span>' : '',
      quake.alert ? `<span class="badge alert-${escapeHtml(quake.alert)}">PAGER ${escapeHtml(quake.alert)}</span>` : '',
      `<span class="badge">${quake.status === 'reviewed' ? 'Reviewed' : 'Automatic'}</span>`,
      quake.type !== 'earthquake' ? `<span class="badge">${escapeHtml(quake.type)}</span>` : '',
    ].join('');

    this.el.innerHTML = `
      <button type="button" class="card-close" data-action="close" aria-label="Close details">×</button>
      <div class="card-head">
        <span class="card-mag" style="--c:${color}">${quake.mag.toFixed(1)}</span>
        <div>
          <h2>${escapeHtml(quake.place)}</h2>
          <p class="muted">${relativeTime(quake.time, nowMs)} · ${escapeHtml(quake.magType || 'magnitude')}</p>
        </div>
      </div>
      <div class="badges">${badges}</div>
      <dl>
        <dt>Local time</dt><dd>${formatLocal(quake.time)}</dd>
        <dt>UTC</dt><dd>${formatUtc(quake.time)}</dd>
        <dt>Depth</dt><dd><span class="swatch" style="--c:${color}"></span>${escapeHtml(formatDepth(quake.depthKm))} · ${formatDepthClass(quake.depthKm)}</dd>
        <dt>Location</dt><dd>${formatLatLon(quake.lat, quake.lon)}</dd>
        ${quake.felt ? `<dt>Felt reports</dt><dd>${quake.felt}</dd>` : ''}
        <dt>Event ID</dt><dd><code>${escapeHtml(quake.id)}</code></dd>
      </dl>
      ${renderSources(quake)}
      <div class="card-actions">
        <button type="button" data-action="fly">Fly to</button>
        <a href="${escapeHtml(quake.url)}" target="_blank" rel="noopener noreferrer">Event page ↗</a>
      </div>`;
    this.el.hidden = false;
  }

  hide(): void {
    this.quake = null;
    this.el.hidden = true;
  }
}

/**
 * When the relay merged reports from more than one network, show each
 * network's own solution. Two independent measurements of the same earthquake
 * is the point of the relay, so it is worth seeing rather than hiding behind
 * one averaged number.
 */
function renderSources(quake: Quake): string {
  const sources = quake.sources ?? [];
  if (sources.length === 0) return '';
  const rows = [...sources]
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((c) => {
      const marks = [
        c.source === quake.preferredSource ? '<abbr title="This solution set the position and depth">location</abbr>' : '',
        c.source === quake.magnitudeSource ? '<abbr title="This solution set the magnitude">magnitude</abbr>' : '',
      ].filter(Boolean);
      return `<li>
        <span class="src-name">${escapeHtml(sourceName(c.source))}</span>
        <span class="src-values">M ${c.mag.toFixed(1)}<span class="muted"> ${escapeHtml(c.magType || '—')}</span> · ${Math.round(c.depthKm)} km${stationNote(c)}</span>
        ${marks.length > 0 ? `<span class="src-used">${marks.join(' + ')}</span>` : '<span class="src-used muted">not used</span>'}
      </li>`;
    })
    .join('');
  return `<div class="sources">
    <span class="sources-title">Reported by ${sources.length} network${sources.length === 1 ? '' : 's'}</span>
    <ul>${rows}</ul>
  </div>`;
}

function stationNote(c: QuakeContribution): string {
  return c.nst ? ` · ${c.nst} stations` : '';
}

/** Brief notice when a new quake arrives during the session. */
export class Toast {
  private readonly el = byId('toast');
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onClick: (quake: Quake) => void) {}

  show(quake: Quake, extra: number): void {
    this.el.innerHTML = `<button type="button"><span class="toast-dot" style="--c:${depthColorCss(quake.depthKm)}"></span>
      New: <strong>${formatMag(quake.mag)}</strong> ${escapeHtml(quake.place)}${extra > 0 ? ` <span class="muted">+${extra} more</span>` : ''}</button>`;
    this.el.querySelector('button')!.onclick = () => {
      this.onClick(quake);
      this.hide();
    };
    this.el.hidden = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), 7000);
  }

  /** A plain notice with no event behind it (a replay that wouldn't load, say). */
  message(text: string, ms = 6000): void {
    this.el.textContent = text;
    this.el.hidden = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), ms);
  }

  hide(): void {
    this.el.hidden = true;
  }
}

/** "● Live · USGS · updated 2 min ago · next in 40 s" under the title. */
export class StatusLine {
  private readonly text = byId('status-text');
  private readonly dot = byId('status-dot');

  constructor(private readonly onRetry: () => void) {
    this.text.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('[data-action="retry"]')) this.onRetry();
    });
  }

  /** `sampleLabel` names the bundled data shown when offline, e.g. "1–7 Feb 2018". */
  render(status: FeedStatus, sampleLabel = 'bundled data', replayLabel = ''): void {
    const now = Date.now();
    this.dot.dataset.mode = status.mode;
    if (status.mode === 'replay') {
      const at = status.generated ? formatDataClock(status.generated) : '';
      this.text.textContent = `Replay · ${replayLabel} · ${at} UTC`;
      return;
    }
    if (status.mode === 'loading') {
      const target = status.transport === 'relay' ? 'the relay' : 'USGS';
      this.text.textContent = status.lastError ? `Retrying — ${status.lastError}` : `Connecting to ${target}…`;
      return;
    }
    if (status.mode === 'sample') {
      this.text.innerHTML = `Saved sample (${escapeHtml(sampleLabel)}) · live feed unreachable · <button type="button" class="link" data-action="retry">Retry</button>`;
      return;
    }
    const updated = status.generated ? relativeTime(status.generated, now) : '';
    const next = status.nextRefreshAt ? ` · next ${formatCountdown(status.nextRefreshAt - now)}` : '';

    if (status.transport === 'relay') {
      const relay = status.relay;
      const live = relay?.sources.filter((s) => s.connected).map((s) => sourceName(s.name)) ?? [];
      const down = relay?.sources.filter((s) => !s.connected).map((s) => sourceName(s.name)) ?? [];
      const networks = live.length > 0 ? live.join(' + ') : 'relay';
      const confirmed = relay && relay.merged > 0 ? ` · ${relay.merged.toLocaleString()} cross-confirmed` : '';
      const trouble = down.length > 0 ? ` · ${down.join(', ')} reconnecting` : '';
      const dropped = status.lastError ? ` · ${escapeHtml(status.lastError)}${next}` : '';
      this.text.textContent = `Live · ${networks}${confirmed}${trouble}${dropped}`;
      return;
    }

    const warn = status.lastError ? ' · last refresh failed' : '';
    this.text.textContent = `Live · USGS · updated ${updated}${next}${warn}`;
  }
}

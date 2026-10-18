import { depthClass } from '../data/quake.ts';

/** "M 4.6", with a real minus sign for negative local magnitudes. */
export function formatMag(mag: number): string {
  return `M ${mag.toFixed(1).replace('-', '−')}`;
}

/** "12 km deep", "650 km deep", or "2 km above sea level" for negative depths. */
export function formatDepth(depthKm: number): string {
  if (depthKm < 0) return `${Math.abs(depthKm).toFixed(depthKm > -10 ? 1 : 0)} km above sea level`;
  return `${depthKm < 10 ? depthKm.toFixed(1) : Math.round(depthKm)} km deep`;
}

export function formatDepthClass(depthKm: number): string {
  const cls = depthClass(depthKm);
  return cls === 'shallow' ? 'Shallow' : cls === 'intermediate' ? 'Intermediate depth' : 'Deep';
}

/** "just now", "4 min ago", "3 h ago", "2 days ago" relative to `nowMs`. */
export function relativeTime(timeMs: number, nowMs: number): string {
  const s = Math.max(0, (nowMs - timeMs) / 1000);
  if (s < 45) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} h ago`;
  const d = h / 24;
  if (d < 1.5) return '1 day ago';
  if (d < 60) return `${Math.round(d)} days ago`;
  return `${Math.round(d / 30.44)} months ago`;
}

/** Local date and time in the viewer's time zone, e.g. "16 Oct 2026, 19:58". */
export function formatLocal(timeMs: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timeMs);
}

/** "2026-10-16 17:58:04 UTC" — the unambiguous form seismologists use. */
export function formatUtc(timeMs: number): string {
  return new Date(timeMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** "11 Mar 2011, 05:46:24" — a replay's position on the data clock, always UTC. */
export function formatDataClock(timeMs: number): string {
  const iso = new Date(timeMs).toISOString();
  const [date, time] = iso.split('T');
  const [y, m, d] = date!.split('-');
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
  return `${Number(d)} ${month} ${y}, ${time!.slice(0, 8)}`;
}

/** "38.30° N, 142.37° E" */
export function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lon).toFixed(2)}° ${ew}`;
}

export function formatCount(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

/** "in 45 s", "in 2 min" */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

/** Escapes text for safe insertion into HTML (feed strings are external input). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

import { MEGATON_JOULES, computeStats, type CatalogStats } from '../data/statistics.ts';
import type { Quake } from '../data/quake.ts';
import { depthColorCss } from '../render/markerStyle.ts';
import { byId } from './Panel.ts';
import { escapeHtml, formatCount } from './format.ts';

/**
 * The statistics panel: what the events on screen look like as a population
 * rather than as dots.
 *
 * The magnitude chart is a Gutenberg–Richter plot — counts at or above each
 * magnitude, on a log scale, where the catalogue should trace a straight line.
 * The fitted slope is drawn over it so a bent tail (incomplete small-quake
 * recording) is obvious at a glance instead of hidden in a number.
 */
export class Stats {
  private readonly root = byId('stats-panel');
  private last = '';

  render(quakes: readonly Quake[]): void {
    const stats = computeStats(quakes);
    // Re-rendering identical HTML would restart the CSS transitions.
    const key = `${stats.total}:${stats.bValue ?? 0}:${stats.largest?.id ?? ''}`;
    if (key === this.last) return;
    this.last = key;

    if (stats.total === 0) {
      this.root.innerHTML = '<p class="hint">No events to summarise.</p>';
      return;
    }

    this.root.innerHTML = `
      ${magnitudeChart(stats)}
      ${depthChart(stats)}
      <dl class="stats-figures">
        ${figure('Gutenberg–Richter b', stats.bValue === null ? '–' : stats.bValue.toFixed(2), bNote(stats))}
        ${figure(
          'Complete above',
          stats.completeness === null ? '–' : `M ${stats.completeness.toFixed(1)}`,
          `${formatCount(stats.fitted)} events fitted${stats.fitQuality === null ? '' : ` · ${Math.round(stats.fitQuality)}% explained`}`,
        )}
        ${figure('Energy released', energyLabel(stats.energyJoules), 'from log₁₀E = 1.5M + 4.8')}
        ${figure('Median depth', stats.medianDepthKm === null ? '–' : `${Math.round(stats.medianDepthKm)} km`, depthShareLabel(stats))}
      </dl>`;
  }
}

function magnitudeChart(stats: CatalogStats): string {
  const bins = stats.magnitudeBins.filter((b) => b.cumulative > 0);
  if (bins.length < 2) return '';
  const top = Math.log10(bins[0]!.cumulative);
  const scale = (n: number) => (top <= 0 ? 1 : Math.log10(Math.max(n, 1)) / top);

  const bars = bins
    .map((bin) => {
      const complete = stats.completeness !== null && bin.mag >= stats.completeness - 1e-9;
      return `<div class="gr-bar${complete ? ' fitted' : ''}" style="--h:${(scale(bin.cumulative) * 100).toFixed(1)}%"
        title="${bin.cumulative} events at M ${bin.mag.toFixed(1)} or above (${bin.count} in this bin)"></div>`;
    })
    .join('');

  // The fitted law, drawn across the same bins: log₁₀N = a − bM.
  let line = '';
  if (stats.bValue !== null && stats.aValue !== null) {
    const points = bins
      .map((bin, i) => {
        const predicted = Math.pow(10, stats.aValue! - stats.bValue! * bin.mag);
        const x = (i / (bins.length - 1)) * 100;
        const y = 100 - Math.min(Math.max(scale(predicted), 0), 1) * 100;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    line = `<svg class="gr-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${points}" /></svg>`;
  }

  const first = bins[0]!.mag;
  const last = bins[bins.length - 1]!.mag;
  return `<figure class="gr-chart">
    <div class="gr-plot">${bars}${line}</div>
    <figcaption>
      <span>M ${first.toFixed(1)}</span>
      <span class="gr-axis-label">events at or above each magnitude (log)</span>
      <span>M ${last.toFixed(1)}</span>
    </figcaption>
  </figure>`;
}

function depthChart(stats: CatalogStats): string {
  const max = Math.max(...stats.depthBins.map((b) => b.count), 1);
  const rows = stats.depthBins
    .map((bin) => {
      const mid = (bin.fromKm + bin.toKm) / 2;
      const label = bin.toKm >= 800 ? `${bin.fromKm}+` : `${bin.fromKm}–${bin.toKm}`;
      return `<div class="depth-row">
        <span class="depth-range">${label}</span>
        <span class="depth-track"><span class="depth-fill" style="width:${((bin.count / max) * 100).toFixed(1)}%;--c:${depthColorCss(mid)}"></span></span>
        <span class="depth-n">${formatCount(bin.count)}</span>
      </div>`;
    })
    .join('');
  return `<div class="depth-hist" role="img" aria-label="Events by depth">${rows}
    <p class="hint">Depth, km below the surface</p></div>`;
}

function figure(label: string, value: string, note: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd><span>${escapeHtml(note)}</span></div>`;
}

function bNote(stats: CatalogStats): string {
  if (stats.bValue === null) return 'needs 20+ events above Mc';
  // A poor fit means the events on screen are not one population — usually a
  // worldwide window mixing a dense regional network with sparse global
  // coverage. The slope is then an artefact of who was listening, not physics.
  if (stats.fitQuality !== null && stats.fitQuality < 90) return 'mixed coverage — not one population';
  const b = stats.bValue;
  if (b < 0.75) return 'unusually flat — big events over-represented';
  if (b > 1.3) return 'steep — small events dominate this window';
  return 'close to the global value of about 1';
}

function energyLabel(joules: number): string {
  const mt = joules / MEGATON_JOULES;
  if (mt >= 10) return `${Math.round(mt)} Mt TNT`;
  if (mt >= 0.1) return `${mt.toFixed(1)} Mt TNT`;
  return `${Math.round(mt * 1000)} kt TNT`;
}

function depthShareLabel(stats: CatalogStats): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return `${pct(stats.depthShare.shallow)} shallow · ${pct(stats.depthShare.intermediate)} intermediate · ${pct(stats.depthShare.deep)} deep`;
}

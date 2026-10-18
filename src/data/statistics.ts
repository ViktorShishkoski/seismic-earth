import { depthClass, type Quake } from './quake.ts';

/**
 * What a catalogue of earthquakes adds up to.
 *
 * Two things seismologists read off any catalogue, and both are here:
 *
 * **Gutenberg–Richter.** Plot the number of quakes at or above each magnitude
 * on a log scale and you get a straight line: log₁₀N = a − bM. Ten times as
 * many M5s as M6s, ten times as many M6s as M7s. The slope b sits close to 1
 * almost everywhere on Earth and in almost every time window, which is why a
 * value far from 1 usually means the catalogue is incomplete rather than the
 * crust being strange. The intercept a is just how busy the region is.
 *
 * **Completeness.** Small quakes go unrecorded — too far from a station, too
 * faint — so the line bends below some magnitude Mc. Everything below that is
 * missing data, not a lack of earthquakes, so the slope is fitted only above
 * it. Mc is estimated here by maximum curvature: the most populated bin, which
 * is where detection falls off.
 *
 * The slope itself uses the Aki–Utsu maximum-likelihood estimator rather than
 * a least-squares fit to the plot, because the big magnitudes have very few
 * events and a straight-line fit lets them pull the slope around.
 */

export interface MagnitudeBin {
  /** Lower edge of the bin. */
  mag: number;
  /** Events in this bin. */
  count: number;
  /** Events at or above this bin — the Gutenberg–Richter curve. */
  cumulative: number;
}

export interface DepthBin {
  fromKm: number;
  toKm: number;
  count: number;
}

export interface CatalogStats {
  total: number;
  magnitudeBins: MagnitudeBin[];
  depthBins: DepthBin[];
  /** Magnitude of completeness: below this the catalogue is missing events. */
  completeness: number | null;
  /** Gutenberg–Richter slope. Close to 1 for a healthy catalogue. */
  bValue: number | null;
  /** Gutenberg–Richter intercept: log₁₀ of the yearly rate at M0, loosely. */
  aValue: number | null;
  /** Events used to fit the slope (those at or above `completeness`). */
  fitted: number;
  /**
   * How well the fitted law reproduces the observed counts, as a percentage.
   * Below about 90 the catalogue is not one Gutenberg–Richter population — a
   * worldwide feed mixing a dense regional network with sparse global coverage
   * is the usual reason — and the slope should not be read as physics.
   */
  fitQuality: number | null;
  largest: Quake | null;
  deepest: Quake | null;
  /** Total radiated energy, in joules. */
  energyJoules: number;
  medianDepthKm: number | null;
  /** Share of events in each depth class, 0…1. */
  depthShare: { shallow: number; intermediate: number; deep: number };
}

export const DEPTH_BIN_EDGES = [0, 35, 70, 150, 300, 500, 700, 800] as const;

/** Radiated energy in joules from the Gutenberg–Richter relation log₁₀E = 1.5M + 4.8. */
export function radiatedEnergyJoules(mag: number): number {
  return Math.pow(10, 1.5 * mag + 4.8);
}

/** One megaton of TNT, in joules — the unit big quakes are usually compared in. */
export const MEGATON_JOULES = 4.184e15;

const LOG10_E = Math.LOG10E; // 0.4343, the constant in the Aki–Utsu estimator

export function computeStats(quakes: readonly Quake[], binWidth = 0.5): CatalogStats {
  const empty: CatalogStats = {
    total: 0,
    magnitudeBins: [],
    depthBins: [],
    completeness: null,
    bValue: null,
    aValue: null,
    fitted: 0,
    fitQuality: null,
    largest: null,
    deepest: null,
    energyJoules: 0,
    medianDepthKm: null,
    depthShare: { shallow: 0, intermediate: 0, deep: 0 },
  };
  if (quakes.length === 0) return empty;

  let largest = quakes[0]!;
  let deepest = quakes[0]!;
  let energyJoules = 0;
  const depths: number[] = [];
  const classes = { shallow: 0, intermediate: 0, deep: 0 };

  for (const q of quakes) {
    if (q.mag > largest.mag) largest = q;
    if (q.depthKm > deepest.depthKm) deepest = q;
    energyJoules += radiatedEnergyJoules(q.mag);
    depths.push(q.depthKm);
    classes[depthClass(q.depthKm)]++;
  }

  // ── Magnitude bins, lowest first ───────────────────────────────────────
  const mags = quakes.map((q) => q.mag);
  const lo = Math.floor(Math.min(...mags) / binWidth) * binWidth;
  const hi = Math.floor(Math.max(...mags) / binWidth) * binWidth;
  const binCount = Math.round((hi - lo) / binWidth) + 1;
  const counts = new Array<number>(binCount).fill(0);
  for (const mag of mags) {
    // Which bin the magnitude falls in, counted from the lowest bin's edge.
    // The epsilon keeps a magnitude sitting exactly on an edge out of the bin below.
    const i = Math.min(binCount - 1, Math.max(0, Math.floor((mag - lo) / binWidth + 1e-9)));
    counts[i] = counts[i]! + 1;
  }

  const magnitudeBins: MagnitudeBin[] = [];
  let cumulative = 0;
  for (let i = binCount - 1; i >= 0; i--) {
    cumulative += counts[i]!;
    magnitudeBins[i] = { mag: round(lo + i * binWidth), count: counts[i]!, cumulative };
  }

  // ── Completeness and slope ─────────────────────────────────────────────
  const precision = reportingPrecision(mags);
  const fit = chooseCompleteness(mags, counts, lo, binWidth, precision);
  const completeness = fit.completeness;
  const bValue = fit.bValue;
  const aValue = fit.aValue;
  const above = mags.filter((m) => m >= completeness - 1e-9);

  // ── Depth bins ─────────────────────────────────────────────────────────
  const depthBins: DepthBin[] = [];
  for (let i = 0; i < DEPTH_BIN_EDGES.length - 1; i++) {
    const fromKm = DEPTH_BIN_EDGES[i]!;
    const toKm = DEPTH_BIN_EDGES[i + 1]!;
    const last = i === DEPTH_BIN_EDGES.length - 2;
    depthBins.push({
      fromKm,
      toKm,
      // Quakes above sea level land in the first bin; anything past the last
      // edge (there are a few) joins the deepest one rather than vanishing.
      count: depths.filter((d) => (i === 0 ? d < toKm : last ? d >= fromKm : d >= fromKm && d < toKm)).length,
    });
  }

  depths.sort((a, b) => a - b);
  const mid = depths.length >> 1;
  const medianDepthKm =
    depths.length % 2 === 1 ? depths[mid]! : ((depths[mid - 1]! + depths[mid]!) / 2);

  return {
    total: quakes.length,
    magnitudeBins,
    depthBins,
    completeness,
    bValue,
    aValue,
    fitted: above.length,
    fitQuality: fit.quality,
    largest,
    deepest,
    energyJoules,
    medianDepthKm,
    depthShare: {
      shallow: classes.shallow / quakes.length,
      intermediate: classes.intermediate / quakes.length,
      deep: classes.deep / quakes.length,
    },
  };
}

/**
 * Picks the magnitude of completeness by goodness of fit (Wiemer & Wyss, 2000).
 *
 * The naive estimate is maximum curvature: the fullest bin, where detection
 * starts to fall away. It is fast and usually close, but a catalogue that
 * mixes coverage breaks it badly — a worldwide feed records M1 in California
 * and nothing under M4.5 in the Southern Ocean, and reading one slope across
 * both gives an absurdly flat b that means nothing.
 *
 * So instead: try each candidate Mc from the bottom up, fit the slope above
 * it, and ask how much of the observed distribution the fitted law actually
 * reproduces. Take the lowest Mc that explains 90% of it — the most data that
 * still behaves like a single population — and if none does, fall back to
 * maximum curvature and report the poor fit honestly.
 */
function chooseCompleteness(
  mags: readonly number[],
  counts: readonly number[],
  lo: number,
  binWidth: number,
  precision: number,
): { completeness: number; bValue: number | null; aValue: number | null; quality: number | null } {
  // Maximum curvature, kept as the fallback.
  let peak = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i]! > counts[peak]!) peak = i;

  let best: { mc: number; b: number; a: number; quality: number } | null = null;
  let fallback: { b: number; a: number; quality: number } | null = null;

  for (let i = 0; i < counts.length; i++) {
    const mc = round(lo + i * binWidth);
    const above = mags.filter((m) => m >= mc - 1e-9);
    // Too few events and the slope is noise, not a measurement.
    if (above.length < 20) break;

    const slope = akiSlope(above, mc, precision);
    if (!slope) continue;
    const quality = goodnessOfFit(counts, i, above.length, mc, slope.b, binWidth);
    if (i === peak) fallback = { ...slope, quality };
    if (quality >= 90 && !best) best = { mc, ...slope, quality };
  }

  if (best) return { completeness: best.mc, bValue: best.b, aValue: best.a, quality: best.quality };
  const mc = round(lo + peak * binWidth);
  return {
    completeness: mc,
    bValue: fallback?.b ?? null,
    aValue: fallback?.a ?? null,
    quality: fallback?.quality ?? null,
  };
}

/**
 * Aki–Utsu maximum likelihood: b = log₁₀e / (M̄ − (Mc − ΔM/2)).
 *
 * ΔM is the precision the catalogue *reports* magnitudes to, not the width of
 * the histogram bins: a reported M4.5 stands for anything in [4.45, 4.55), and
 * leaving that half-step out drags the slope well below its true value.
 *
 * Maximum likelihood rather than a least-squares fit to the plotted line,
 * because the large magnitudes have very few events each and a straight-line
 * fit lets them pull the slope around.
 */
function akiSlope(above: readonly number[], mc: number, precision: number): { b: number; a: number } | null {
  const mean = above.reduce((s, m) => s + m, 0) / above.length;
  const denominator = mean - (mc - precision / 2);
  if (denominator <= 1e-6) return null;
  const b = LOG10_E / denominator;
  return { b, a: Math.log10(above.length) + b * mc };
}

/**
 * The percentage of the observed bin counts above Mc that the fitted law
 * accounts for: 100 · (1 − Σ|observed − predicted| / Σ observed).
 */
function goodnessOfFit(
  counts: readonly number[],
  from: number,
  total: number,
  mc: number,
  b: number,
  binWidth: number,
): number {
  let observed = 0;
  let error = 0;
  for (let j = from; j < counts.length; j++) {
    const edge = mc + (j - from) * binWidth;
    // Expected share of the population inside this bin under log₁₀N = a − bM.
    const share = Math.pow(10, -b * (edge - mc)) - Math.pow(10, -b * (edge + binWidth - mc));
    observed += counts[j]!;
    error += Math.abs(counts[j]! - total * share);
  }
  if (observed === 0) return 0;
  return Math.max(0, 100 * (1 - error / observed));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * The step the catalogue quotes magnitudes in, read off the data itself.
 * USGS reports most magnitudes to two decimals but some networks to one, and
 * the slope estimate needs to know which.
 */
export function reportingPrecision(mags: readonly number[]): number {
  for (const step of [0.5, 0.1]) {
    if (mags.every((m) => Math.abs(m / step - Math.round(m / step)) < 1e-6)) return step;
  }
  return 0.01;
}

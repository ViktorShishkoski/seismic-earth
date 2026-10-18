import { describe, expect, it } from 'vitest';
import {
  DEPTH_BIN_EDGES,
  MEGATON_JOULES,
  computeStats,
  radiatedEnergyJoules,
  reportingPrecision,
} from '../src/data/statistics.ts';
import type { Quake } from '../src/data/quake.ts';

/** A reproducible pseudo-random stream, so the statistics tests never flake. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 8) / 0x01000000;
  };
}

function quake(mag: number, depthKm = 10, i = 0): Quake {
  return {
    id: `q${i}`,
    time: 1_700_000_000_000 + i * 1000,
    updated: 1_700_000_000_000 + i * 1000,
    mag,
    magType: 'mw',
    place: 'nowhere',
    lat: 0,
    lon: 0,
    depthKm,
    type: 'earthquake',
    status: 'reviewed',
    url: '',
    felt: null,
    alert: null,
    sig: 0,
    tsunami: false,
  };
}

/**
 * A catalogue drawn from the Gutenberg–Richter law by inverse transform:
 * N(≥M) ∝ 10^(−b(M−Mmin)), so M = Mmin − log₁₀(u)/b.
 *
 * The true magnitudes are continuous from half a step below `minMag`, then
 * rounded to 0.1 — which is what a real catalogue is, and the reason the slope
 * estimator carries a half-step correction. Generating exactly at the bin edge
 * instead would quietly flatter an estimator that left that term out.
 */
function gutenbergRichter(b: number, count: number, minMag = 4, seed = 7): Quake[] {
  const rand = random(seed);
  const out: Quake[] = [];
  for (let i = 0; i < count; i++) {
    const u = Math.max(rand(), 1e-12);
    const mag = Math.round((minMag - 0.05 - Math.log10(u) / b) * 10) / 10;
    out.push(quake(mag, 10, i));
  }
  return out;
}

describe('catalogue statistics', () => {
  it('recovers the Gutenberg–Richter slope it was given', () => {
    for (const b of [0.8, 1.0, 1.2]) {
      const stats = computeStats(gutenbergRichter(b, 40_000));
      expect(stats.bValue).not.toBeNull();
      expect(stats.bValue!).toBeCloseTo(b, 1);
      expect(Math.abs(stats.bValue! - b)).toBeLessThan(0.05);
    }
  });

  it('finds where a catalogue stops being complete', () => {
    // Drop 90% of everything below M5 — what a sparse station network does.
    const rand = random(3);
    const thinned = gutenbergRichter(1, 40_000).filter((q) => q.mag >= 5 || rand() < 0.1);
    const stats = computeStats(thinned);
    expect(stats.completeness).toBe(5);
    // And the slope above it still comes out right.
    expect(stats.bValue!).toBeCloseTo(1, 1);
  });

  it('puts every magnitude in exactly one bin', () => {
    // A catalogue laid out so a binning slip shows up immediately: equal
    // numbers per half-magnitude step, including values on the bin edges.
    const mags = [4.5, 4.7, 5.0, 5.2, 5.5, 5.9, 6.0, 6.4];
    const stats = computeStats(mags.map((m, i) => quake(m, 10, i)));
    expect(stats.magnitudeBins.map((b) => b.count)).toEqual([2, 2, 2, 2]);
    expect(stats.magnitudeBins.map((b) => b.mag)).toEqual([4.5, 5, 5.5, 6]);
    expect(stats.magnitudeBins.map((b) => b.cumulative)).toEqual([8, 6, 4, 2]);
  });

  it('explains a clean catalogue almost perfectly', () => {
    const clean = computeStats(gutenbergRichter(1, 20_000));
    expect(clean.fitQuality!).toBeGreaterThan(95);
    expect(clean.completeness).toBe(4); // the floor it was generated from
  });

  it('raises the completeness past a region the catalogue only half-records', () => {
    // A dense local network complete to M1, and ten times as many events from
    // a sparse global one that records nothing under M4.5. Maximum curvature
    // would pick the local peak around M1 and fit a meaningless slope across
    // both; the goodness-of-fit search has to climb above the join.
    const mixed = computeStats([
      ...gutenbergRichter(1, 2_000, 1, 11),
      ...gutenbergRichter(1, 20_000, 4.5, 12),
    ]);
    expect(mixed.completeness!).toBeGreaterThanOrEqual(4.5);
    expect(mixed.bValue!).toBeCloseTo(1, 1);
    expect(mixed.fitQuality!).toBeGreaterThan(90);
    // And the bars below the join are marked as not fitted, not silently used.
    expect(mixed.fitted).toBeLessThan(mixed.total);
  });

  it('will not fit a slope to a handful of events', () => {
    const stats = computeStats([quake(5.1), quake(6.2, 300, 1), quake(4.4, 55, 2)]);
    expect(stats.bValue).toBeNull();
    expect(stats.completeness).not.toBeNull();
    expect(stats.total).toBe(3);
  });

  it('counts down the cumulative curve, never up', () => {
    const stats = computeStats(gutenbergRichter(1, 5_000));
    for (let i = 1; i < stats.magnitudeBins.length; i++) {
      expect(stats.magnitudeBins[i]!.cumulative).toBeLessThanOrEqual(stats.magnitudeBins[i - 1]!.cumulative);
      expect(stats.magnitudeBins[i]!.mag).toBeGreaterThan(stats.magnitudeBins[i - 1]!.mag);
    }
    expect(stats.magnitudeBins[0]!.cumulative).toBe(stats.total);
    expect(stats.magnitudeBins.reduce((s, b) => s + b.count, 0)).toBe(stats.total);
  });

  it('measures energy the way seismologists do', () => {
    // log₁₀E = 1.5M + 4.8, so one step of magnitude is about 32× the energy.
    expect(radiatedEnergyJoules(6) / radiatedEnergyJoules(5)).toBeCloseTo(31.6, 1);
    expect(Math.log10(radiatedEnergyJoules(9))).toBeCloseTo(18.3, 6);
    // Tōhoku's M9.0 released roughly 475 megatons of TNT equivalent.
    expect(radiatedEnergyJoules(9) / MEGATON_JOULES).toBeCloseTo(477, 0);
    // A thousand M4s do not add up to one M6.
    const many = computeStats(Array.from({ length: 1000 }, (_, i) => quake(4, 10, i)));
    expect(many.energyJoules).toBeLessThan(radiatedEnergyJoules(6));
  });

  it('sorts events into depth bins that account for every one', () => {
    const depths = [-2, 5, 33, 40, 70, 120, 200, 350, 520, 640, 690, 710, 900];
    const stats = computeStats(depths.map((d, i) => quake(5, d, i)));
    expect(stats.depthBins.reduce((s, b) => s + b.count, 0)).toBe(depths.length);
    expect(stats.depthBins[0]).toEqual({ fromKm: 0, toKm: 35, count: 3 }); // −2, 5, 33
    // Anything past the last edge joins the deepest bin instead of disappearing.
    expect(stats.depthBins.at(-1)!.count).toBe(2); // 710 and 900
    expect(DEPTH_BIN_EDGES.at(-1)).toBe(800);
  });

  it('describes the depth mix and the extremes', () => {
    const stats = computeStats([quake(5, 10, 0), quake(7.2, 120, 1), quake(6, 400, 2), quake(4, 30, 3)]);
    expect(stats.largest!.mag).toBe(7.2);
    expect(stats.deepest!.depthKm).toBe(400);
    expect(stats.medianDepthKm).toBe(75); // (30 + 120) / 2
    expect(stats.depthShare.shallow).toBeCloseTo(0.5, 6);
    expect(stats.depthShare.intermediate).toBeCloseTo(0.25, 6);
    expect(stats.depthShare.deep).toBeCloseTo(0.25, 6);
  });

  it("reads the catalogue's own magnitude precision", () => {
    expect(reportingPrecision([4.5, 5, 6.5])).toBe(0.5);
    expect(reportingPrecision([4.5, 5.1, 6.3])).toBe(0.1);
    expect(reportingPrecision([4.52, 5.1, 6.3])).toBe(0.01);
  });

  it('says nothing at all about an empty catalogue', () => {
    const stats = computeStats([]);
    expect(stats.total).toBe(0);
    expect(stats.bValue).toBeNull();
    expect(stats.largest).toBeNull();
    expect(stats.energyJoules).toBe(0);
    expect(stats.magnitudeBins).toEqual([]);
  });
});

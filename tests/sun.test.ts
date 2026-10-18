import { describe, expect, it } from 'vitest';
import { subsolarPoint } from '../src/geo/sun.ts';

describe('subsolarPoint', () => {
  it('puts the sun over the equator at the March equinox (2024-03-20 03:06 UTC)', () => {
    expect(Math.abs(subsolarPoint(Date.UTC(2024, 2, 20, 3, 6)).lat)).toBeLessThan(0.05);
  });

  it('puts the sun over the Tropic of Cancer at the June solstice (2026-06-21 08:24 UTC)', () => {
    expect(subsolarPoint(Date.UTC(2026, 5, 21, 8, 24)).lat).toBeCloseTo(23.44, 1);
  });

  it('puts the sun over the Tropic of Capricorn at the December solstice (2025-12-21 15:03 UTC)', () => {
    expect(subsolarPoint(Date.UTC(2025, 11, 21, 15, 3)).lat).toBeCloseTo(-23.44, 1);
  });

  it('follows the equation of time: the sun is east of Greenwich at 12:00 UTC in mid-February', () => {
    // Around 11 Feb the sun runs ~14 min slow, so at 12:00 UTC it is still ~3.5° east.
    expect(subsolarPoint(Date.UTC(2026, 1, 11, 12, 0)).lon).toBeCloseTo(3.55, 0);
  });

  it('follows the equation of time: the sun is west of Greenwich at 12:00 UTC in early November', () => {
    // Around 3 Nov the sun runs ~16 min fast, so at 12:00 UTC it is already ~4.1° west.
    expect(subsolarPoint(Date.UTC(2026, 10, 3, 12, 0)).lon).toBeCloseTo(-4.1, 0);
  });

  it('moves 15° west per hour', () => {
    const a = subsolarPoint(Date.UTC(2026, 9, 16, 10, 0)).lon;
    const b = subsolarPoint(Date.UTC(2026, 9, 16, 11, 0)).lon;
    expect(a - b).toBeCloseTo(15, 1);
  });
});

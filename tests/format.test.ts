import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatCountdown,
  formatDepth,
  formatDepthClass,
  formatLatLon,
  formatMag,
  formatUtc,
  relativeTime,
} from '../src/ui/format.ts';
import { depthClass, energyRatio } from '../src/data/quake.ts';

describe('formatting', () => {
  it('formats magnitudes, including negative local magnitudes', () => {
    expect(formatMag(4.56)).toBe('M 4.6');
    expect(formatMag(-0.07)).toBe('M −0.1');
  });

  it('formats depth, including events above sea level', () => {
    expect(formatDepth(10.64)).toBe('11 km deep');
    expect(formatDepth(4.2)).toBe('4.2 km deep');
    expect(formatDepth(-0.21)).toBe('0.2 km above sea level');
  });

  it('names the depth classes', () => {
    expect(depthClass(30)).toBe('shallow');
    expect(depthClass(191)).toBe('intermediate');
    expect(depthClass(574)).toBe('deep');
    expect(formatDepthClass(574)).toBe('Deep');
  });

  it('describes how long ago something happened', () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe('1 day ago');
    expect(relativeTime(now - 6 * 86_400_000, now)).toBe('6 days ago');
    expect(relativeTime(now + 60_000, now)).toBe('just now'); // clock skew never says "in the future"
  });

  it('formats UTC and coordinates unambiguously', () => {
    expect(formatUtc(Date.UTC(2011, 2, 11, 5, 46, 24))).toBe('2011-03-11 05:46:24 UTC');
    expect(formatLatLon(38.297, 142.373)).toBe('38.30° N, 142.37° E');
    expect(formatLatLon(-36.12, -72.9)).toBe('36.12° S, 72.90° W');
  });

  it('formats the refresh countdown', () => {
    expect(formatCountdown(44_600)).toBe('in 45 s');
    expect(formatCountdown(150_000)).toBe('in 3 min');
  });

  it('escapes feed text before it goes into HTML', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('knows each magnitude step is ~32× the energy', () => {
    expect(energyRatio(7, 6)).toBeCloseTo(31.62, 2);
    expect(energyRatio(8, 6)).toBeCloseTo(1000, 6);
  });
});

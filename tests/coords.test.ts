import { describe, expect, it } from 'vitest';
import {
  EARTH_RADIUS_KM,
  cartesianToLatLon,
  greatCircleKm,
  latLonToCartesian,
  latLonToUv,
} from '../src/geo/coords.ts';

describe('latLonToCartesian', () => {
  it('puts the reference points on the expected axes', () => {
    expectVec(latLonToCartesian(0, 0), [0, 0, 1]); // 0°, 0° faces +Z
    expectVec(latLonToCartesian(0, 90), [1, 0, 0]); // 90° E is +X
    expectVec(latLonToCartesian(0, -90), [-1, 0, 0]); // 90° W is −X
    expectVec(latLonToCartesian(90, 0), [0, 1, 0]); // North Pole is +Y
    expectVec(latLonToCartesian(-90, 0), [0, -1, 0]);
  });

  it('places points on the unit sphere at depth 0', () => {
    for (const [lat, lon] of [[35.7, 139.7], [-33.4, -70.6], [41.99, 21.43]] as const) {
      expect(Math.hypot(...latLonToCartesian(lat, lon))).toBeCloseTo(1, 12);
    }
  });

  it('moves deeper points toward the centre by depth / Earth radius', () => {
    const r = Math.hypot(...latLonToCartesian(38.3, 142.4, 600));
    expect(r).toBeCloseTo((EARTH_RADIUS_KM - 600) / EARTH_RADIUS_KM, 12);
  });
});

describe('cartesianToLatLon', () => {
  it('round-trips lat, lon and depth', () => {
    const cases: Array<[number, number, number]> = [
      [38.297, 142.373, 29], // 2011 Tōhoku
      [-36.12, -72.9, 22.9], // 2010 Maule, Chile
      [-17.5, -178.9, 600], // deep Fiji slab
      [41.99, 21.43, 0], // Skopje
    ];
    for (const [lat, lon, depth] of cases) {
      const back = cartesianToLatLon(...latLonToCartesian(lat, lon, depth));
      expect(back.lat).toBeCloseTo(lat, 9);
      expect(back.lon).toBeCloseTo(lon, 9);
      expect(back.depthKm).toBeCloseTo(depth, 6);
    }
  });
});

describe('latLonToUv', () => {
  it('maps an equirectangular image edge to edge', () => {
    expect(latLonToUv(90, -180)).toEqual([0, 0]);
    expect(latLonToUv(-90, 180)).toEqual([1, 1]);
    expect(latLonToUv(0, 0)).toEqual([0.5, 0.5]);
  });
});

describe('greatCircleKm', () => {
  it('is zero for the same point and about half the circumference for antipodes', () => {
    expect(greatCircleKm(10, 20, 10, 20)).toBeCloseTo(0, 9);
    expect(greatCircleKm(0, 0, 0, 180)).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 6);
  });

  it('matches a known city distance (London to Paris ≈ 344 km)', () => {
    expect(greatCircleKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeGreaterThan(340);
    expect(greatCircleKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeLessThan(348);
  });
});

function expectVec(actual: readonly number[], expected: readonly number[]): void {
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 12));
}

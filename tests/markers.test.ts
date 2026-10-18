import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { DEPTH_STOPS, depthColor, hexToRgb, markerRadiusPx, zoomScale, MARKER_SIZE } from '../src/render/markerStyle.ts';
import { FLAG_NEW, FLOATS_PER_QUAKE, packQuakes } from '../src/data/pack.ts';
import { pickMarker, projectSurfacePoint } from '../src/geo/picking.ts';
import { latLonToCartesian } from '../src/geo/coords.ts';
import { OrbitCamera } from '../src/camera/OrbitCamera.ts';
import type { Quake } from '../src/data/quake.ts';

const q = (id: string, lat: number, lon: number, mag: number, extra: Partial<Quake> = {}): Quake => ({
  id,
  time: 0,
  updated: 0,
  lat,
  lon,
  depthKm: 10,
  mag,
  magType: 'ml',
  place: id,
  url: '',
  type: 'earthquake',
  status: 'reviewed',
  tsunami: false,
  felt: null,
  alert: null,
  sig: 0,
  ...extra,
});

describe('depth colour ramp', () => {
  it('hits each stop exactly and clamps outside the range', () => {
    for (const stop of DEPTH_STOPS) {
      expect(depthColor(stop.depthKm)).toEqual(hexToRgb(stop.hex));
    }
    expect(depthColor(-3)).toEqual(hexToRgb(DEPTH_STOPS[0]!.hex));
    expect(depthColor(5000)).toEqual(hexToRgb(DEPTH_STOPS.at(-1)!.hex));
  });

  it('gets darker with depth (OKLab perceptual lightness falls monotonically)', () => {
    let previous = Infinity;
    for (let d = 0; d <= 700; d += 5) {
      const l = oklabLightness(depthColor(d));
      expect(l).toBeLessThanOrEqual(previous + 1e-9);
      previous = l;
    }
    expect(oklabLightness(depthColor(0))).toBeGreaterThan(0.9);
    expect(oklabLightness(depthColor(700))).toBeLessThan(0.56);
  });
});

describe('marker size', () => {
  it('grows 1.5× per magnitude unit at the reference zoom, within the clamps', () => {
    const alt = MARKER_SIZE.referenceAltitude;
    expect(markerRadiusPx(4, alt)).toBeCloseTo(MARKER_SIZE.basePx, 9);
    expect(markerRadiusPx(5, alt) / markerRadiusPx(4, alt)).toBeCloseTo(1.5, 9);
    expect(markerRadiusPx(-1, alt)).toBe(MARKER_SIZE.minPx);
    expect(markerRadiusPx(9.5, alt)).toBe(MARKER_SIZE.maxPx);
  });

  it('grows gently when zooming in, within limits', () => {
    expect(zoomScale(MARKER_SIZE.referenceAltitude)).toBeCloseTo(1, 9);
    expect(zoomScale(0.65)).toBeCloseTo(2, 9);
    expect(zoomScale(0.0001)).toBe(MARKER_SIZE.maxZoomScale);
    expect(zoomScale(100)).toBe(MARKER_SIZE.minZoomScale);
  });
});

describe('packQuakes', () => {
  it('writes 8 floats per quake with relative times and the "new" flag', () => {
    const data = packQuakes(
      [q('a', 0, 90, 5.5, { time: 10_000, depthKm: 33 }), q('b', 0, 0, 2, { time: 4_000 })],
      12_000,
      new Set(['b']),
    );
    expect(data.length).toBe(2 * FLOATS_PER_QUAKE);
    expect(data[0]).toBeCloseTo(1, 6); // 0° N 90° E is +X
    expect(data[3]).toBeCloseTo(5.5, 6);
    expect(data[4]).toBe(33);
    expect(data[5]).toBe(-2); // 2 s before the epoch
    expect(data[6]).toBe(0);
    expect(data[FLOATS_PER_QUAKE + 5]).toBe(-8);
    expect(data[FLOATS_PER_QUAKE + 6]).toBe(FLAG_NEW);
  });

  it('reuses a big enough buffer instead of allocating', () => {
    const buffer = new Float32Array(64);
    expect(packQuakes([q('a', 0, 0, 3)], 0, new Set(), buffer)).toBe(buffer);
  });
});

describe('picking', () => {
  const width = 1200;
  const height = 800;
  const setup = (lat: number, lon: number) => {
    const camera = new OrbitCamera({ lat, lon, distance: 3 });
    const viewProj = camera.viewProjection(width / height, mat4.create());
    return { viewProj, eye: camera.eye as vec3 };
  };

  it('projects the point under the camera to the centre of the screen', () => {
    const { viewProj, eye } = setup(10, 20);
    const p = projectSurfacePoint(latLonToCartesian(10, 20), viewProj, eye, width, height)!;
    expect(p.x).toBeCloseTo(width / 2, 3);
    expect(p.y).toBeCloseTo(height / 2, 3);
  });

  it('puts north above and east to the right', () => {
    const { viewProj, eye } = setup(0, 0);
    const north = projectSurfacePoint(latLonToCartesian(20, 0), viewProj, eye, width, height)!;
    const east = projectSurfacePoint(latLonToCartesian(0, 20), viewProj, eye, width, height)!;
    expect(north.y).toBeLessThan(height / 2);
    expect(east.x).toBeGreaterThan(width / 2);
  });

  it('does not see through the planet', () => {
    const { viewProj, eye } = setup(0, 0);
    expect(projectSurfacePoint(latLonToCartesian(0, 180), viewProj, eye, width, height)).toBeNull();
  });

  it('picks the marker under the pointer, preferring the one drawn on top', () => {
    const { viewProj, eye } = setup(0, 0);
    const centre = { x: width / 2, y: height / 2 };
    // Same spot: a big quake first (drawn underneath), a small one after (on top).
    const items = [q('big', 0, 0, 6), q('small', 0, 0, 3), q('far', 0, 60, 5), q('behind', 0, 180, 7)];
    expect(pickMarker(items, viewProj, eye, width, height, centre)).toBe(1);
    expect(pickMarker(items, viewProj, eye, width, height, { x: 5, y: 5 })).toBe(-1);
  });

  it('forgives a near miss on a tiny marker', () => {
    const { viewProj, eye } = setup(0, 0);
    const items = [q('tiny', 0, 0, 0.5)];
    expect(pickMarker(items, viewProj, eye, width, height, { x: width / 2 + 5, y: height / 2 })).toBe(0);
  });
});

/** OKLab L (perceptual lightness, 0–1) of an sRGB colour. */
function oklabLightness([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

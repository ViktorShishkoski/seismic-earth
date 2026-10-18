import { describe, expect, it } from 'vitest';
import { SPHERE_FLOATS_PER_VERTEX, createSphere } from '../src/geo/sphere.ts';
import { latLonToCartesian } from '../src/geo/coords.ts';

describe('createSphere', () => {
  const lat = 16;
  const lon = 32;
  const mesh = createSphere(lat, lon);

  const position = (i: number): [number, number, number] => {
    const o = i * SPHERE_FLOATS_PER_VERTEX;
    return [mesh.vertices[o]!, mesh.vertices[o + 1]!, mesh.vertices[o + 2]!];
  };

  it('has the expected vertex and index counts', () => {
    expect(mesh.vertexCount).toBe((lat + 1) * (lon + 1));
    expect(mesh.indexCount).toBe(lat * lon * 6);
    expect(mesh.vertices.length).toBe(mesh.vertexCount * SPHERE_FLOATS_PER_VERTEX);
  });

  it('keeps every vertex on the unit sphere', () => {
    for (let i = 0; i < mesh.vertexCount; i++) {
      expect(Math.hypot(...position(i))).toBeCloseTo(1, 6);
    }
  });

  it('only references vertices that exist', () => {
    for (const index of mesh.indices) {
      expect(index).toBeLessThan(mesh.vertexCount);
    }
  });

  it('winds every triangle counter-clockwise seen from outside (so back-face culling works)', () => {
    let checked = 0;
    for (let t = 0; t < mesh.indexCount; t += 3) {
      const a = position(mesh.indices[t]!);
      const b = position(mesh.indices[t + 1]!);
      const c = position(mesh.indices[t + 2]!);
      const ab = sub(b, a);
      const ac = sub(c, a);
      const normal = cross(ab, ac);
      const area = Math.hypot(...normal);
      if (area < 1e-9) continue; // degenerate triangles at the poles
      const centroid: [number, number, number] = [
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3,
      ];
      expect(dot(normal, centroid)).toBeGreaterThan(0);
      checked++;
    }
    // Only the one-triangle-per-cell slivers touching each pole are degenerate.
    expect(checked).toBe(mesh.indexCount / 3 - 2 * lon);
  });

  it('puts a texture pixel where its lat/lon says (Skopje, 42° N 21.4° E)', () => {
    // Find the vertex closest to Skopje and check its UV matches the equirectangular formula.
    const target = latLonToCartesian(42, 22.5);
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const p = position(i);
      const d = Math.hypot(p[0] - target[0], p[1] - target[1], p[2] - target[2]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    const o = best * SPHERE_FLOATS_PER_VERTEX;
    const u = mesh.vertices[o + 3]!;
    const v = mesh.vertices[o + 4]!;
    // Grid step is 11.25° in both directions here, so allow half a step.
    expect(Math.abs(u - (22.5 + 180) / 360)).toBeLessThan(11.25 / 360 / 2 + 1e-6);
    expect(Math.abs(v - (90 - 42) / 180)).toBeLessThan(11.25 / 180 / 2 + 1e-6);
  });

  it('rejects meshes too coarse to be a sphere', () => {
    expect(() => createSphere(1, 8)).toThrow();
    expect(() => createSphere(8, 2)).toThrow();
  });
});

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

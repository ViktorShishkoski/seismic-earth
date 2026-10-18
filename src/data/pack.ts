import { latLonToCartesian } from '../geo/coords.ts';
import type { Quake } from './quake.ts';

/**
 * GPU instance layout — 8 floats (32 bytes) per earthquake:
 *
 *   [0..2] position on the unit sphere (surface point; true depth arrives in Phase 3)
 *   [3]    magnitude
 *   [4]    depth in km (drives colour)
 *   [5]    origin time in seconds relative to `epochMs`
 *   [6]    flags (bit 0 = arrived during this session)
 *   [7]    unused (keeps 16-byte alignment)
 *
 * Times are stored relative to a reference epoch because a float32 can't hold
 * "milliseconds since 1970" precisely; seconds since app start fit easily.
 */
export const FLOATS_PER_QUAKE = 8;
export const QUAKE_STRIDE_BYTES = FLOATS_PER_QUAKE * 4;
export const FLAG_NEW = 1;

export function packQuakes(
  quakes: readonly Quake[],
  epochMs: number,
  newIds: ReadonlySet<string> = new Set(),
  out?: Float32Array<ArrayBuffer>,
): Float32Array<ArrayBuffer> {
  const needed = quakes.length * FLOATS_PER_QUAKE;
  const data = out && out.length >= needed ? out : new Float32Array(needed);
  let o = 0;
  for (const q of quakes) {
    const [x, y, z] = latLonToCartesian(q.lat, q.lon);
    data[o++] = x;
    data[o++] = y;
    data[o++] = z;
    data[o++] = q.mag;
    data[o++] = q.depthKm;
    data[o++] = (q.time - epochMs) / 1000;
    data[o++] = newIds.has(q.id) ? FLAG_NEW : 0;
    data[o++] = 0;
  }
  return data;
}

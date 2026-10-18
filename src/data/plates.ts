import { latLonToCartesian } from '../geo/coords.ts';

/**
 * Tectonic plate boundaries from Peter Bird's PB2002 model, as ~32 km "steps".
 * The data file is pre-compacted at build time to a flat array:
 * [lon1, lat1, lon2, lat2, type, velocity mm/yr] per step.
 */
export type BoundaryType = 'convergent' | 'divergent' | 'transform';

export const BOUNDARY_TYPES: readonly BoundaryType[] = ['convergent', 'divergent', 'transform'];

export const BOUNDARY_STYLE: Record<BoundaryType, { hex: string; widthPx: number; label: string; detail: string }> = {
  // Two validated categorical slots (blue, aqua) + a neutral for the least important class;
  // line width is the second encoding, so the classes never rely on colour alone.
  convergent: { hex: '#3987e5', widthPx: 2.2, label: 'Convergent', detail: 'plates collide; subduction zones' },
  divergent: { hex: '#199e70', widthPx: 1.6, label: 'Divergent', detail: 'plates pull apart; ridges and rifts' },
  transform: { hex: '#9aa3b5', widthPx: 1.1, label: 'Transform', detail: 'plates slide past each other' },
};

export interface PlateBoundaries {
  /** Flat [lon1, lat1, lon2, lat2, typeIndex, velocity] per segment. */
  segments: Float32Array;
  count: number;
  source: string;
}

const STRIDE = 6;

export function parsePlateBoundaries(json: unknown): PlateBoundaries {
  if (typeof json !== 'object' || json === null) throw new Error('Plate data is not an object');
  const data = json as { segments?: unknown; stride?: unknown; types?: unknown; source?: unknown };
  if (data.stride !== STRIDE || !Array.isArray(data.segments) || data.segments.length % STRIDE !== 0) {
    throw new Error('Unexpected plate data layout');
  }
  if (!Array.isArray(data.types) || data.types.join() !== BOUNDARY_TYPES.join()) {
    throw new Error('Unexpected plate boundary types');
  }
  const segments = Float32Array.from(data.segments as number[]);
  return { segments, count: segments.length / STRIDE, source: typeof data.source === 'string' ? data.source : '' };
}

/** Radius the lines are drawn at: a hair above the surface so the globe's depth test doesn't eat them. */
export const PLATE_LIFT = 1.0015;

export const FLOATS_PER_SEGMENT = 8;

/** GPU instances: [ax, ay, az, type, bx, by, bz, velocity] per segment. */
export function buildSegmentInstances(plates: PlateBoundaries): Float32Array<ArrayBuffer> {
  const out = new Float32Array(plates.count * FLOATS_PER_SEGMENT);
  const s = plates.segments;
  for (let i = 0, o = 0; i < plates.count; i++) {
    const k = i * STRIDE;
    const a = latLonToCartesian(s[k + 1]!, s[k]!);
    const b = latLonToCartesian(s[k + 3]!, s[k + 2]!);
    out[o++] = a[0] * PLATE_LIFT;
    out[o++] = a[1] * PLATE_LIFT;
    out[o++] = a[2] * PLATE_LIFT;
    out[o++] = s[k + 4]!;
    out[o++] = b[0] * PLATE_LIFT;
    out[o++] = b[1] * PLATE_LIFT;
    out[o++] = b[2] * PLATE_LIFT;
    out[o++] = s[k + 5]!;
  }
  return out;
}

export async function loadPlateBoundaries(url: string): Promise<PlateBoundaries> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Plate boundaries: HTTP ${response.status}`);
  return parsePlateBoundaries(await response.json());
}

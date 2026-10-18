import { EARTH_RADIUS_KM, latLonToCartesian } from './coords.ts';
import { markerRadiusPx } from '../render/markerStyle.ts';

/** Minimal shape the picker needs; Quake satisfies it. */
export interface Pickable {
  lat: number;
  lon: number;
  mag: number;
  depthKm: number;
}

export interface ScreenPoint {
  x: number; // CSS pixels from the left
  y: number; // CSS pixels from the top
}

/** How quakes are placed: must match `quake_radius` in frame.wgsl. */
export interface Placement {
  /** 0 = on the surface, 1 = at true depth. */
  cutaway: number;
  depthScale: number;
  /** Altitude marker sizes are based on; defaults to the camera's real altitude. */
  markerAltitude?: number;
  /** Slab-view focus: quakes faded out by it (far from the region) can't be picked. */
  focus?: { dir: ArrayLike<number>; radiusKm: number; strength: number };
}

export const SURFACE: Placement = { cutaway: 0, depthScale: 1 };

/** Outer core radius in Earth radii (3,480 km). */
export const CORE_RADIUS = 0.5462;

/** Radius a quake is drawn at for the current view (mirrors the shader). */
export function quakeRadius(depthKm: number, placement: Placement): number {
  const r = 1 - (Math.max(depthKm, 0) * placement.depthScale) / EARTH_RADIUS_KM;
  const atDepth = Math.max(r, CORE_RADIUS + 0.02);
  return 1 + (atDepth - 1) * placement.cutaway;
}

export function quakePosition(q: Pickable, placement: Placement): [number, number, number] {
  const [x, y, z] = latLonToCartesian(q.lat, q.lon);
  const r = quakeRadius(q.depthKm, placement);
  return [x * r, y * r, z * r];
}

/** Projects a world point to CSS pixels, or null when it is behind the camera. */
export function projectPoint(
  p: readonly [number, number, number],
  viewProj: ArrayLike<number>,
  width: number,
  height: number,
): ScreenPoint | null {
  const m = viewProj;
  const cx = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
  const cy = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
  const cw = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
  if (cw <= 0) return null;
  return { x: ((cx / cw + 1) / 2) * width, y: ((1 - cy / cw) / 2) * height };
}

/**
 * Projects a surface point to CSS pixels, or returns null when it is behind
 * the planet (past the horizon) — the same test the marker shader uses.
 */
export function projectSurfacePoint(
  p: readonly [number, number, number],
  viewProj: ArrayLike<number>,
  eye: ArrayLike<number>,
  width: number,
  height: number,
): ScreenPoint | null {
  if (!aboveHorizon(p, eye)) return null;
  return projectPoint(p, viewProj, width, height);
}

function aboveHorizon(dir: readonly [number, number, number], eye: ArrayLike<number>): boolean {
  const ex = eye[0] ?? 0;
  const ey = eye[1] ?? 0;
  const ez = eye[2] ?? 0;
  const eyeLen = Math.hypot(ex, ey, ez);
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const cosAngle = (dir[0] * ex + dir[1] * ey + dir[2] * ez) / (eyeLen * len);
  return cosAngle > 1 / eyeLen + 0.01;
}

/** Does the straight line from the eye to p pass through the core first? */
export function hiddenByCore(p: readonly [number, number, number], eye: ArrayLike<number>, coreRadius = CORE_RADIUS): boolean {
  const ex = eye[0] ?? 0;
  const ey = eye[1] ?? 0;
  const ez = eye[2] ?? 0;
  const dx = p[0] - ex;
  const dy = p[1] - ey;
  const dz = p[2] - ez;
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return false;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  // Ray–sphere intersection with the core, centred at the origin.
  const b = ex * ux + ey * uy + ez * uz;
  const c = ex * ex + ey * ey + ez * ez - coreRadius * coreRadius;
  const disc = b * b - c;
  if (disc <= 0) return false;
  const tNear = -b - Math.sqrt(disc);
  return tNear > 0 && tNear < len;
}

function outsideFocus(q: Pickable, focus: { dir: ArrayLike<number>; radiusKm: number }): boolean {
  const [x, y, z] = latLonToCartesian(q.lat, q.lon);
  const d = focus.dir;
  const cos = Math.max(-1, Math.min(1, x * (d[0] ?? 0) + y * (d[1] ?? 0) + z * (d[2] ?? 0)));
  return Math.acos(cos) * EARTH_RADIUS_KM > focus.radiusKm * 1.3; // where the shader has faded it to ~1/3
}

/**
 * Finds the marker under a screen point.
 *
 * Surface view: markers are drawn in array order, so a later one sits on top;
 * if the pointer is inside several, the topmost wins.
 * Cutaway view: markers float at different depths, so the one nearest the
 * camera wins, and markers hidden behind the core can't be picked.
 * Otherwise the nearest marker within a small tolerance wins (tiny markers
 * are hard to hit exactly). Returns the index into `items`, or −1.
 *
 * This is a CPU loop over all markers. At tens of thousands it still costs
 * well under a millisecond; a GPU ID buffer is the upgrade path beyond that.
 */
export function pickMarker(
  items: readonly Pickable[],
  viewProj: ArrayLike<number>,
  eye: ArrayLike<number>,
  width: number,
  height: number,
  pointer: ScreenPoint,
  placement: Placement = SURFACE,
  tolerancePx = 4,
): number {
  const eyeRadius = Math.hypot(eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0);
  const altitude = placement.markerAltitude ?? eyeRadius - 1;
  const interior = placement.cutaway >= 0.5;
  let insideIndex = -1;
  let insideDepth = Infinity;
  let nearestIndex = -1;
  let nearestDist = Infinity;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (placement.focus && placement.focus.strength > 0.5 && outsideFocus(item, placement.focus)) continue;
    const p = quakePosition(item, placement);
    if (interior ? hiddenByCore(p, eye) : !aboveHorizon(p, eye)) continue;
    const screen = projectPoint(p, viewProj, width, height);
    if (!screen) continue;
    const dist = Math.hypot(screen.x - pointer.x, screen.y - pointer.y);
    const radius = markerRadiusPx(item.mag, altitude);
    if (dist <= radius) {
      if (interior) {
        const toEye = Math.hypot(p[0] - (eye[0] ?? 0), p[1] - (eye[1] ?? 0), p[2] - (eye[2] ?? 0));
        if (toEye < insideDepth) {
          insideDepth = toEye;
          insideIndex = i;
        }
      } else {
        insideIndex = i; // keep going: a later (higher) marker overrides
      }
    } else if (dist <= Math.max(radius + tolerancePx, 7) && dist < nearestDist) {
      nearestDist = dist;
      nearestIndex = i;
    }
  }
  return insideIndex >= 0 ? insideIndex : nearestIndex;
}

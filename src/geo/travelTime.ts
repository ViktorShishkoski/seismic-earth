/**
 * When seismic waves arrive.
 *
 * An earthquake sends two body waves through the planet. P waves (primary,
 * a compression) travel fastest and arrive first; S waves (secondary, a shear)
 * follow at a bit over half the speed and carry most of the damaging shaking.
 * The gap between them is how a single station works out how far away a quake
 * was, long before anyone else reports it.
 *
 * Neither travels at a constant speed: the deeper a ray dives, the stiffer the
 * rock and the faster it goes, so a wave crossing half the planet averages far
 * more than one skimming the crust. That is why this is a table rather than a
 * formula — these are the USGS travel times for a source 33 km deep, sampled
 * every 5° of epicentral distance.
 *
 * Source: USGS Earthquake Hazards Program, "Earthquake travel times".
 * https://www.usgs.gov/programs/earthquake-hazards/earthquake-travel-times
 */

/** Travel times in seconds at 0°, 5°, 10° … 105° of epicentral distance. */
export const TRAVEL_TIME_STEP_DEG = 5;

export const P_TRAVEL_SEC: readonly number[] = [
  5.4, 72.7, 141.3, 209.5, 269.7, 320.7, 365.5, 409.2, 451.4, 492.1, 530.9, 568.0, 603.2, 636.7,
  668.3, 698.1, 726.0, 752.0, 776.1, 799.1, 821.5, 843.7,
];

export const S_TRAVEL_SEC: readonly number[] = [
  9.4, 130.1, 253.2, 375.3, 493.5, 583.3, 662.1, 739.7, 815.4, 889.1, 960.0, 1028.5, 1094.1, 1157.0,
  1217.0, 1274.1, 1328.1, 1379.1, 1426.8, 1471.1, 1513.5, 1555.1,
];

/**
 * Farthest distance the table covers. Beyond about 103° the direct P wave
 * stops arriving at all: the core bends it away, leaving a "shadow zone" —
 * the observation that revealed the Earth has a core in the first place.
 */
export const MAX_DISTANCE_DEG = (P_TRAVEL_SEC.length - 1) * TRAVEL_TIME_STEP_DEG;

/** How long the slower wave takes to reach the far edge of the table. */
export const MAX_TRAVEL_SEC = S_TRAVEL_SEC[S_TRAVEL_SEC.length - 1]!;

function lookup(table: readonly number[], distanceDeg: number): number {
  if (!(distanceDeg > 0)) return table[0]!;
  if (distanceDeg >= MAX_DISTANCE_DEG) return table[table.length - 1]!;
  const x = distanceDeg / TRAVEL_TIME_STEP_DEG;
  const i = Math.floor(x);
  const t = x - i;
  return table[i]! + (table[i + 1]! - table[i]!) * t;
}

/** Seconds until the P wave reaches a point this many degrees away. */
export function pArrivalSec(distanceDeg: number): number {
  return lookup(P_TRAVEL_SEC, distanceDeg);
}

/** Seconds until the S wave reaches a point this many degrees away. */
export function sArrivalSec(distanceDeg: number): number {
  return lookup(S_TRAVEL_SEC, distanceDeg);
}

/** Average speed of the P wave out to this distance, in km/s (for labels). */
export function pSpeedKmS(distanceDeg: number): number {
  const km = (distanceDeg / 180) * Math.PI * 6371;
  return km / pArrivalSec(distanceDeg);
}

/**
 * How far each wave has travelled `elapsedSec` after the quake, in degrees.
 * Inverted from the table by walking it, which is exact at the samples and
 * linear between them — the same interpolation the shader uses.
 */
export function waveFrontDeg(table: readonly number[], elapsedSec: number): number {
  if (elapsedSec <= table[0]!) return 0;
  const last = table.length - 1;
  if (elapsedSec >= table[last]!) return MAX_DISTANCE_DEG;
  for (let i = 1; i <= last; i++) {
    if (elapsedSec <= table[i]!) {
      const span = table[i]! - table[i - 1]!;
      const t = span === 0 ? 0 : (elapsedSec - table[i - 1]!) / span;
      return (i - 1 + t) * TRAVEL_TIME_STEP_DEG;
    }
  }
  return MAX_DISTANCE_DEG;
}

/**
 * The table flattened for the GPU: one vec4 per sample, holding the P and S
 * arrival times (the last two components are spare). The shader reads this
 * and interpolates exactly as `lookup` does, so what is drawn and what the
 * tests check can never drift apart.
 */
export function packTravelTable(): Float32Array<ArrayBuffer> {
  const out = new Float32Array(P_TRAVEL_SEC.length * 4);
  for (let i = 0; i < P_TRAVEL_SEC.length; i++) {
    out[i * 4] = P_TRAVEL_SEC[i]!;
    out[i * 4 + 1] = S_TRAVEL_SEC[i]!;
  }
  return out;
}

export const TRAVEL_SAMPLES = P_TRAVEL_SEC.length;

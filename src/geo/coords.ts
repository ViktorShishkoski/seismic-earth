/**
 * Geographic coordinate helpers.
 *
 * World frame used everywhere in Seismic Earth (right-handed, Y up):
 *   +Y  → geographic North Pole
 *   +Z  → latitude 0°, longitude 0° (Gulf of Guinea, off West Africa)
 *   +X  → latitude 0°, longitude 90° E (Indian Ocean)
 *
 * Distances are in "Earth radii": the surface sits at radius 1.
 * The sphere mesh, the texture mapping and (from Phase 2) the earthquake
 * markers all go through these functions, so they can never disagree.
 */

/** Mean Earth radius in kilometres (IUGG). */
export const EARTH_RADIUS_KM = 6371;

const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];

/**
 * Converts latitude/longitude (degrees) and depth below the surface (km)
 * to a position in the world frame, in Earth radii.
 */
export function latLonToCartesian(latDeg: number, lonDeg: number, depthKm = 0): Vec3 {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const r = (EARTH_RADIUS_KM - depthKm) / EARTH_RADIUS_KM;
  const cosLat = Math.cos(lat);
  return [r * cosLat * Math.sin(lon), r * Math.sin(lat), r * cosLat * Math.cos(lon)];
}

/** Inverse of {@link latLonToCartesian}. Returns degrees and depth in km. */
export function cartesianToLatLon(x: number, y: number, z: number): {
  lat: number;
  lon: number;
  depthKm: number;
} {
  const r = Math.hypot(x, y, z);
  if (r === 0) return { lat: 0, lon: 0, depthKm: EARTH_RADIUS_KM };
  const lat = Math.asin(clamp(y / r, -1, 1)) / DEG;
  const lon = Math.atan2(x, z) / DEG;
  return { lat, lon, depthKm: EARTH_RADIUS_KM * (1 - r) };
}

/**
 * Equirectangular texture coordinates for a lat/lon.
 * u: 0 at 180° W → 1 at 180° E.  v: 0 at the North Pole → 1 at the South Pole.
 */
export function latLonToUv(latDeg: number, lonDeg: number): [number, number] {
  return [(lonDeg + 180) / 360, (90 - latDeg) / 180];
}

/** Great-circle distance between two points on the surface, in km (haversine). */
export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

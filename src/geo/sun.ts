/**
 * Where the sun is overhead right now (the "subsolar point").
 *
 * Uses the low-precision solar position from the Astronomical Almanac
 * (also used by NOAA's calculators): good to about 0.01° in declination and
 * well under 0.1° in longitude between 1950 and 2050 — far finer than a
 * pixel on the globe.
 *
 * Because the world frame is Earth-fixed (it rotates with the planet), the
 * sun direction is just the unit vector to the subsolar point.
 */

const DEG = Math.PI / 180;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0); // 2000-01-01 12:00 UTC (JD 2451545.0)
const DAY_MS = 86_400_000;

export interface SubsolarPoint {
  lat: number; // = solar declination, degrees
  lon: number; // degrees, −180…180
}

export function subsolarPoint(timeMs: number): SubsolarPoint {
  const n = (timeMs - J2000_MS) / DAY_MS; // days since J2000.0

  const L = normDeg(280.46 + 0.9856474 * n); // mean longitude
  const g = normDeg(357.528 + 0.9856003 * n) * DEG; // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG; // ecliptic longitude
  const epsilon = (23.439 - 0.0000004 * n) * DEG; // obliquity of the ecliptic

  const declination = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const rightAscension = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));

  // Greenwich mean sidereal time: how far the Earth has turned under the stars.
  const gmst = normDeg(280.46061837 + 360.98564736629 * n);
  const lon = wrap180(rightAscension / DEG - gmst);

  return { lat: declination / DEG, lon };
}

function normDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

function wrap180(d: number): number {
  const x = normDeg(d);
  return x > 180 ? x - 360 : x;
}

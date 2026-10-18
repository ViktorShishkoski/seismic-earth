/**
 * How an earthquake looks: depth → colour and magnitude → size.
 *
 * This file is the single source of truth. The WGSL marker shader receives
 * these numbers as uniforms, the CPU picker uses the same size function, and
 * the legend is drawn from the same stops, so what you see, what you can
 * click and what the legend says can never drift apart.
 */

/**
 * Depth ramp: analogous warm hues, lightness falling steadily with depth
 * (OKLab L 0.91 → 0.54). Shallow events — the most common and most
 * damaging — are the brightest. Stops follow the standard depth classes:
 * shallow < 70 km, intermediate 70–300 km, deep 300–700 km.
 */
export const DEPTH_STOPS: ReadonlyArray<{ depthKm: number; hex: string }> = [
  { depthKm: 0, hex: '#ffe066' },
  { depthKm: 35, hex: '#ffad42' },
  { depthKm: 70, hex: '#ff7043' },
  { depthKm: 150, hex: '#ef3e6a' },
  { depthKm: 300, hex: '#c42f8f' },
  { depthKm: 700, hex: '#8a3fd1' },
];

/**
 * Marker radius (CSS px) = BASE × GROWTH^(mag − 4), clamped.
 * Growth of 1.5× per magnitude unit is a *perceptual* choice: true energy
 * grows ~32× per unit, which would make an M7 a million times "bigger" than
 * an M3 and every small quake invisible.
 */
export const MARKER_SIZE = {
  basePx: 4,
  growth: 1.5,
  minPx: 1.6,
  maxPx: 30,
  /** Altitude (Earth radii) at which markers are drawn at their base size. */
  referenceAltitude: 2.6,
  minZoomScale: 0.7,
  maxZoomScale: 3.5,
} as const;

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** Interpolated depth colour as sRGB 0–1 (matching the shader's interpolation). */
export function depthColor(depthKm: number): [number, number, number] {
  const d = Math.max(0, depthKm);
  const stops = DEPTH_STOPS;
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  if (d <= first.depthKm) return hexToRgb(first.hex);
  if (d >= last.depthKm) return hexToRgb(last.hex);
  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i]!;
    if (d <= hi.depthKm) {
      const lo = stops[i - 1]!;
      const t = (d - lo.depthKm) / (hi.depthKm - lo.depthKm);
      const a = hexToRgb(lo.hex);
      const b = hexToRgb(hi.hex);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return hexToRgb(last.hex);
}

export function depthColorCss(depthKm: number): string {
  const [r, g, b] = depthColor(depthKm).map((c) => Math.round(c * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

/** How much markers grow when you zoom in (gentler than the globe itself grows). */
export function zoomScale(altitude: number): number {
  const s = Math.sqrt(MARKER_SIZE.referenceAltitude / Math.max(altitude, 1e-4));
  return Math.min(MARKER_SIZE.maxZoomScale, Math.max(MARKER_SIZE.minZoomScale, s));
}

/** Marker radius in CSS pixels for a magnitude at the current camera altitude. */
export function markerRadiusPx(mag: number, altitude: number): number {
  const { basePx, growth, minPx, maxPx } = MARKER_SIZE;
  const r = basePx * Math.pow(growth, mag - 4);
  return Math.min(maxPx, Math.max(minPx, r)) * zoomScale(altitude);
}

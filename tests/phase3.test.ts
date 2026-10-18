import { describe, expect, it } from 'vitest';
import { mat4, vec3, vec4 } from 'gl-matrix';
import plateJson from '../public/data/plate-boundaries.json';
import { BOUNDARY_TYPES, FLOATS_PER_SEGMENT, PLATE_LIFT, buildSegmentInstances, parsePlateBoundaries } from '../src/data/plates.ts';
import { CORE_RADIUS, hiddenByCore, pickMarker, quakePosition, quakeRadius } from '../src/geo/picking.ts';
import { EARTH_RADIUS_KM, cartesianToLatLon, greatCircleKm, latLonToCartesian } from '../src/geo/coords.ts';
import { OrbitCamera, orientationLooking } from '../src/camera/OrbitCamera.ts';
import { SLAB_VIEWS, slabCameraView } from '../src/camera/slabViews.ts';
import { DEFAULT_SETTINGS, parseSettings, serializeSettings } from '../src/ui/urlState.ts';
import { feedUrl } from '../src/data/usgs.ts';
import { zoomScale } from '../src/render/markerStyle.ts';

describe('plate boundaries (PB2002)', () => {
  const plates = parsePlateBoundaries(plateJson);

  it('loads every step of the model', () => {
    expect(plates.count).toBe(5824);
    expect(plates.source).toMatch(/Bird/);
  });

  it('has only the three boundary types, all of them present', () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < plates.count; i++) counts[plates.segments[i * 6 + 4]!]! += 1;
    expect(counts.every((c) => c > 1000)).toBe(true);
    expect(BOUNDARY_TYPES).toEqual(['convergent', 'divergent', 'transform']);
  });

  it('is made of short steps (~30 km), so straight chords follow the curved surface', () => {
    let longest = 0;
    for (let i = 0; i < plates.count; i++) {
      const s = plates.segments.subarray(i * 6, i * 6 + 4);
      longest = Math.max(longest, greatCircleKm(s[1]!, s[0]!, s[3]!, s[2]!));
    }
    expect(longest).toBeLessThan(150);
  });

  it('builds GPU instances lifted just above the surface', () => {
    const data = buildSegmentInstances(plates);
    expect(data.length).toBe(plates.count * FLOATS_PER_SEGMENT);
    expect(Math.hypot(data[0]!, data[1]!, data[2]!)).toBeCloseTo(PLATE_LIFT, 5);
  });

  it('rejects data in an unexpected layout', () => {
    expect(() => parsePlateBoundaries({ stride: 4, segments: [], types: [] })).toThrow();
    expect(() => parsePlateBoundaries(null)).toThrow();
  });
});

describe('true-depth placement', () => {
  it('keeps quakes on the surface in the surface view', () => {
    expect(quakeRadius(600, { cutaway: 0, depthScale: 3 })).toBe(1);
  });

  it('sinks them to their true depth in cutaway', () => {
    expect(quakeRadius(637.1, { cutaway: 1, depthScale: 1 })).toBeCloseTo(0.9, 9);
    expect(quakeRadius(637.1, { cutaway: 1, depthScale: 2 })).toBeCloseTo(0.8, 9);
  });

  it('never lets an exaggerated depth reach the core', () => {
    expect(quakeRadius(700, { cutaway: 1, depthScale: 3 })).toBeGreaterThan(CORE_RADIUS);
  });

  it('treats quakes above sea level as surface events', () => {
    expect(quakeRadius(-2, { cutaway: 1, depthScale: 1 })).toBe(1);
  });

  it('places a quake at the right lat/lon and depth', () => {
    const p = quakePosition({ lat: -20, lon: -178, depthKm: 550, mag: 5 }, { cutaway: 1, depthScale: 1 });
    const back = cartesianToLatLon(...p);
    expect(back.lat).toBeCloseTo(-20, 6);
    expect(back.lon).toBeCloseTo(-178, 6);
    expect(back.depthKm).toBeCloseTo(550, 3);
  });
});

describe('core occlusion', () => {
  const eye = [0, 0, 3];
  it('hides points straight behind the core', () => {
    expect(hiddenByCore([0, 0, -0.9], eye)).toBe(true);
  });
  it('does not hide points in front of it, or beside it', () => {
    expect(hiddenByCore([0, 0, 0.9], eye)).toBe(false);
    expect(hiddenByCore([0.8, 0, -0.5], eye)).toBe(false);
  });
});

describe('picking in cutaway', () => {
  const width = 1000;
  const height = 800;

  it('finds a deep quake where it is drawn, not where its epicentre is', () => {
    const camera = new OrbitCamera({ lat: 0, lon: 0, distance: 3 });
    // A deep quake 30° east: at depth it projects closer to the screen centre than its epicentre.
    const q = { lat: 0, lon: 30, depthKm: 600, mag: 6 };
    const placement = { cutaway: 1, depthScale: 2 };
    const vp = camera.viewProjection(width / height, mat4.create());
    const p = quakePosition(q, placement);
    const clip = vec4.transformMat4(vec4.create(), [...p, 1], vp);
    const x = ((clip[0] / clip[3] + 1) / 2) * width;
    const y = ((1 - clip[1] / clip[3]) / 2) * height;
    expect(pickMarker([q], vp, camera.eye, width, height, { x, y }, placement)).toBe(0);

    const surf = vec4.transformMat4(vec4.create(), [...latLonToCartesian(0, 30), 1], vp);
    const sx = ((surf[0] / surf[3] + 1) / 2) * width;
    expect(Math.abs(sx - x)).toBeGreaterThan(20); // the two really are in different places
  });

  it('prefers the quake nearest the camera when two overlap on screen', () => {
    const camera = new OrbitCamera({ lat: 0, lon: 0, distance: 3 });
    const vp = camera.viewProjection(width / height, mat4.create());
    const placement = { cutaway: 1, depthScale: 1 };
    // Same epicentre under the camera: the shallow one is nearer.
    const items = [
      { lat: 0, lon: 0, depthKm: 600, mag: 5 },
      { lat: 0, lon: 0, depthKm: 10, mag: 5 },
    ];
    expect(pickMarker(items, vp, camera.eye, width, height, { x: width / 2, y: height / 2 }, placement)).toBe(1);
  });
});

describe('camera look-at target (slab views)', () => {
  it('looks horizontally along a heading, with the local vertical up', () => {
    const q = orientationLooking(0, 0, 0, 0, [0, 0, 0, 1]);
    const back = vec3.transformQuat(vec3.create(), [0, 0, 1], q);
    const up = vec3.transformQuat(vec3.create(), [0, 1, 0], q);
    const right = vec3.transformQuat(vec3.create(), [1, 0, 0], q);
    expect(back[1]).toBeCloseTo(-1, 6); // looking north means the camera sits to the south
    expect(up[2]).toBeCloseTo(1, 6); // radial "up" at 0°, 0° is +Z
    expect(right[0]).toBeCloseTo(1, 6); // east is to the right when looking north
  });

  it('flies to every slab view and stays outside the planet', () => {
    for (const view of SLAB_VIEWS) {
      for (const scale of [1, 2, 3]) {
        const camera = new OrbitCamera();
        camera.flyToView(slabCameraView(view, scale));
        for (let i = 0; i < 300 && camera.isFlying; i++) camera.update(1 / 30);
        expect(camera.isFlying).toBe(false);
        expect(camera.isGlobeView).toBe(false);
        expect(vec3.length(camera.eye)).toBeGreaterThan(1.019);
        // The look-at point is at the slab's (scaled) depth under the region.
        const t = cartesianToLatLon(camera.target[0], camera.target[1], camera.target[2]);
        expect(t.depthKm).toBeCloseTo(view.depthKm * scale, 3);
        expect(greatCircleKm(t.lat, t.lon, view.lat, view.lon)).toBeLessThan(1);
      }
    }
  });

  it('keeps the camera above the surface when orbiting a target inside the planet', () => {
    const camera = new OrbitCamera();
    camera.flyToView(slabCameraView(SLAB_VIEWS[0]!, 1), 0.1);
    for (let i = 0; i < 300 && camera.isFlying; i++) camera.update(1 / 30);
    camera.beginDrag();
    for (let i = 0; i < 60; i++) camera.drag(0, -40, 800, 1 / 60); // swing the camera downward, into the ground
    camera.endDrag(true);
    camera.update(1 / 60);
    expect(vec3.length(camera.eye)).toBeGreaterThanOrEqual(1.019);
  });

  it('does not idle-spin around an off-centre target, and returns to the globe on reset', () => {
    const camera = new OrbitCamera({ lat: 0, lon: 0 });
    camera.autoSpinDelay = 0;
    camera.flyToView(slabCameraView(SLAB_VIEWS[1]!, 1), 0.1);
    for (let i = 0; i < 300 && camera.isFlying; i++) camera.update(1 / 30);
    const before = vec3.clone(camera.eye);
    for (let i = 0; i < 120; i++) camera.update(1 / 60);
    expect(vec3.distance(before, camera.eye)).toBeLessThan(1e-4);

    camera.reset();
    for (let i = 0; i < 300 && camera.isFlying; i++) camera.update(1 / 30);
    expect(camera.isGlobeView).toBe(true);
  });

  it('zooms by orbit distance in a slab view', () => {
    const camera = new OrbitCamera();
    camera.flyToView(slabCameraView(SLAB_VIEWS[2]!, 1), 0.1);
    for (let i = 0; i < 300 && camera.isFlying; i++) camera.update(1 / 30);
    const d = camera.targetDistance;
    camera.zoomBy(0.8);
    expect(camera.targetDistance).toBeCloseTo(d * 0.8, 9);
  });
});

describe('view settings in the URL', () => {
  it('round-trips every setting', () => {
    const s = {
      feed: 'year' as const,
      minMag: 5,
      view: 'cutaway' as const,
      depthScale: 2 as const,
      sun: 'studio' as const,
      plates: false,
      waves: false,
      replay: 'tohoku',
    };
    expect(parseSettings(serializeSettings(s))).toEqual(s);
  });

  it('keeps links short by omitting defaults', () => {
    expect(serializeSettings(DEFAULT_SETTINGS)).toBe('?feed=week');
  });

  it('ignores invalid values instead of breaking', () => {
    expect(parseSettings('?feed=forever&min=abc&view=sideways&dx=9&sun=moon')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('?feed=__proto__').feed).toBe('week');
  });
});

describe('year feed', () => {
  it('queries the FDSN event service for M4.5+ over the past year, start rounded to the hour', () => {
    const now = Date.UTC(2026, 9, 16, 18, 37, 12);
    const url = new URL(feedUrl('year', now));
    expect(url.pathname).toBe('/fdsnws/event/1/query');
    expect(url.searchParams.get('format')).toBe('geojson');
    expect(url.searchParams.get('minmagnitude')).toBe('4.5');
    expect(url.searchParams.get('starttime')).toBe('2025-10-16T18:00:00');
  });

  it('has a sensible depth constant', () => {
    expect(EARTH_RADIUS_KM).toBe(6371);
  });
});

describe('marker sizing across a flight into a slab view', () => {
  it('changes smoothly (no sudden jump when the target leaves the centre)', () => {
    const camera = new OrbitCamera({ distance: 3.6 });
    let previous = camera.markerAltitude();
    expect(previous).toBeCloseTo(2.6, 6);
    camera.flyToView(slabCameraView(SLAB_VIEWS[0]!, 1));
    let biggestRatio = 0;
    for (let i = 0; i < 600 && camera.isFlying; i++) {
      camera.update(1 / 60);
      const now = camera.markerAltitude();
      // What the eye sees is the marker size, i.e. zoomScale: compare that frame to frame.
      biggestRatio = Math.max(biggestRatio, Math.abs(zoomScale(now) / zoomScale(previous) - 1));
      previous = now;
    }
    expect(biggestRatio).toBeLessThan(0.05); // under 5% size change per frame at 60 fps
    expect(previous).toBeCloseTo(SLAB_VIEWS[0]!.distance * 7, 1);
  });
});

describe('slab-view focus', () => {
  it('cannot pick a quake faded out far from the region in focus', () => {
    const camera = new OrbitCamera({ lat: 0, lon: 0, distance: 3 });
    const vp = camera.viewProjection(1, mat4.create());
    const q = { lat: 0, lon: 0, depthKm: 10, mag: 5 };
    const centre = { x: 400, y: 400 };
    const near = { dir: latLonToCartesian(0, 2), radiusKm: 650, strength: 1 }; // ~220 km away
    const far = { dir: latLonToCartesian(0, 20), radiusKm: 650, strength: 1 }; // ~2,200 km away
    const base = { cutaway: 0, depthScale: 1 };
    expect(pickMarker([q], vp, camera.eye, 800, 800, centre, { ...base, focus: near })).toBe(0);
    expect(pickMarker([q], vp, camera.eye, 800, 800, centre, { ...base, focus: far })).toBe(-1);
    expect(pickMarker([q], vp, camera.eye, 800, 800, centre, { ...base, focus: { ...far, strength: 0 } })).toBe(0);
  });
});

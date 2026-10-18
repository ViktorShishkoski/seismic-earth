import { describe, expect, it } from 'vitest';
import { vec3, vec4 } from 'gl-matrix';
import { OrbitCamera } from '../src/camera/OrbitCamera.ts';
import { cartesianToLatLon } from '../src/geo/coords.ts';

const latLonOfEye = (camera: OrbitCamera) => {
  const e = camera.eye;
  return cartesianToLatLon(e[0], e[1], e[2]);
};

describe('OrbitCamera', () => {
  it('starts above the requested lat/lon, at the requested distance, north up', () => {
    const camera = new OrbitCamera({ lat: 42, lon: 21.4, distance: 3 });
    const { lat, lon } = latLonOfEye(camera);
    // gl-matrix stores values as 32-bit floats, so allow ~1e-5° of error.
    expect(lat).toBeCloseTo(42, 4);
    expect(lon).toBeCloseTo(21.4, 4);
    expect(vec3.length(camera.eye)).toBeCloseTo(3, 5);
    expect(camera.basis().up[1]).toBeGreaterThan(0.5);
  });

  it('keeps its basis orthonormal after many rotations', () => {
    const camera = new OrbitCamera();
    for (let i = 0; i < 500; i++) camera.rotateLocal(0.031 * Math.sin(i), 0.017 * Math.cos(i * 0.7));
    const { right, up, back } = camera.basis();
    for (const axis of [right, up, back]) expect(vec3.length(axis)).toBeCloseTo(1, 6);
    expect(vec3.dot(right, up)).toBeCloseTo(0, 6);
    expect(vec3.dot(up, back)).toBeCloseTo(0, 6);
    expect(vec3.dot(right, back)).toBeCloseTo(0, 6);
  });

  it('moves the camera west when the user drags right (the globe follows the pointer)', () => {
    const camera = new OrbitCamera({ lat: 0, lon: 0 });
    camera.beginDrag();
    camera.drag(100, 0, 800, 1 / 60);
    expect(latLonOfEye(camera).lon).toBeLessThan(0);
  });

  it('moves the camera north when the user drags down', () => {
    const camera = new OrbitCamera({ lat: 0, lon: 0 });
    camera.beginDrag();
    camera.drag(0, 100, 800, 1 / 60);
    expect(latLonOfEye(camera).lat).toBeGreaterThan(0);
  });

  it('passes over a pole smoothly (no gimbal lock)', () => {
    const camera = new OrbitCamera({ lat: 80, lon: 0 });
    for (let i = 0; i < 20; i++) camera.rotateLocal(0, -0.02); // pitch northward
    const { lat, lon } = latLonOfEye(camera);
    expect(lat).toBeLessThan(90);
    expect(Math.abs(Math.abs(lon) - 180)).toBeLessThan(1e-3); // came out on the far side
    expect(vec3.length(camera.eye)).toBeCloseTo(camera.distance, 5);
  });

  it('keeps flinging after release, then comes to rest', () => {
    const camera = new OrbitCamera({ lat: 0, lon: 0 });
    camera.autoSpin = false;
    camera.beginDrag();
    camera.drag(-30, 0, 800, 1 / 60);
    camera.endDrag(false);
    const lonAtRelease = latLonOfEye(camera).lon;
    camera.update(1 / 60);
    expect(latLonOfEye(camera).lon).toBeGreaterThan(lonAtRelease);
    for (let i = 0; i < 600; i++) camera.update(1 / 60);
    expect(camera.angularVelocity).toEqual([0, 0]);
  });

  it('does not fling if the pointer rested before release', () => {
    const camera = new OrbitCamera();
    camera.beginDrag();
    camera.drag(-30, 0, 800, 1 / 60);
    camera.endDrag(true);
    expect(camera.angularVelocity).toEqual([0, 0]);
  });

  it('clamps zoom between the minimum and maximum distance', () => {
    const camera = new OrbitCamera();
    for (let i = 0; i < 100; i++) camera.zoomBy(0.5);
    expect(camera.targetDistance).toBe(camera.minDistance);
    for (let i = 0; i < 100; i++) camera.zoomBy(2);
    expect(camera.targetDistance).toBe(camera.maxDistance);
  });

  it('eases toward the target distance', () => {
    const camera = new OrbitCamera({ distance: 3 });
    camera.zoomBy(0.5); // altitude 2 → 1, so target distance 2
    camera.update(1 / 60);
    expect(camera.distance).toBeLessThan(3);
    expect(camera.distance).toBeGreaterThan(2);
    for (let i = 0; i < 300; i++) camera.update(1 / 60);
    expect(camera.distance).toBeCloseTo(2, 4);
  });

  it('rolls back to north-up after a tilted drag', () => {
    const camera = new OrbitCamera({ lat: 30, lon: 0 });
    camera.autoSpin = false;
    // A circular drag path leaves the camera rolled.
    for (let i = 0; i < 60; i++) camera.rotateLocal(0.02 * Math.cos(i / 6), 0.02 * Math.sin(i / 6));
    for (let i = 0; i < 600; i++) camera.update(1 / 60);
    const { up, back } = camera.basis();
    const northOnScreen = vec3.scaleAndAdd(vec3.create(), [0, 1, 0], back, -vec3.dot([0, 1, 0], back));
    vec3.normalize(northOnScreen, northOnScreen);
    expect(vec3.dot(up, northOnScreen)).toBeCloseTo(1, 3);
  });

  it('spins westward-camera / eastward-planet when idle', () => {
    const camera = new OrbitCamera({ lat: 0, lon: 0 });
    camera.autoSpinDelay = 0;
    for (let i = 0; i < 120; i++) camera.update(1 / 60);
    expect(latLonOfEye(camera).lon).toBeLessThan(0);
  });

  it('projects the Earth centre to the middle of the screen with WebGPU depth (0…1)', () => {
    const camera = new OrbitCamera({ distance: 3 });
    const clip = vec4.transformMat4(vec4.create(), [0, 0, 0, 1], camera.viewProjection(16 / 9));
    const ndc = [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
    expect(ndc[0]).toBeCloseTo(0, 9);
    expect(ndc[1]).toBeCloseTo(0, 9);
    expect(ndc[2]).toBeGreaterThan(0);
    expect(ndc[2]).toBeLessThan(1);
  });
});

describe('OrbitCamera.flyTo', () => {
  it('arrives above the target, north up, at the requested distance', () => {
    const camera = new OrbitCamera({ lat: 20, lon: 15, distance: 3.6 });
    camera.flyTo(38.3, 142.4, 2);
    expect(camera.isFlying).toBe(true);
    for (let i = 0; i < 240 && camera.isFlying; i++) camera.update(1 / 60);
    expect(camera.isFlying).toBe(false);
    const { lat, lon } = latLonOfEye(camera);
    expect(lat).toBeCloseTo(38.3, 3);
    expect(lon).toBeCloseTo(142.4, 3);
    expect(camera.distance).toBeCloseTo(2, 6);
    expect(camera.basis().up[1]).toBeGreaterThan(0.5);
  });

  it('is cancelled by a drag', () => {
    const camera = new OrbitCamera();
    camera.flyTo(-30, -70);
    camera.update(1 / 60);
    camera.beginDrag();
    expect(camera.isFlying).toBe(false);
  });

  it('holds the idle spin while something is selected', () => {
    const camera = new OrbitCamera({ lat: 0, lon: 0 });
    camera.autoSpinDelay = 0;
    camera.autoSpinHold = true;
    for (let i = 0; i < 120; i++) camera.update(1 / 60);
    expect(latLonOfEye(camera).lon).toBeCloseTo(0, 4);
  });
});

import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { latLonToCartesian } from '../geo/coords.ts';

/**
 * An orbit camera around a target point, stored as a quaternion.
 *
 * Why a quaternion instead of yaw/pitch angles: angles hit gimbal lock at the
 * poles (the camera spins wildly as you pass over them), and their order of
 * application matters. A quaternion rotates smoothly in any direction, and
 * composing two rotations is a single multiply.
 *
 * Conventions:
 *  - The camera orbits `target` — normally the Earth's centre, but a slab
 *    view moves it inside the planet so the camera can look *across* a
 *    subduction zone instead of down onto it.
 *  - `orientation` maps the camera's local axes to world axes:
 *      local +X = screen right, +Y = screen up, +Z = from the target toward the camera.
 *  - Distances are in Earth radii (the surface is at 1).
 *
 * This class is pure maths with no DOM access, so it is unit-tested in Node.
 */

const WORLD_UP = vec3.fromValues(0, 1, 0);
const LOCAL_X = vec3.fromValues(1, 0, 0);
const LOCAL_Y = vec3.fromValues(0, 1, 0);
const LOCAL_Z = vec3.fromValues(0, 0, 1);
const ORIGIN = vec3.fromValues(0, 0, 0);
/** The camera never goes below this radius (just above the surface). */
const MIN_EYE_RADIUS = 1.02;

export interface OrbitCameraOptions {
  fovYDeg?: number;
  minDistance?: number;
  maxDistance?: number;
  distance?: number;
  /** Initial point under the camera. */
  lat?: number;
  lon?: number;
}

/** A complete camera pose: where it looks, from which direction, and how far away. */
export interface CameraView {
  target: vec3;
  orientation: quat;
  distance: number;
}

export class OrbitCamera {
  readonly orientation = quat.create();
  readonly target = vec3.create();
  readonly fovY: number;
  readonly minDistance: number;
  readonly maxDistance: number;

  distance: number;
  targetDistance: number;

  /** Rotation speed (rad/s) about the camera's local up (x) and right (y) axes. */
  readonly angularVelocity: [number, number] = [0, 0];

  /** Slowly spin the planet when nobody is touching it. */
  autoSpin = true;
  autoSpinSpeed = 0.05; // rad/s ≈ one turn every two minutes
  autoSpinDelay = 3; // seconds of inactivity before spinning starts

  /** Gently roll the view so geographic north (or, in a slab view, local "up") points up the screen. */
  northUp = true;

  /** Suspends the idle spin (e.g. while a quake is selected) without changing the setting. */
  autoSpinHold = false;

  private dragging = false;
  private flight: {
    from: quat;
    to: quat;
    fromTarget: vec3;
    toTarget: vec3;
    fromDistance: number;
    toDistance: number;
    t: number;
    duration: number;
  } | null = null;
  private idleTime = 0;
  private readonly defaults: Required<OrbitCameraOptions>;

  // Scratch values reused every frame to avoid garbage.
  private readonly tmpQ = quat.create();
  private readonly tmpV = vec3.create();
  private readonly tmpV2 = vec3.create();
  private readonly tmpV3 = vec3.create();

  constructor(options: OrbitCameraOptions = {}) {
    this.defaults = {
      fovYDeg: options.fovYDeg ?? 40,
      minDistance: options.minDistance ?? 1.08,
      maxDistance: options.maxDistance ?? 12,
      distance: options.distance ?? 3.6,
      lat: options.lat ?? 20,
      lon: options.lon ?? 15,
    };
    this.fovY = (this.defaults.fovYDeg * Math.PI) / 180;
    this.minDistance = this.defaults.minDistance;
    this.maxDistance = this.defaults.maxDistance;
    this.distance = this.defaults.distance;
    this.targetDistance = this.distance;
    this.lookAtLatLon(this.defaults.lat, this.defaults.lon);
  }

  /** True when orbiting the Earth's centre (the normal globe view). */
  get isGlobeView(): boolean {
    return vec3.length(this.target) < 1e-4;
  }

  /** Points the camera at a lat/lon from above, north up (no animation). */
  lookAtLatLon(lat: number, lon: number): void {
    this.flight = null;
    vec3.zero(this.target);
    orientationFor(lat, lon, this.orientation);
  }

  /**
   * Animates to a view above lat/lon: the orientation is interpolated with a
   * quaternion slerp (the shortest arc over the globe) and the distance eases
   * along with it. Any user input cancels the flight.
   */
  flyTo(lat: number, lon: number, distance?: number, durationSec = 1.6): void {
    const d = distance ?? (this.isGlobeView ? Math.min(this.targetDistance, 2.4) : 2.4);
    this.flyToView({ target: vec3.clone(ORIGIN), orientation: orientationFor(lat, lon, quat.create()), distance: d }, durationSec);
  }

  /** Animates to any pose — e.g. a side view across a subducting slab. */
  flyToView(view: CameraView, durationSec = 1.8): void {
    const arc = 2 * Math.acos(Math.min(1, Math.abs(quat.dot(this.orientation, view.orientation))));
    const move = vec3.distance(this.target, view.target);
    // Scale the duration with how far we travel, so short hops are quick.
    const duration = Math.max(0.5, durationSec * Math.min(1, arc / Math.PI + move * 0.5 + 0.35));
    const globe = vec3.length(view.target) < 1e-4;
    this.flight = {
      from: quat.clone(this.orientation),
      to: quat.clone(view.orientation),
      fromTarget: vec3.clone(this.target),
      toTarget: vec3.clone(view.target),
      fromDistance: this.distance,
      toDistance: globe ? clamp(view.distance, this.minDistance, this.maxDistance) : view.distance,
      t: 0,
      duration,
    };
    this.angularVelocity[0] = 0;
    this.angularVelocity[1] = 0;
    this.idleTime = 0;
  }

  get isFlying(): boolean {
    return this.flight !== null;
  }

  /** Back to the starting globe view (animated). */
  reset(): void {
    this.flyTo(this.defaults.lat, this.defaults.lon, this.defaults.distance);
  }

  /** Radians of rotation per screen pixel, so the ground roughly follows the pointer. */
  radiansPerPixel(viewportHeight: number): number {
    // Globe view: what moves under the pointer is the surface, at the altitude.
    // Slab view: it's the region around the target, at the orbit distance.
    const scale = this.isGlobeView ? Math.max(this.distance - 1, 0.01) : this.distance;
    const perPx = (2 * scale * Math.tan(this.fovY / 2)) / Math.max(viewportHeight, 1);
    return Math.min(perPx, 4 / Math.max(viewportHeight, 1));
  }

  beginDrag(): void {
    this.flight = null;
    this.dragging = true;
    this.angularVelocity[0] = 0;
    this.angularVelocity[1] = 0;
    this.idleTime = 0;
  }

  /**
   * Rotates the view by a pointer movement in CSS pixels.
   * `dt` (seconds since the previous move) feeds the release inertia.
   */
  drag(dxPx: number, dyPx: number, viewportHeight: number, dt: number): void {
    const k = this.radiansPerPixel(viewportHeight);
    // Dragging right moves the globe right, so the camera orbits left (negative yaw).
    const yaw = -dxPx * k;
    const pitch = -dyPx * k;
    this.rotateLocal(yaw, pitch);
    this.idleTime = 0;

    if (dt > 0) {
      // Smooth the velocity a little so one jittery event doesn't fling the globe.
      const blend = 0.6;
      this.angularVelocity[0] = this.angularVelocity[0] * (1 - blend) + (yaw / dt) * blend;
      this.angularVelocity[1] = this.angularVelocity[1] * (1 - blend) + (pitch / dt) * blend;
    }
  }

  /** `stale` = the pointer stopped before release, so there is no fling. */
  endDrag(stale = false): void {
    this.dragging = false;
    if (stale) {
      this.angularVelocity[0] = 0;
      this.angularVelocity[1] = 0;
    }
    const maxSpeed = 6; // rad/s
    for (const i of [0, 1] as const) {
      this.angularVelocity[i] = Math.max(-maxSpeed, Math.min(maxSpeed, this.angularVelocity[i]));
    }
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** Zooms by a factor (< 1 zooms in): the altitude in globe view, the orbit distance in slab view. */
  zoomBy(factor: number): void {
    if (this.flight) {
      this.flight = null;
      this.targetDistance = this.distance;
    }
    if (this.isGlobeView) {
      const altitude = (this.targetDistance - 1) * factor;
      this.targetDistance = clamp(1 + altitude, this.minDistance, this.maxDistance);
    } else {
      this.targetDistance = clamp(this.targetDistance * factor, 0.15, this.maxDistance);
    }
    this.idleTime = 0;
  }

  /** Rotation about the camera's own up (yaw) and right (pitch) axes. */
  rotateLocal(yaw: number, pitch: number): void {
    const q = this.orientation;
    // Post-multiplying applies the rotation in the camera's local frame.
    quat.multiply(q, q, quat.setAxisAngle(this.tmpQ, LOCAL_Y, yaw));
    quat.multiply(q, q, quat.setAxisAngle(this.tmpQ, LOCAL_X, pitch));
    quat.normalize(q, q);
  }

  /** Rotation about an axis fixed in world space (e.g. the planet's spin axis). */
  rotateWorld(axis: vec3, angle: number): void {
    const q = this.orientation;
    // Pre-multiplying applies the rotation in the world frame.
    quat.multiply(q, quat.setAxisAngle(this.tmpQ, axis, angle), q);
    quat.normalize(q, q);
  }

  update(dt: number): void {
    // 0. A fly-to animation overrides everything else until it lands.
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.duration);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2; // ease in-out cubic
      quat.slerp(this.orientation, f.from, f.to, e);
      quat.normalize(this.orientation, this.orientation);
      vec3.lerp(this.target, f.fromTarget, f.toTarget, e);
      this.distance = f.fromDistance + (f.toDistance - f.fromDistance) * e;
      this.targetDistance = this.distance;
      this.idleTime = 0;
      if (f.t >= 1) {
        this.flight = null;
        if (vec3.length(f.toTarget) < 1e-4) vec3.zero(this.target); // land exactly on the globe view
      }
      this.keepAboveSurface();
      return;
    }

    // 1. Inertia after a fling, decaying exponentially (frame-rate independent).
    if (!this.dragging) {
      const [vx, vy] = this.angularVelocity;
      if (Math.abs(vx) + Math.abs(vy) > 1e-4) {
        this.rotateLocal(vx * dt, vy * dt);
        const decay = Math.exp(-dt * 3.5);
        this.angularVelocity[0] *= decay;
        this.angularVelocity[1] *= decay;
      } else {
        this.angularVelocity[0] = 0;
        this.angularVelocity[1] = 0;
      }
    }

    // 2. Smooth zoom toward the target distance.
    this.distance += (this.targetDistance - this.distance) * (1 - Math.exp(-dt * 10));

    // 3. Idle auto-spin about the planet's axis, easing in over one second (globe view only).
    const moving = Math.abs(this.angularVelocity[0]) + Math.abs(this.angularVelocity[1]) > 0.01;
    if (this.dragging || moving) {
      this.idleTime = 0;
    } else {
      this.idleTime += dt;
    }
    if (this.autoSpin && !this.autoSpinHold && this.isGlobeView && this.idleTime > this.autoSpinDelay) {
      const ease = Math.min(1, this.idleTime - this.autoSpinDelay);
      // Negative angle about +Y moves the camera westward: the planet turns eastward, like the real Earth.
      this.rotateWorld(WORLD_UP, -this.autoSpinSpeed * ease * dt);
    }

    // 4. Settle the roll so north (or local up) points up the screen.
    if (this.northUp && !this.dragging) {
      this.correctRoll(1 - Math.exp(-dt * 3));
    }

    this.keepAboveSurface();
  }

  /** Rolls the camera a fraction `amount` (0–1) of the way to "up is up". */
  correctRoll(amount: number): void {
    const back = vec3.transformQuat(this.tmpV, LOCAL_Z, this.orientation);
    const up = vec3.transformQuat(this.tmpV2, LOCAL_Y, this.orientation);
    // Globe view: north up. Slab view: the local vertical at the target, so a cross-section stays level.
    const reference = this.isGlobeView ? WORLD_UP : vec3.normalize(vec3.create(), this.target);
    const desired = vec3.scaleAndAdd(this.tmpV3, reference, back, -vec3.dot(reference, back));
    if (vec3.length(desired) < 0.05) return; // looking straight along the reference: any roll is fine
    vec3.normalize(desired, desired);
    const cross = vec3.cross(vec3.create(), up, desired);
    const angle = Math.atan2(vec3.dot(cross, back), vec3.dot(up, desired));
    if (Math.abs(angle) < 1e-5) return;
    this.rotateWorld(back, angle * amount);
  }

  /** In a slab view the orbit can swing the camera into the planet: push it back out along its line of sight. */
  private keepAboveSurface(): void {
    const back = vec3.transformQuat(this.tmpV, LOCAL_Z, this.orientation);
    const t = this.target;
    const tb = vec3.dot(t, back);
    const eyeR2 = vec3.squaredLength(t) + 2 * this.distance * tb + this.distance * this.distance;
    if (eyeR2 >= MIN_EYE_RADIUS * MIN_EYE_RADIUS) return;
    // Solve |t + back·d| = MIN_EYE_RADIUS for the smallest d beyond the current one.
    const disc = tb * tb - vec3.squaredLength(t) + MIN_EYE_RADIUS * MIN_EYE_RADIUS;
    const d = -tb + Math.sqrt(Math.max(0, disc));
    this.distance = Math.max(this.distance, d);
    this.targetDistance = Math.max(this.targetDistance, this.distance);
  }

  /**
   * The "altitude" marker sizes are based on. In globe view it is the real altitude.
   * In a slab view the camera is close to the ground but looking across a wide region,
   * so it uses the orbit distance instead (scaled so a tour view draws markers near
   * their base size). Blended by how far the target is from the centre, so a flight
   * between the two never makes markers jump.
   */
  markerAltitude(): number {
    const altitude = vec3.length(this.eye) - 1;
    const w = this.slabWeight();
    return altitude + (this.distance * 7 - altitude) * w;
  }

  /** 0 in globe view, rising to 1 as the target moves out to a slab view (smooth during flights). */
  slabWeight(): number {
    return Math.min(1, vec3.length(this.target) / 0.9);
  }

  get eye(): vec3 {
    const offset = vec3.transformQuat(vec3.create(), vec3.fromValues(0, 0, this.distance), this.orientation);
    return vec3.add(offset, offset, this.target);
  }

  /** The camera's axes in world space. */
  basis(): { right: vec3; up: vec3; back: vec3 } {
    return {
      right: vec3.transformQuat(vec3.create(), LOCAL_X, this.orientation),
      up: vec3.transformQuat(vec3.create(), LOCAL_Y, this.orientation),
      back: vec3.transformQuat(vec3.create(), LOCAL_Z, this.orientation),
    };
  }

  viewMatrix(out = mat4.create()): mat4 {
    const { up } = this.basis();
    return mat4.lookAt(out, this.eye, this.target, up);
  }

  /** WebGPU clip space has depth 0…1, hence perspectiveZO (not the OpenGL −1…1 version). */
  projectionMatrix(aspect: number, out = mat4.create()): mat4 {
    const eyeRadius = vec3.length(this.eye);
    const altitude = eyeRadius - 1;
    const near = Math.max(0.0005, altitude * 0.3);
    const far = eyeRadius + 2;
    return mat4.perspectiveZO(out, this.fovY, aspect, near, far);
  }

  viewProjection(aspect: number, out = mat4.create()): mat4 {
    return mat4.multiply(out, this.projectionMatrix(aspect), this.viewMatrix());
  }
}

/** Orientation that looks down at lat/lon from above, with north up the screen. */
export function orientationFor(lat: number, lon: number, out: quat): quat {
  const back = vec3.fromValues(...latLonToCartesian(lat, lon));
  vec3.normalize(back, back);
  const right = vec3.cross(vec3.create(), WORLD_UP, back);
  if (vec3.length(right) < 1e-6) vec3.set(right, 1, 0, 0); // looking straight at a pole
  vec3.normalize(right, right);
  const up = vec3.cross(vec3.create(), back, right);
  return fromBasis(right, up, back, out);
}

/**
 * Orientation for standing at lat/lon and looking toward a compass heading
 * (0 = north, 90 = east), tilted down by `pitchDeg`, with the local vertical up.
 */
export function orientationLooking(lat: number, lon: number, headingDeg: number, pitchDeg: number, out: quat): quat {
  const radial = vec3.normalize(vec3.create(), vec3.fromValues(...latLonToCartesian(lat, lon)));
  const east = vec3.cross(vec3.create(), WORLD_UP, radial);
  if (vec3.length(east) < 1e-6) vec3.set(east, 1, 0, 0);
  vec3.normalize(east, east);
  const north = vec3.cross(vec3.create(), radial, east);

  const h = (headingDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const look = vec3.create();
  vec3.scaleAndAdd(look, look, north, Math.cos(h) * Math.cos(p));
  vec3.scaleAndAdd(look, look, east, Math.sin(h) * Math.cos(p));
  vec3.scaleAndAdd(look, look, radial, -Math.sin(p));

  const back = vec3.negate(vec3.create(), look);
  const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), radial, back));
  const up = vec3.cross(vec3.create(), back, right);
  return fromBasis(right, up, back, out);
}

function fromBasis(right: vec3, up: vec3, back: vec3, out: quat): quat {
  // Rotation matrix whose columns are the camera's axes in world space.
  const m = mat3.fromValues(right[0], right[1], right[2], up[0], up[1], up[2], back[0], back[1], back[2]);
  quat.fromMat3(out, m);
  return quat.normalize(out, out);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

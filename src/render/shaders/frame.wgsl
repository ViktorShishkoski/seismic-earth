// Shared per-frame uniforms (bind group 0), prepended to every layer's shader.
// Layout must match FrameUniforms.ts.

struct Frame {
  viewProj: mat4x4f,
  cameraPos: vec4f,   // xyz = camera position in world space (Earth radii)
  sunDir: vec4f,      // xyz = unit vector pointing toward the sun
  params: vec4f,      // x = time (s), y = exposure, z = ambient, w = unused
  viewport: vec4f,    // x = width px, y = height px, z = device pixel ratio, w = unused
  scene: vec4f,       // x = cutaway amount 0…1, y = depth exaggeration, z = night-side lights 0…1, w = slab-view focus 0…1
};

@group(0) @binding(0) var<uniform> frame: Frame;

const EARTH_RADIUS_KM = 6371.0;
const CORE_RADIUS = 0.5462; // outer core / mantle boundary, 3,480 km

// Where a quake sits for the current view: on the surface (cutaway 0) or at
// its true depth below it (cutaway 1), with optional depth exaggeration.
fn quake_radius(depthKm: f32) -> f32 {
  let r = 1.0 - max(depthKm, 0.0) * frame.scene.y / EARTH_RADIUS_KM;
  return mix(1.0, max(r, CORE_RADIUS + 0.02), frame.scene.x);
}

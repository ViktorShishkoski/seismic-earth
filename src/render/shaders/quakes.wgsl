// Seismic Earth — earthquake markers
//
// One instanced draw call renders every earthquake: each instance is a
// camera-facing quad (4 vertices, triangle strip) whose fragment shader
// carves out a disc, a dark outline, an optional pulse ring and a highlight.
//
// Marker size is computed in *screen pixels* (with a gentle zoom factor), so
// a small quake stays visible from orbit and a big one doesn't swallow a
// continent.
//
// Surface view: markers beyond the horizon are culled in the vertex shader
// rather than depth-tested, which avoids z-fighting with the globe surface.
// Cutaway view: markers sink to their true depth (see quake_radius in
// frame.wgsl) and are depth-tested against the core; those on the far side of
// the planet stay visible through the crust but dimmed, so the near side reads first.

struct QuakeParams {
  stops: array<vec4f, 6>,  // rgb = sRGB colour, a = depth (km) where it applies
  size: vec4f,             // x = base px, y = growth per magnitude, z = min px, w = max px
  state: vec4f,            // x = zoom scale, y = data "now" (s), z = hovered index, w = selected index
  fade: vec4f,             // x = pulse window (s), y = fade start (s), z = fade end (s), w = min opacity
  focus: vec4f,            // xyz = unit direction of the region in focus, w = focus radius (km); see focus_fade
};

// In a slab view, quakes far from the region (along the line of sight) are faded
// out, like the swath a seismologist projects onto a cross-section.
// frame.scene.w = how much focus applies (0 in globe view, 1 in a slab view).
fn focus_fade(dir: vec3f) -> f32 {
  let km = acos(clamp(dot(dir, params.focus.xyz), -1.0, 1.0)) * EARTH_RADIUS_KM;
  let inside = 1.0 - smoothstep(params.focus.w, params.focus.w * 1.6, km);
  return mix(1.0, max(inside, 0.04), frame.scene.w);
}

@group(1) @binding(0) var<uniform> params: QuakeParams;

struct Instance {
  @location(0) posMag: vec4f,   // xyz = unit-sphere position, w = magnitude
  @location(1) info: vec4f,     // x = depth km, y = origin time (s, relative), z = flags, w = unused
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) local: vec2f,                     // quad coords, 1.0 = marker radius
  @location(1) @interpolate(flat) color: vec3f,  // linear RGB
  @location(2) @interpolate(flat) radiusPx: f32, // device pixels
  @location(3) @interpolate(flat) opacity: f32,
  @location(4) @interpolate(flat) pulse: f32,    // 0…1 strength of the "recent" pulse
  @location(5) @interpolate(flat) highlight: f32,// 0 none, 1 hovered, 2 selected
  @location(6) @interpolate(flat) phase: f32,    // per-instance pulse offset
};

const OUTLINE_PX = 1.25;
const OUTLINE_COLOR = vec3f(0.012, 0.016, 0.03);

fn srgb_to_linear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn depth_color(depthKm: f32) -> vec3f {
  let d = max(depthKm, 0.0);
  var c = params.stops[0].rgb;
  for (var i = 1u; i < 6u; i++) {
    let lo = params.stops[i - 1u];
    let hi = params.stops[i];
    let t = clamp((d - lo.a) / (hi.a - lo.a), 0.0, 1.0);
    c = select(c, mix(lo.rgb, hi.rgb, t), d >= lo.a);
  }
  return srgb_to_linear(c); // interpolate in sRGB (like the CSS legend), shade in linear
}

fn hash(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return f32((x >> 22u) ^ x) / 4294967295.0;
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, inst: Instance) -> VSOut {
  var out: VSOut;
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;

  // Horizon test: a surface point p is visible when the angle between p and the
  // camera is less than the horizon angle, i.e. dot(p, eye/|eye|) > 1/|eye|.
  let dir = inst.posMag.xyz;
  let center = dir * quake_radius(inst.info.x);
  let eye = frame.cameraPos.xyz;
  let eyeLen = length(eye);
  let horizonCos = 1.0 / eyeLen;
  let facing = dot(dir, eye / eyeLen);
  let surfaceVis = smoothstep(horizonCos, horizonCos + 0.035, facing);
  let interiorVis = mix(0.28, 1.0, smoothstep(horizonCos - 0.15, horizonCos + 0.05, facing));
  let visibility = mix(surfaceVis, interiorVis, frame.scene.x) * focus_fade(dir);
  if (visibility <= 0.0) {
    out.clip = vec4f(2.0, 2.0, 2.0, 1.0); // outside clip space: the GPU discards it
    return out;
  }

  let mag = inst.posMag.w;
  let dpr = frame.viewport.z;
  let radiusCss = clamp(params.size.x * pow(params.size.y, mag - 4.0), params.size.z, params.size.w) * params.state.x;
  let radiusPx = radiusCss * dpr;

  let age = params.state.y - inst.info.y;
  let isNew = (u32(inst.info.z) & 1u) == 1u;
  let recent = select(0.0, 1.0 - smoothstep(0.0, params.fade.x, age), age >= 0.0);
  let pulse = max(recent, select(0.0, 1.0, isNew && age < params.fade.x * 2.0));

  let index = f32(ii);
  var highlight = 0.0;
  if (index == params.state.z) { highlight = 1.0; }
  if (index == params.state.w) { highlight = 2.0; }

  // Grow the quad enough to hold the outline, the pulse ring or the highlight ring.
  var extent = 1.0 + (OUTLINE_PX + 1.0) * dpr / radiusPx;
  if (pulse > 0.0) { extent = max(extent, 3.4); }
  if (highlight > 0.0) { extent = max(extent, 1.0 + 7.0 * dpr / radiusPx); }

  var clip = frame.viewProj * vec4f(center, 1.0);
  clip = vec4f(clip.xy + corner * extent * radiusPx * 2.0 / frame.viewport.xy * clip.w, clip.zw);

  let opacity = mix(1.0, params.fade.w, smoothstep(params.fade.y, params.fade.z, age)) * visibility;

  out.clip = clip;
  out.local = corner * extent;
  out.color = depth_color(inst.info.x);
  out.radiusPx = radiusPx;
  out.opacity = opacity;
  out.pulse = pulse;
  out.highlight = highlight;
  out.phase = hash(ii);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  let px = 1.0 / in.radiusPx;                // one device pixel in local units
  let dpr = frame.viewport.z;

  // Filled disc with a one-pixel anti-aliased edge.
  let fill = 1.0 - smoothstep(1.0 - px, 1.0, d);
  // Dark outline just outside the disc, so markers read on bright desert and ice.
  let o = OUTLINE_PX * dpr * px;
  let outline = (1.0 - smoothstep(1.0 + o - px, 1.0 + o, d)) * (1.0 - fill);

  // Shade the disc slightly toward the centre so overlapping markers separate.
  let shade = mix(0.82, 1.0, 1.0 - d * d);
  var rgb = in.color * shade * fill * 0.92 + OUTLINE_COLOR * outline * 0.7;
  var a = fill * 0.92 + outline * 0.7;

  // Expanding ring for recent quakes (premultiplied, so it adds light on top).
  if (in.pulse > 0.0) {
    let t = fract(frame.params.x / 2.2 + in.phase);
    let ringR = 1.0 + 2.2 * t;
    let ring = 1.0 - smoothstep(0.0, 1.6 * dpr * px + 0.05, abs(d - ringR));
    let ringA = ring * (1.0 - t) * in.pulse * 0.9;
    rgb += in.color * ringA;
    a = a + ringA * (1.0 - a);
  }

  // Hover (soft white) and selection (bright white) rings.
  if (in.highlight > 0.0) {
    let ringR = 1.0 + 3.5 * dpr * px;
    let ring = 1.0 - smoothstep(0.6 * dpr * px, 1.6 * dpr * px, abs(d - ringR));
    let strength = select(0.65, 1.0, in.highlight > 1.5);
    rgb = rgb * (1.0 - ring * strength) + vec3f(1.0) * ring * strength;
    a = a + ring * strength * (1.0 - a);
  }

  let opacity = select(in.opacity, max(in.opacity, 0.95), in.highlight > 0.0);
  a = min(a, 1.0) * opacity;
  if (a < 0.002) { discard; }
  return vec4f(rgb * opacity, a);
}

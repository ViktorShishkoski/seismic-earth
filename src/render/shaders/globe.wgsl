// Seismic Earth — globe (crust) shader
//
// `frame` (bind group 0) comes from frame.wgsl, prepended at build time.
// Lighting is done in linear colour space: colour textures are sampled through
// sRGB formats (decoded to linear by the GPU) and the result is written to an
// sRGB view of the canvas (encoded back by the GPU).
//
// In cutaway mode the same shader draws the crust as a translucent shell so the
// earthquakes inside the planet show through; the rim stays more opaque, like
// looking through the edge of a glass ball.

@group(1) @binding(0) var texSampler: sampler;
@group(1) @binding(1) var dayTexture: texture_2d<f32>;
@group(1) @binding(2) var waterMask: texture_2d<f32>;
@group(1) @binding(3) var nightTexture: texture_2d<f32>;

struct VSIn {
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
  var out: VSOut;
  out.world = in.position;              // unit sphere: radius 1 = Earth's surface
  out.clip = frame.viewProj * vec4f(in.position, 1.0);
  out.uv = in.uv;
  return out;
}

const SUN_COLOR = vec3f(1.0, 0.96, 0.9);
const HAZE_COLOR = vec3f(0.28, 0.52, 1.0);
const TWILIGHT_COLOR = vec3f(1.0, 0.42, 0.16);
const CITY_COLOR = vec3f(1.0, 0.78, 0.48);

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let n = normalize(in.world);                         // sphere normal = position
  let v = normalize(frame.cameraPos.xyz - in.world);   // toward the camera
  let l = normalize(frame.sunDir.xyz);                 // toward the sun

  let albedo = textureSample(dayTexture, texSampler, in.uv).rgb;
  let water = textureSample(waterMask, texSampler, in.uv).r;
  let city = textureSample(nightTexture, texSampler, in.uv).rgb;

  let ndl = dot(n, l);
  let ndv = max(dot(n, v), 0.0);

  // Soft terminator: real twilight is a band ~18° wide, not a hard line.
  let daylight = smoothstep(-0.1, 0.25, ndl);
  let diffuse = max(ndl, 0.0) * 0.85 + daylight * 0.15;

  // Sun glint on water only (Blinn-Phong + Schlick-style Fresnel boost).
  let h = normalize(l + v);
  let fresnel = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  let glint = pow(max(dot(n, h), 0.0), 220.0) * (0.35 + fresnel) * water * daylight;

  // Thin blue haze toward the limb — a stand-in until the Phase 6 atmosphere.
  let haze = HAZE_COLOR * pow(1.0 - ndv, 2.5) * (0.12 + 0.6 * daylight);

  let ambient = frame.params.z;
  var color = albedo * (ambient + diffuse) * SUN_COLOR + glint * SUN_COLOR * 0.45 + haze;

  // Night side: city lights fade in past the terminator; a warm band marks twilight.
  let night = frame.scene.z;
  let darkness = 1.0 - smoothstep(-0.18, 0.04, ndl);
  let lights = pow(city, vec3f(1.25)) * CITY_COLOR * 1.6;
  let twilight = TWILIGHT_COLOR * exp(-pow(ndl / 0.06, 2.0)) * 0.022;
  color += (lights * darkness + twilight) * night;
  color *= frame.params.y;

  // Cutaway: mostly transparent face-on, more opaque toward the rim.
  let shell = 0.14 + 0.55 * pow(1.0 - ndv, 3.0);
  let alpha = mix(1.0, shell, frame.scene.x);
  return vec4f(color, alpha);
}

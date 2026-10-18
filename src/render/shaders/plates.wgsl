// Seismic Earth — tectonic plate boundaries
//
// WebGPU only draws 1-pixel lines, so each boundary segment is an instanced
// quad expanded sideways in screen space to a chosen width, with a soft edge
// and a dark casing so the line reads over bright desert and ice.

struct PlateParams {
  styles: array<vec4f, 3>,  // rgb = sRGB colour, a = width in CSS px (convergent, divergent, transform)
  misc: vec4f,              // x = opacity, y = casing px, z, w unused
};

@group(1) @binding(0) var<uniform> params: PlateParams;

struct Segment {
  @location(0) a: vec4f,  // xyz = start (lifted just above the surface), w = type index
  @location(1) b: vec4f,  // xyz = end, w = spreading/convergence rate mm/yr (unused for now)
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) across: f32,                       // signed px from the centre line
  @location(1) @interpolate(flat) halfWidth: f32, // px
  @location(2) @interpolate(flat) color: vec3f,   // linear RGB
  @location(3) fade: f32,
};

fn srgb_to_linear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, seg: Segment) -> VSOut {
  var out: VSOut;
  let t = f32(vi & 1u);                              // 0 = start, 1 = end
  let side = select(-1.0, 1.0, ((vi >> 1u) & 1u) == 1u);

  let ca = frame.viewProj * vec4f(seg.a.xyz, 1.0);
  let cb = frame.viewProj * vec4f(seg.b.xyz, 1.0);
  if (ca.w <= 0.0 || cb.w <= 0.0) {
    out.clip = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }

  let dpr = frame.viewport.z;
  let halfViewport = frame.viewport.xy * 0.5;
  let sa = ca.xy / ca.w * halfViewport;
  let sb = cb.xy / cb.w * halfViewport;
  var d = sb - sa;
  if (length(d) < 1e-4) { d = vec2f(1.0, 0.0); }
  let along = normalize(d);
  let normal = vec2f(-along.y, along.x);

  let style = params.styles[min(u32(seg.a.w), 2u)];
  let halfWidth = style.a * dpr * 0.5;
  let extent = halfWidth + params.misc.y * dpr + 1.0;

  var clip = select(ca, cb, t > 0.5);
  // Widen sideways, and stretch a little along the segment so joints overlap.
  let offsetPx = normal * side * extent + along * (t * 2.0 - 1.0) * halfWidth;
  clip = vec4f(clip.xy + offsetPx / halfViewport * clip.w, clip.zw);

  // In cutaway the crust no longer hides the far side: dim those lines instead.
  let p = normalize(mix(seg.a.xyz, seg.b.xyz, t));
  let eye = frame.cameraPos.xyz;
  let eyeLen = length(eye);
  let facing = dot(p, eye / eyeLen) - 1.0 / eyeLen;
  // Far-side lines fade in only as the crust turns see-through (none at all in the surface view).
  let farSide = mix(0.16 * frame.scene.x, 1.0, smoothstep(-0.06, 0.02, facing));

  out.clip = clip;
  out.across = side * extent;
  out.halfWidth = halfWidth;
  out.color = srgb_to_linear(style.rgb);
  out.fade = farSide * params.misc.x;
  return out;
}

const CASING = vec3f(0.01, 0.014, 0.025);

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let dist = abs(in.across);
  let casingPx = params.misc.y * frame.viewport.z;
  let core = 1.0 - smoothstep(in.halfWidth - 0.6, in.halfWidth + 0.6, dist);
  let casing = (1.0 - smoothstep(in.halfWidth + casingPx - 0.6, in.halfWidth + casingPx + 0.6, dist)) - core;
  let rgb = in.color * core + CASING * casing * 0.5;
  let a = (core + casing * 0.5) * in.fade;
  if (a < 0.003) { discard; }
  return vec4f(rgb * in.fade, a); // premultiplied
}

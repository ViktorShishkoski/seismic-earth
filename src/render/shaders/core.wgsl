// Seismic Earth — Earth's outer core, shown in cutaway mode.
//
// Earthquakes stop at about 700 km depth; the core starts at 2,890 km. Drawing
// it gives the interior a sense of scale and hides the far side of the planet
// behind it, so the slabs in front read clearly.

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
};

@vertex
fn vs_main(@location(0) position: vec3f) -> VSOut {
  var out: VSOut;
  // Grows out from the centre as cutaway fades in, so it never pops.
  let r = CORE_RADIUS * smoothstep(0.0, 1.0, frame.scene.x);
  out.clip = frame.viewProj * vec4f(position * r, 1.0);
  out.normal = position;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let p = n * CORE_RADIUS;
  let v = normalize(frame.cameraPos.xyz - p);
  let ndv = max(dot(n, v), 0.0);

  // Molten look: dark red face-on, glowing orange toward the rim, a soft key light.
  let rim = pow(1.0 - ndv, 2.2);
  let key = max(dot(n, normalize(frame.sunDir.xyz)), 0.0);
  let base = vec3f(0.11, 0.025, 0.012);
  let glow = vec3f(0.85, 0.28, 0.06);
  let color = base * (0.55 + 0.45 * key) + glow * rim * 0.55;
  return vec4f(color * frame.params.y, 1.0);
}

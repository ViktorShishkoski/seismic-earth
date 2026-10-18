// Seismic Earth — P and S wavefronts
//
// Draws the expanding shock fronts of every quake the compute scan found still
// radiating. The geometry is the globe's own sphere, nudged a hair outward and
// blended additively: nothing is displaced, the fronts are light laid over the
// surface.
//
// The trick is which way round the arithmetic runs. Asking "where is the front
// now?" means inverting the travel-time table once per quake and then testing
// every pixel against a moving circle. Instead each pixel asks "when does the
// wave reach *me*?" — one table lookup on its own angular distance from the
// epicentre — and lights up when the elapsed time matches. Both fronts fall
// out of the same lookup, curving correctly as they go, because the table
// already knows that a ray diving deeper travels faster.
//
// P is drawn cool and thin, S warm and heavier: the first is the warning, the
// second is the shaking.

struct Wave {
  origin: vec4f, // xyz = epicentre direction, w = depth km
  info: vec4f,   // x = elapsed seconds, y = magnitude, z = index
};

struct WaveList {
  count: u32,
  // Three plain u32s rather than a vec3u: that would align to 16 and push
  // the list to offset 32, leaving the buffer 16 bytes short.
  pad: array<u32, 3>,
  items: array<Wave, MAX_WAVES>,
};

struct WaveParams {
  control: vec4f,              // x = overall strength 0…1, y = front half-width (s), z = wake decay (s), w = unused
  table: array<vec4f, TRAVEL_SAMPLES>, // x = P arrival (s), y = S arrival (s), per 5° of distance
};

@group(1) @binding(0) var<storage, read> waves: WaveList;
@group(1) @binding(1) var<uniform> params: WaveParams;

const STEP_DEG = 5.0;
const MAX_DEG = STEP_DEG * f32(TRAVEL_SAMPLES - 1u);
const P_COLOR = vec3f(0.52, 0.86, 1.0);
const S_COLOR = vec3f(1.0, 0.52, 0.34);

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) dir: vec3f, // direction from the planet's centre, interpolated
};

@vertex
fn vs_main(@location(0) position: vec3f) -> VSOut {
  var out: VSOut;
  // A whisker above the surface so the fronts win the depth test against it.
  out.clip = frame.viewProj * vec4f(position * 1.0015, 1.0);
  out.dir = position;
  return out;
}

/** Linear interpolation into the travel-time table; see geo/travelTime.ts. */
fn sample_index(deltaDeg: f32) -> vec3f {
  let x = clamp(deltaDeg / STEP_DEG, 0.0, f32(TRAVEL_SAMPLES - 1u));
  let i = floor(x);
  return vec3f(i, min(i + 1.0, f32(TRAVEL_SAMPLES - 1u)), x - i);
}

fn p_arrival(deltaDeg: f32) -> f32 {
  let s = sample_index(deltaDeg);
  return mix(params.table[u32(s.x)].x, params.table[u32(s.y)].x, s.z);
}

fn s_arrival(deltaDeg: f32) -> f32 {
  let s = sample_index(deltaDeg);
  return mix(params.table[u32(s.x)].y, params.table[u32(s.y)].y, s.z);
}

/**
 * Brightness at a pixel whose wave is `dt` seconds overdue (negative means it
 * hasn't arrived yet): a sharp crest at the front, and behind it a wake that
 * decays, so the disturbance reads as having swept past rather than vanished.
 */
fn front(dt: f32) -> f32 {
  let width = params.control.y;
  if (dt < -width) { return 0.0; }
  let crest = 1.0 - smoothstep(0.0, width, abs(dt));
  let wake = select(0.0, exp(-dt / params.control.z) * 0.4, dt > 0.0);
  return max(crest, wake);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let strength = params.control.x;
  if (strength <= 0.001) { discard; }

  let dir = normalize(in.dir);
  let n = min(waves.count, MAX_WAVES);
  var glow = vec3f(0.0);

  for (var i = 0u; i < n; i++) {
    let w = waves.items[i];
    let delta = degrees(acos(clamp(dot(dir, w.origin.xyz), -1.0, 1.0)));
    if (delta > MAX_DEG) { continue; }

    let elapsed = w.info.x;
    // Bigger quakes radiate visibly further; a moderate one stays a local flicker.
    let amp = clamp((w.info.y - 4.0) / 3.0, 0.12, 1.0);
    // Fade with distance travelled, and out entirely as the front leaves the table.
    let spread = 1.0 - 0.55 * smoothstep(0.0, MAX_DEG, delta);
    let life = 1.0 - smoothstep(0.78, 1.0, elapsed / params.table[TRAVEL_SAMPLES - 1u].y);

    let p = front(elapsed - p_arrival(delta));
    let s = front(elapsed - s_arrival(delta));
    glow += (P_COLOR * p * 0.75 + S_COLOR * s) * amp * spread * life;
  }

  let rgb = glow * strength;
  let a = clamp(max(rgb.r, max(rgb.g, rgb.b)), 0.0, 1.0);
  if (a < 0.003) { discard; }
  // Premultiplied: the fronts add light to whatever is already drawn.
  return vec4f(rgb, a);
}

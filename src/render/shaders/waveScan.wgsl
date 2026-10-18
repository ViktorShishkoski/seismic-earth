// Seismic Earth — wave scan (compute)
//
// Every frame this walks the whole earthquake buffer — which may hold tens of
// thousands of events — and writes out only the handful that are still
// radiating: those whose waves left less than ~26 minutes ago on the data
// clock and have not yet crossed the far edge of the travel-time table.
//
// This is stream compaction with an atomic counter. One invocation per quake,
// each testing its own event and claiming a slot in the output list only if it
// passes. The alternative would be reading the quakes back to the CPU and
// filtering them there every frame; the data is already on the GPU, so the
// scan happens where it lives. The list is small and bounded so the fragment
// shader can loop over it per pixel.

struct Instance {
  posMag: vec4f, // xyz = unit-sphere direction, w = magnitude
  info: vec4f,   // x = depth km, y = origin time (s, relative to epoch), z = flags
};

struct Wave {
  origin: vec4f, // xyz = epicentre direction, w = depth km
  info: vec4f,   // x = elapsed seconds, y = magnitude, z = index, w = unused
};

struct WaveList {
  count: atomic<u32>,
  // Three plain u32s rather than a vec3u: that would align to 16 and push
  // the list to offset 32, leaving the buffer 16 bytes short.
  pad: array<u32, 3>,
  items: array<Wave, MAX_WAVES>,
};

struct ScanParams {
  control: vec4f, // x = quake count, y = data "now" (s), z = minimum magnitude, w = longest travel time (s)
};

@group(0) @binding(0) var<storage, read> quakes: array<Instance>;
@group(0) @binding(1) var<storage, read_write> waves: WaveList;
@group(0) @binding(2) var<uniform> params: ScanParams;

@compute @workgroup_size(64)
fn scan(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(params.control.x)) { return; }

  let q = quakes[i];
  let elapsed = params.control.y - q.info.y;
  // Still to come, long finished, or too small to have been felt far away.
  if (elapsed <= 0.0 || elapsed > params.control.w) { return; }
  if (q.posMag.w < params.control.z) { return; }

  // Claim a slot. The counter is allowed to run past the list: the renderer
  // clamps what it reads, so an unusually busy minute simply draws the first
  // MAX_WAVES fronts rather than overflowing the buffer.
  let slot = atomicAdd(&waves.count, 1u);
  if (slot >= MAX_WAVES) { return; }

  waves.items[slot].origin = vec4f(q.posMag.xyz, q.info.x);
  waves.items[slot].info = vec4f(elapsed, q.posMag.w, f32(i), 0.0);
}

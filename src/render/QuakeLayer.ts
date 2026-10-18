import type { GpuContext } from '../gpu/device.ts';
import type { Quake } from '../data/quake.ts';
import { FLOATS_PER_QUAKE, QUAKE_STRIDE_BYTES, packQuakes } from '../data/pack.ts';
import { FRAME_WGSL, type FrameData, type FrameUniforms } from './FrameUniforms.ts';
import { DEPTH_FORMAT, SAMPLE_COUNT, type Layer } from './SceneRenderer.ts';
import { DEPTH_STOPS, MARKER_SIZE, hexToRgb, zoomScale } from './markerStyle.ts';
import quakesWgsl from './shaders/quakes.wgsl?raw';

const PARAM_FLOATS = 6 * 4 + 4 * 4; // 6 colour stops + size, state, fade, focus = 160 bytes

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * Draws every visible earthquake in one instanced draw call.
 * The instance buffer grows by doubling, so a refresh with a few new events
 * just rewrites the data without reallocating.
 */
export class QuakeLayer implements Layer {
  /** Events in GPU instance order (needed to map a picked index back to a quake). */
  quakes: readonly Quake[] = [];
  hoveredIndex = -1;
  selectedIndex = -1;
  /** "Now" on the data's clock, in seconds relative to `epochMs`. */
  dataNowSec = 0;
  /**
   * Reference time for packed timestamps (ms since epoch), reset on every upload
   * so the float32 seconds stored on the GPU stay small and precise.
   */
  epochMs = 0;
  /**
   * Bumped whenever the instance buffer is replaced by a larger one, so other
   * layers reading it (the wavefront scan) know to rebuild their bind groups.
   */
  instanceRevision = 0;

  private readonly device: GPUDevice;
  private readonly surfacePipeline: GPURenderPipeline;
  private readonly cutawayPipeline: GPURenderPipeline;
  private cutaway = 0;
  private readonly paramBuffer: GPUBuffer;
  private readonly params = new Float32Array(PARAM_FLOATS);
  private readonly bindGroup: GPUBindGroup;
  private instanceBuffer: GPUBuffer;
  private capacity = 0;
  private staging?: Float32Array<ArrayBuffer>;

  constructor(
    gpu: GpuContext,
    private readonly frame: FrameUniforms,
  ) {
    const { device } = gpu;
    this.device = device;

    this.paramBuffer = device.createBuffer({
      label: 'quake params',
      size: PARAM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Constant parts of the params: colour stops, size curve, fade timings.
    DEPTH_STOPS.forEach((stop, i) => {
      this.params.set([...hexToRgb(stop.hex), stop.depthKm], i * 4);
    });
    this.params.set([MARKER_SIZE.basePx, MARKER_SIZE.growth, MARKER_SIZE.minPx, MARKER_SIZE.maxPx], 24);
    this.params.set([HOUR, DAY, 30 * DAY, 0.42], 32);

    const layout = device.createBindGroupLayout({
      label: 'quake layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: 'quake bind group',
      layout,
      entries: [{ binding: 0, resource: { buffer: this.paramBuffer } }],
    });

    const module = device.createShaderModule({ label: 'quake shader', code: FRAME_WGSL + quakesWgsl });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, layout] });

    const descriptor = (depthCompare: GPUCompareFunction): GPURenderPipelineDescriptor => ({
      label: `quake pipeline (${depthCompare})`,
      layout: pipelineLayout,
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: QUAKE_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' },
              { shaderLocation: 1, offset: 16, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [
          {
            format: gpu.viewFormat,
            // Premultiplied alpha: the shader outputs colour already multiplied by alpha.
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare },
      multisample: { count: SAMPLE_COUNT },
    });

    // Surface view: markers are culled at the horizon in the shader, so they skip the
    // depth test (and never z-fight with the surface they sit on).
    this.surfacePipeline = device.createRenderPipeline(descriptor('always'));
    // Cutaway view: markers inside the planet are hidden by the core in front of them.
    this.cutawayPipeline = device.createRenderPipeline(descriptor('less'));

    this.instanceBuffer = this.allocate(1024);
  }

  /**
   * Uploads a new set of visible quakes (already sorted for draw order).
   * `nowMs` is "now" on the data's clock; ages are measured from it.
   */
  setQuakes(quakes: readonly Quake[], nowMs: number, newIds?: ReadonlySet<string>): void {
    this.quakes = quakes;
    this.epochMs = nowMs;
    if (quakes.length > this.capacity) {
      this.instanceBuffer.destroy();
      let capacity = this.capacity;
      while (capacity < quakes.length) capacity *= 2;
      this.instanceBuffer = this.allocate(capacity);
    }
    this.staging = packQuakes(quakes, this.epochMs, newIds, this.staging);
    if (quakes.length > 0) {
      this.device.queue.writeBuffer(this.instanceBuffer, 0, this.staging, 0, quakes.length * FLOATS_PER_QUAKE);
    }
  }

  prepare(frame: FrameData): void {
    this.cutaway = frame.cutaway;
    this.params[28] = zoomScale(frame.markerAltitude);
    this.params[29] = this.dataNowSec;
    this.params[30] = this.hoveredIndex;
    this.params[31] = this.selectedIndex;
    this.device.queue.writeBuffer(this.paramBuffer, 0, this.params);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.quakes.length === 0) return;
    pass.setPipeline(this.cutaway > 0.001 ? this.cutawayPipeline : this.surfacePipeline);
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.setBindGroup(1, this.bindGroup);
    pass.setVertexBuffer(0, this.instanceBuffer);
    pass.draw(4, this.quakes.length);
  }

  /**
   * Older events fade between `startSec` and `endSec` of age. Set per time window,
   * so a year of data isn't all faded out and an hour of data still shows which is newest.
   */
  /** Region a slab view concentrates on: unit direction + radius in km. */
  setFocus(dir: ArrayLike<number>, radiusKm: number): void {
    this.params[36] = dir[0] ?? 0;
    this.params[37] = dir[1] ?? 0;
    this.params[38] = dir[2] ?? 1;
    this.params[39] = radiusKm;
  }

  setFade(startSec: number, endSec: number): void {
    this.params[33] = startSec;
    this.params[34] = endSec;
  }

  /** The packed instances, also read by the wavefront compute scan. */
  instances(): GPUBuffer {
    return this.instanceBuffer;
  }

  private allocate(capacity: number): GPUBuffer {
    this.capacity = capacity;
    this.instanceRevision++;
    return this.device.createBuffer({
      label: `quake instances (${capacity})`,
      size: capacity * QUAKE_STRIDE_BYTES,
      // STORAGE as well as VERTEX: the wavefront scan reads the same data in a
      // compute pass instead of the CPU keeping a second copy.
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }
}

import type { GpuContext } from '../gpu/device.ts';
import type { SphereMesh } from '../geo/sphere.ts';
import { SPHERE_VERTEX_STRIDE } from '../geo/sphere.ts';
import { MAX_TRAVEL_SEC, TRAVEL_SAMPLES, packTravelTable } from '../geo/travelTime.ts';
import { FRAME_WGSL, type FrameData, type FrameUniforms } from './FrameUniforms.ts';
import { DEPTH_FORMAT, SAMPLE_COUNT, type Layer } from './SceneRenderer.ts';
import waveScanWgsl from './shaders/waveScan.wgsl?raw';
import wavesWgsl from './shaders/waves.wgsl?raw';

/**
 * How many fronts can be on screen at once. A quarter of an hour of M5+ events
 * is normally one or two; the cap exists so the fragment shader's per-pixel
 * loop stays bounded no matter how violent the hour (or how fast a replay runs).
 */
export const MAX_WAVES = 16;

/** Smallest magnitude worth drawing a front for. */
const MIN_MAGNITUDE = 4.5;

/** Seconds either side of the arrival time that count as "the front is here". */
const FRONT_HALF_WIDTH_SEC = 11;
/** How quickly the wake behind a front dies away. */
const WAKE_DECAY_SEC = 150;

const WAVE_BYTES = 32;
const LIST_BYTES = 16 + MAX_WAVES * WAVE_BYTES;
const PARAM_FLOATS = 4 + TRAVEL_SAMPLES * 4;

/** What the wave layer needs to know about the quakes already on the GPU. */
export interface WaveSource {
  /** The instance buffer the markers are drawn from. */
  instances(): GPUBuffer;
  /** Bumped whenever that buffer is replaced, so bind groups can be rebuilt. */
  readonly instanceRevision: number;
  /** How many instances are live. */
  readonly quakes: readonly unknown[];
  /** "Now" on the data clock, in seconds relative to the packed epoch. */
  readonly dataNowSec: number;
}

/**
 * P and S wavefronts spreading from every quake that is still radiating.
 *
 * Two passes per frame. A compute pass scans the whole quake buffer and
 * compacts the still-radiating events into a short list (see waveScan.wgsl);
 * a render pass then draws the globe's sphere again, additively, with each
 * pixel looking up when its own patch of ground gets hit (waves.wgsl).
 *
 * The clock is the data's, not the wall's: a front really does take about
 * thirteen minutes to cross a quarter of the planet. In a replay running at
 * speed that becomes a few seconds, which is where it's worth watching.
 */
export class WaveLayer implements Layer {
  /** 0 hides the fronts entirely; the UI eases this for the toggle. */
  strength = 1;

  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly scanPipeline: GPUComputePipeline;
  private readonly scanLayout: GPUBindGroupLayout;
  private readonly vertexBuffer: GPUBuffer;
  private readonly indexBuffer: GPUBuffer;
  private readonly indexCount: number;
  private readonly listBuffer: GPUBuffer;
  private readonly scanParamBuffer: GPUBuffer;
  private readonly paramBuffer: GPUBuffer;
  private readonly scanParams = new Float32Array(4);
  private readonly zero = new Uint32Array(4);
  private readonly drawBindGroup: GPUBindGroup;

  private scanBindGroup?: GPUBindGroup;
  private readback?: GPUBuffer;
  private scanRevision = -1;
  private cutaway = 0;

  constructor(
    gpu: GpuContext,
    private readonly frame: FrameUniforms,
    mesh: SphereMesh,
    private readonly source: WaveSource,
  ) {
    const { device } = gpu;
    this.device = device;
    this.indexCount = mesh.indexCount;

    // The fronts need the globe's geometry but none of its textures, so they
    // get their own slim copy of the mesh rather than a shared bind layout.
    this.vertexBuffer = device.createBuffer({
      label: 'wave vertices',
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices);
    this.indexBuffer = device.createBuffer({
      label: 'wave indices',
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices);

    this.listBuffer = device.createBuffer({
      label: 'active waves',
      size: LIST_BYTES,
      // COPY_SRC so `activeWaves()` can read back what the scan selected.
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.scanParamBuffer = device.createBuffer({
      label: 'wave scan params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.paramBuffer = device.createBuffer({
      label: 'wave params',
      size: PARAM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // The travel-time table never changes, so it is uploaded once.
    const params = new Float32Array(PARAM_FLOATS);
    params.set([1, FRONT_HALF_WIDTH_SEC, WAKE_DECAY_SEC, 0], 0);
    params.set(packTravelTable(), 4);
    device.queue.writeBuffer(this.paramBuffer, 0, params);

    const prelude = `const MAX_WAVES = ${MAX_WAVES}u;\nconst TRAVEL_SAMPLES = ${TRAVEL_SAMPLES}u;\n`;

    this.scanLayout = device.createBindGroupLayout({
      label: 'wave scan layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    this.scanPipeline = device.createComputePipeline({
      label: 'wave scan',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.scanLayout] }),
      compute: {
        module: device.createShaderModule({ label: 'wave scan shader', code: prelude + waveScanWgsl }),
        entryPoint: 'scan',
      },
    });

    const drawLayout = device.createBindGroupLayout({
      label: 'wave draw layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.drawBindGroup = device.createBindGroup({
      label: 'wave draw bind group',
      layout: drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.listBuffer } },
        { binding: 1, resource: { buffer: this.paramBuffer } },
      ],
    });

    const module = device.createShaderModule({
      label: 'wave shader',
      code: prelude + FRAME_WGSL + wavesWgsl,
    });
    this.pipeline = device.createRenderPipeline({
      label: 'wave pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frame.layout, drawLayout] }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: SPHERE_VERTEX_STRIDE,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [
          {
            format: gpu.viewFormat,
            // Additive, premultiplied: light on top of the surface, never subtracting.
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' },
      // Depth-tested so the fronts hug the near side, but writing nothing: the
      // markers drawn afterwards still sit on top.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less-equal' },
      multisample: { count: SAMPLE_COUNT },
    });
  }

  /** Runs the compaction scan. Called once per frame, before the render pass. */
  compute(encoder: GPUCommandEncoder): void {
    const count = this.source.quakes.length;
    // Always clear the counter, so a frame that skips the scan draws nothing
    // rather than last frame's fronts.
    this.device.queue.writeBuffer(this.listBuffer, 0, this.zero);
    if (count === 0 || this.strength <= 0.001) return;

    const buffer = this.source.instances();
    if (this.scanRevision !== this.source.instanceRevision || !this.scanBindGroup) {
      this.scanRevision = this.source.instanceRevision;
      this.scanBindGroup = this.device.createBindGroup({
        label: 'wave scan bind group',
        layout: this.scanLayout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: { buffer: this.listBuffer } },
          { binding: 2, resource: { buffer: this.scanParamBuffer } },
        ],
      });
    }

    this.scanParams.set([count, this.source.dataNowSec, MIN_MAGNITUDE, MAX_TRAVEL_SEC]);
    this.device.queue.writeBuffer(this.scanParamBuffer, 0, this.scanParams);

    const pass = encoder.beginComputePass({ label: 'wave scan pass' });
    pass.setPipeline(this.scanPipeline);
    pass.setBindGroup(0, this.scanBindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
  }

  prepare(frame: FrameData): void {
    this.cutaway = frame.cutaway;
  }

  /**
   * Reads back what the last scan selected: which quakes are radiating and how
   * long their waves have been travelling. Nothing on screen needs this — the
   * list never leaves the GPU in normal use — but it is how the browser tests
   * check that the compute pass found what the physics says it should.
   */
  async activeWaves(): Promise<Array<{ elapsedSec: number; magnitude: number; index: number }>> {
    this.readback ??= this.device.createBuffer({
      label: 'active waves readback',
      size: LIST_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = this.device.createCommandEncoder({ label: 'wave readback' });
    encoder.copyBufferToBuffer(this.listBuffer, 0, this.readback, 0, LIST_BYTES);
    this.device.queue.submit([encoder.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);
    const copy = this.readback.getMappedRange().slice(0);
    this.readback.unmap();
    // The scan's counter is allowed to overshoot the list; clamp it.
    const count = Math.min(new Uint32Array(copy, 0, 1)[0]!, MAX_WAVES);
    const floats = new Float32Array(copy, 16);
    return Array.from({ length: count }, (_, i) => ({
      elapsedSec: floats[i * 8 + 4]!,
      magnitude: floats[i * 8 + 5]!,
      index: floats[i * 8 + 6]!,
    }));
  }

  draw(pass: GPURenderPassEncoder): void {
    // In cutaway view the attention is inside the planet; the surface glow
    // would only wash out the slab, so it is dimmed well down.
    const strength = this.strength * (1 - 0.8 * this.cutaway);
    if (strength <= 0.001 || this.source.quakes.length === 0) return;
    this.device.queue.writeBuffer(this.paramBuffer, 0, new Float32Array([strength]));
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.setBindGroup(1, this.drawBindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(this.indexCount);
  }
}

import type { GpuContext } from '../gpu/device.ts';
import { BOUNDARY_STYLE, BOUNDARY_TYPES, FLOATS_PER_SEGMENT, buildSegmentInstances, type PlateBoundaries } from '../data/plates.ts';
import { FRAME_WGSL, type FrameUniforms } from './FrameUniforms.ts';
import { DEPTH_FORMAT, SAMPLE_COUNT, type Layer } from './SceneRenderer.ts';
import { hexToRgb } from './markerStyle.ts';
import platesWgsl from './shaders/plates.wgsl?raw';

/** Tectonic plate boundaries: one instanced draw of screen-space line segments. */
export class PlateLayer implements Layer {
  visible = true;
  opacity = 0.9;

  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly paramBuffer: GPUBuffer;
  private readonly params = new Float32Array(16);
  private readonly bindGroup: GPUBindGroup;
  private instanceBuffer: GPUBuffer | null = null;
  private count = 0;

  constructor(
    gpu: GpuContext,
    private readonly frame: FrameUniforms,
  ) {
    const { device } = gpu;
    this.device = device;

    BOUNDARY_TYPES.forEach((type, i) => {
      const style = BOUNDARY_STYLE[type];
      this.params.set([...hexToRgb(style.hex), style.widthPx], i * 4);
    });
    this.params[13] = 0.9; // casing px

    this.paramBuffer = device.createBuffer({
      label: 'plate params',
      size: this.params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layout = device.createBindGroupLayout({
      label: 'plate layout',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.bindGroup = device.createBindGroup({
      label: 'plate bind group',
      layout,
      entries: [{ binding: 0, resource: { buffer: this.paramBuffer } }],
    });

    const module = device.createShaderModule({ label: 'plate shader', code: FRAME_WGSL + platesWgsl });
    this.pipeline = device.createRenderPipeline({
      label: 'plate pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frame.layout, layout] }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: FLOATS_PER_SEGMENT * 4,
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
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
      // Lines sit just above the surface, so the opaque globe hides the far side.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
      multisample: { count: SAMPLE_COUNT },
    });
  }

  setBoundaries(plates: PlateBoundaries): void {
    const data = buildSegmentInstances(plates);
    this.instanceBuffer?.destroy();
    this.instanceBuffer = this.device.createBuffer({
      label: `plate segments (${plates.count})`,
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
    this.count = plates.count;
  }

  prepare(): void {
    this.params[12] = this.opacity;
    this.device.queue.writeBuffer(this.paramBuffer, 0, this.params);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.visible || !this.instanceBuffer || this.count === 0 || this.opacity <= 0.001) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.setBindGroup(1, this.bindGroup);
    pass.setVertexBuffer(0, this.instanceBuffer);
    pass.draw(4, this.count);
  }
}

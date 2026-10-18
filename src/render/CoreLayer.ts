import type { GpuContext } from '../gpu/device.ts';
import { SPHERE_VERTEX_STRIDE, createSphere } from '../geo/sphere.ts';
import { FRAME_WGSL, type FrameData, type FrameUniforms } from './FrameUniforms.ts';
import { DEPTH_FORMAT, SAMPLE_COUNT, type Layer } from './SceneRenderer.ts';
import coreWgsl from './shaders/core.wgsl?raw';

/** The outer core, drawn only while cutaway mode is (partly) on. */
export class CoreLayer implements Layer {
  private readonly pipeline: GPURenderPipeline;
  private readonly vertexBuffer: GPUBuffer;
  private readonly indexBuffer: GPUBuffer;
  private readonly indexCount: number;
  private visible = false;

  constructor(
    gpu: GpuContext,
    private readonly frame: FrameUniforms,
  ) {
    const { device } = gpu;
    const mesh = createSphere(48, 96);
    this.indexCount = mesh.indexCount;

    this.vertexBuffer = device.createBuffer({
      label: 'core vertices',
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices);
    this.indexBuffer = device.createBuffer({
      label: 'core indices',
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices);

    const module = device.createShaderModule({ label: 'core shader', code: FRAME_WGSL + coreWgsl });
    this.pipeline = device.createRenderPipeline({
      label: 'core pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frame.layout] }),
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
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: gpu.viewFormat }] },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: SAMPLE_COUNT },
    });
  }

  prepare(frame: FrameData): void {
    this.visible = frame.cutaway > 0.001;
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.visible) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(this.indexCount);
  }
}

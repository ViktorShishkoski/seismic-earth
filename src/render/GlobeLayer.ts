import type { GpuContext } from '../gpu/device.ts';
import { SPHERE_VERTEX_STRIDE, type SphereMesh } from '../geo/sphere.ts';
import { FRAME_WGSL, type FrameData, type FrameUniforms } from './FrameUniforms.ts';
import { DEPTH_FORMAT, SAMPLE_COUNT, type Layer } from './SceneRenderer.ts';
import globeWgsl from './shaders/globe.wgsl?raw';

export interface GlobeTextures {
  day: GPUTexture;
  water: GPUTexture;
  night: GPUTexture;
}

/**
 * The textured, lit Earth.
 *
 * Two pipelines share one shader: an opaque one that writes depth (normal
 * view), and a blended one without depth writes for cutaway mode, so the
 * crust tints what's behind it without hiding the earthquakes inside.
 */
export class GlobeLayer implements Layer {
  readonly triangleCount: number;

  private readonly opaque: GPURenderPipeline;
  private readonly translucent: GPURenderPipeline;
  private readonly vertexBuffer: GPUBuffer;
  private readonly indexBuffer: GPUBuffer;
  private readonly indexCount: number;
  private readonly bindGroup: GPUBindGroup;
  private cutaway = 0;

  constructor(
    gpu: GpuContext,
    private readonly frame: FrameUniforms,
    mesh: SphereMesh,
    textures: GlobeTextures,
  ) {
    const { device } = gpu;
    this.indexCount = mesh.indexCount;
    this.triangleCount = mesh.indexCount / 3;

    this.vertexBuffer = device.createBuffer({
      label: 'globe vertices',
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices);

    this.indexBuffer = device.createBuffer({
      label: 'globe indices',
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices);

    const layout = device.createBindGroupLayout({
      label: 'globe layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    const sampler = device.createSampler({
      label: 'globe sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat', // wraps across the ±180° seam
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 8, // keeps detail sharp near the limb
    });

    this.bindGroup = device.createBindGroup({
      label: 'globe bind group',
      layout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: textures.day.createView() },
        { binding: 2, resource: textures.water.createView() },
        { binding: 3, resource: textures.night.createView() },
      ],
    });

    const module = device.createShaderModule({ label: 'globe shader', code: FRAME_WGSL + globeWgsl });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, layout] });
    const vertex: GPUVertexState = {
      module,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: SPHERE_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
            { shaderLocation: 1, offset: 12, format: 'float32x2' }, // uv
          ],
        },
      ],
    };
    const primitive: GPUPrimitiveState = { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' };

    this.opaque = device.createRenderPipeline({
      label: 'globe pipeline (opaque)',
      layout: pipelineLayout,
      vertex,
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: gpu.viewFormat }] },
      primitive,
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: SAMPLE_COUNT },
    });

    this.translucent = device.createRenderPipeline({
      label: 'globe pipeline (cutaway)',
      layout: pipelineLayout,
      vertex,
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [
          {
            format: gpu.viewFormat,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive,
      // Tested against the core (which is in front of the far side) but writes nothing,
      // so the earthquakes drawn afterwards still show through.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
      multisample: { count: SAMPLE_COUNT },
    });
  }

  prepare(frame: FrameData): void {
    this.cutaway = frame.cutaway;
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.cutaway > 0.001 ? this.translucent : this.opaque);
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.setBindGroup(1, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(this.indexCount);
  }
}

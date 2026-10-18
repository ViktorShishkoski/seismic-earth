import type { GpuContext } from '../gpu/device.ts';
import { FrameUniforms, type FrameData } from './FrameUniforms.ts';

/** Settings every layer's pipeline must match to draw into the shared pass. */
export const SAMPLE_COUNT = 4; // 4× MSAA keeps the planet's edge and the markers smooth
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/** Something that draws itself into the scene's single render pass. */
export interface Layer {
  /** Optional per-frame CPU work (uploading uniforms) before the pass begins. */
  prepare?(frame: FrameData): void;
  /**
   * Optional GPU work that has to happen outside the render pass — a compute
   * pass, say. Encoded into the same command buffer, just ahead of the draw.
   */
  compute?(encoder: GPUCommandEncoder): void;
  draw(pass: GPURenderPassEncoder): void;
}

const CLEAR_COLOR: GPUColor = { r: 0.004, g: 0.006, b: 0.012, a: 1 };

/**
 * Owns the render targets and the frame uniforms, and runs one render pass
 * per frame in which each layer draws in order (globe first, then markers).
 */
export class SceneRenderer {
  readonly frame: FrameUniforms;
  readonly layers: Layer[] = [];

  private msaaTexture?: GPUTexture;
  private depthTexture?: GPUTexture;

  constructor(private readonly gpu: GpuContext) {
    this.frame = new FrameUniforms(gpu.device);
  }

  add(layer: Layer): void {
    this.layers.push(layer);
  }

  resize(width: number, height: number): void {
    this.msaaTexture?.destroy();
    this.depthTexture?.destroy();
    this.msaaTexture = this.gpu.device.createTexture({
      label: 'msaa colour',
      size: [width, height],
      format: this.gpu.viewFormat,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthTexture = this.gpu.device.createTexture({
      label: 'depth',
      size: [width, height],
      format: DEPTH_FORMAT,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  render(frame: FrameData): void {
    if (!this.msaaTexture || !this.depthTexture) return;
    const { device, context, viewFormat } = this.gpu;

    this.frame.write(frame);
    for (const layer of this.layers) layer.prepare?.(frame);

    const encoder = device.createCommandEncoder({ label: 'frame' });
    for (const layer of this.layers) layer.compute?.(encoder);
    const pass = encoder.beginRenderPass({
      label: 'scene pass',
      colorAttachments: [
        {
          view: this.msaaTexture.createView(),
          resolveTarget: context.getCurrentTexture().createView({ format: viewFormat }),
          clearValue: CLEAR_COLOR,
          loadOp: 'clear',
          storeOp: 'discard', // only the resolved image is kept
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    for (const layer of this.layers) layer.draw(pass);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}

/**
 * GPU mipmap generation.
 *
 * WebGPU has no built-in `generateMipmap()` like OpenGL, so each level is
 * rendered from the one above it with a full-screen triangle and a linear
 * (bilinear) filter. Without mips, a 4096-pixel Earth texture shimmers
 * badly when the whole planet fits in a few hundred screen pixels.
 */

const MIP_SHADER = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  // One triangle that covers the whole viewport.
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: VSOut;
  out.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(xy.x, 1.0 - xy.y);
  return out;
}

@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var srcTexture: texture_2d<f32>;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  return textureSample(srcTexture, srcSampler, in.uv);
}
`;

export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

export class MipmapGenerator {
  private readonly module: GPUShaderModule;
  private readonly sampler: GPUSampler;
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  constructor(private readonly device: GPUDevice) {
    this.module = device.createShaderModule({ label: 'mipmap generator', code: MIP_SHADER });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  /** Fills mip levels 1…N of `texture` from level 0. */
  generate(texture: GPUTexture): void {
    if (texture.mipLevelCount <= 1) return;
    const pipeline = this.pipelineFor(texture.format);
    const encoder = this.device.createCommandEncoder({ label: 'mipmap encoder' });

    for (let level = 1; level < texture.mipLevelCount; level++) {
      const bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
        ],
      });
      const pass = encoder.beginRenderPass({
        label: `mip level ${level}`,
        colorAttachments: [
          {
            view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }

    this.device.queue.submit([encoder.finish()]);
  }

  private pipelineFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.pipelines.get(format);
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        label: `mipmap pipeline (${format})`,
        layout: 'auto',
        vertex: { module: this.module, entryPoint: 'vs' },
        fragment: { module: this.module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(format, pipeline);
    }
    return pipeline;
  }
}

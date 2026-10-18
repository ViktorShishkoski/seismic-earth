import frameWgsl from './shaders/frame.wgsl?raw';

/** Values every layer needs, written once per frame into bind group 0. */
export interface FrameData {
  viewProj: Float32Array; // 16 floats, column-major
  cameraPos: ArrayLike<number>;
  sunDir: ArrayLike<number>;
  time: number;
  exposure: number;
  ambient: number;
  width: number;
  height: number;
  pixelRatio: number;
  /** 0 = quakes on the surface, opaque crust; 1 = quakes at true depth, see-through crust. */
  cutaway: number;
  /** Depth exaggeration in cutaway (1 = true scale). */
  depthScale: number;
  /** 0 = studio light (no night side), 1 = real sun with city lights at night. */
  nightLights: number;
  /** Altitude used for marker sizing (see OrbitCamera.markerAltitude). */
  markerAltitude: number;
  /** 0 = globe view, 1 = slab view: quakes far from the region fade out. */
  focus: number;
}

/** The WGSL declaration of the frame struct, to prepend to layer shaders. */
export const FRAME_WGSL = frameWgsl;

const FLOATS = 36; // mat4 + 5 × vec4 = 144 bytes

export class FrameUniforms {
  readonly buffer: GPUBuffer;
  readonly layout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;
  private readonly data = new Float32Array(FLOATS);

  constructor(private readonly device: GPUDevice) {
    this.buffer = device.createBuffer({
      label: 'frame uniforms',
      size: FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.layout = device.createBindGroupLayout({
      label: 'frame layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: 'frame bind group',
      layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: this.buffer } }],
    });
  }

  write(f: FrameData): void {
    const d = this.data;
    d.set(f.viewProj, 0);
    d[16] = f.cameraPos[0] ?? 0;
    d[17] = f.cameraPos[1] ?? 0;
    d[18] = f.cameraPos[2] ?? 0;
    d[20] = f.sunDir[0] ?? 0;
    d[21] = f.sunDir[1] ?? 0;
    d[22] = f.sunDir[2] ?? 0;
    d[24] = f.time;
    d[25] = f.exposure;
    d[26] = f.ambient;
    d[28] = f.width;
    d[29] = f.height;
    d[30] = f.pixelRatio;
    d[32] = f.cutaway;
    d[33] = f.depthScale;
    d[34] = f.nightLights;
    d[35] = f.focus;
    this.device.queue.writeBuffer(this.buffer, 0, d);
  }
}

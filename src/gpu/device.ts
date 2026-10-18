/**
 * WebGPU setup: adapter, device and the canvas swap chain.
 *
 * The canvas is configured in its preferred (non-sRGB) format, with an sRGB
 * *view* format alongside. The renderer draws through the sRGB view, so
 * shaders work in linear light and the GPU applies gamma encoding on write.
 */

export class WebGPUUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebGPUUnavailableError';
  }
}

export interface GpuContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  canvas: HTMLCanvasElement;
  /** Format the canvas texture is allocated in, e.g. 'bgra8unorm'. */
  canvasFormat: GPUTextureFormat;
  /** sRGB view of the canvas texture that render passes target. */
  viewFormat: GPUTextureFormat;
  adapterInfo: GPUAdapterInfo;
}

export async function initGpu(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new WebGPUUnavailableError('This browser does not expose the WebGPU API (navigator.gpu is missing).');
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new WebGPUUnavailableError(
      'The browser supports WebGPU but found no compatible GPU adapter. The GPU may be blocklisted or hardware acceleration may be off.',
    );
  }

  const device = await adapter.requestDevice({
    label: 'seismic-earth device',
    requiredLimits: {
      maxTextureDimension2D: Math.min(8192, adapter.limits.maxTextureDimension2D),
    },
  });

  device.addEventListener('uncapturederror', (event) => {
    console.error('[WebGPU] uncaptured error:', (event as GPUUncapturedErrorEvent).error.message);
  });

  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new WebGPUUnavailableError('Could not get a WebGPU context from the canvas.');
  }

  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  const viewFormat = toSrgb(canvasFormat);
  context.configure({
    device,
    format: canvasFormat,
    viewFormats: [viewFormat],
    alphaMode: 'opaque',
  });

  return { device, context, canvas, canvasFormat, viewFormat, adapterInfo: adapter.info };
}

function toSrgb(format: GPUTextureFormat): GPUTextureFormat {
  if (format === 'bgra8unorm') return 'bgra8unorm-srgb';
  if (format === 'rgba8unorm') return 'rgba8unorm-srgb';
  return format;
}

/**
 * Keeps the canvas backing store in sync with its CSS size × devicePixelRatio,
 * so the globe renders at full resolution on high-DPI screens.
 * Calls `onResize` with the new pixel size whenever it changes.
 */
export function observeCanvasSize(
  gpu: GpuContext,
  onResize: (width: number, height: number) => void,
): () => void {
  const { canvas, device } = gpu;
  const maxDim = device.limits.maxTextureDimension2D;

  const apply = (width: number, height: number) => {
    const w = Math.max(1, Math.min(maxDim, Math.round(width)));
    const h = Math.max(1, Math.min(maxDim, Math.round(height)));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      onResize(w, h);
    }
  };

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.devicePixelContentBoxSize?.[0];
      if (box) {
        apply(box.inlineSize, box.blockSize);
      } else {
        const dpr = window.devicePixelRatio || 1;
        apply(entry.contentRect.width * dpr, entry.contentRect.height * dpr);
      }
    }
  });

  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas); // Safari: no device-pixel-content-box
  }

  // Size once immediately so the first frame isn't 300 × 150.
  const rect = canvas.getBoundingClientRect();
  apply(rect.width * (window.devicePixelRatio || 1), rect.height * (window.devicePixelRatio || 1));

  return () => observer.disconnect();
}

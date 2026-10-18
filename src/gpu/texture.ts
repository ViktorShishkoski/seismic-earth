import { MipmapGenerator, mipLevelCount } from './mipmaps.ts';

export interface TextureOptions {
  /** Colour images (photos) are sRGB; data images (masks, heights) are not. */
  srgb: boolean;
  label?: string;
}

/** Downloads an image and decodes it off the main thread. */
export async function loadImageBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  // colorSpaceConversion 'none' keeps data textures (masks) bit-exact.
  return createImageBitmap(blob, { colorSpaceConversion: 'none' });
}

/** Uploads an image to a mipmapped GPU texture. */
export function textureFromBitmap(
  device: GPUDevice,
  mips: MipmapGenerator,
  bitmap: ImageBitmap,
  options: TextureOptions,
): GPUTexture {
  const format: GPUTextureFormat = options.srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
  const texture = device.createTexture({
    label: options.label,
    size: [bitmap.width, bitmap.height],
    format,
    mipLevelCount: mipLevelCount(bitmap.width, bitmap.height),
    usage:
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);
  mips.generate(texture);
  return texture;
}

/** A 1×1 texture of one colour, used when an image fails to load. */
export function solidTexture(
  device: GPUDevice,
  rgba: [number, number, number, number],
  options: TextureOptions,
): GPUTexture {
  const texture = device.createTexture({
    label: options.label,
    size: [1, 1],
    format: options.srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
  return texture;
}

/**
 * Loads a texture, falling back to a solid colour (and reporting the error)
 * so one missing file never leaves the user with a black screen.
 */
export async function loadTexture(
  device: GPUDevice,
  mips: MipmapGenerator,
  url: string,
  options: TextureOptions & { fallback: [number, number, number, number] },
): Promise<{ texture: GPUTexture; error?: Error }> {
  try {
    const bitmap = await loadImageBitmap(url);
    const texture = textureFromBitmap(device, mips, bitmap, options);
    bitmap.close();
    return { texture };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(`[texture] ${error.message} — using a fallback colour`);
    return { texture: solidTexture(device, options.fallback, options), error };
  }
}

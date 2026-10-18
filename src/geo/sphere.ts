import { latLonToCartesian, latLonToUv } from './coords.ts';

/**
 * A UV sphere ("latitude/longitude grid") built from the same coordinate
 * functions the rest of the app uses, so texture pixels land exactly where
 * their latitude and longitude say they should.
 *
 * Vertex layout (interleaved, 5 floats = 20 bytes):
 *   position.xyz  — on the unit sphere (doubles as the surface normal)
 *   uv.xy         — equirectangular texture coordinates
 *
 * The seam at ±180° has duplicated vertices (u = 0 and u = 1) so the texture
 * wraps without a smeared column. Triangles wind counter-clockwise when seen
 * from outside, which lets the renderer cull back faces.
 */
export interface SphereMesh {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  vertexCount: number;
  indexCount: number;
}

export const SPHERE_FLOATS_PER_VERTEX = 5;
export const SPHERE_VERTEX_STRIDE = SPHERE_FLOATS_PER_VERTEX * 4;

export function createSphere(latSegments = 128, lonSegments = 256): SphereMesh {
  if (latSegments < 2 || lonSegments < 3) {
    throw new Error('A sphere needs at least 2 latitude and 3 longitude segments');
  }

  const cols = lonSegments + 1;
  const rows = latSegments + 1;
  const vertices = new Float32Array(rows * cols * SPHERE_FLOATS_PER_VERTEX);

  let o = 0;
  for (let i = 0; i < rows; i++) {
    const lat = 90 - (180 * i) / latSegments;
    for (let j = 0; j < cols; j++) {
      const lon = -180 + (360 * j) / lonSegments;
      const [x, y, z] = latLonToCartesian(lat, lon);
      const [u, v] = latLonToUv(lat, lon);
      vertices[o++] = x;
      vertices[o++] = y;
      vertices[o++] = z;
      vertices[o++] = u;
      vertices[o++] = v;
    }
  }

  // Each grid cell = two triangles. a is the cell's north-west corner,
  // b south-west, c south-east, d north-east.
  const indices = new Uint32Array(latSegments * lonSegments * 6);
  let k = 0;
  for (let i = 0; i < latSegments; i++) {
    for (let j = 0; j < lonSegments; j++) {
      const a = i * cols + j;
      const b = a + cols;
      const c = b + 1;
      const d = a + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = d;
      indices[k++] = b;
      indices[k++] = c;
    }
  }

  return { vertices, indices, vertexCount: rows * cols, indexCount: indices.length };
}

import type { PartMesh } from '../../cam3d/kernel/types';

export const PENCIL_FILLET_RADIUS = 1;
export const PENCIL_CORNER_X = 10;
export const PENCIL_FIXTURE_SIZE = { x: 20, y: 20 } as const;

/** Analytic 90 degree concave valley with a cylindrical fillet. The arc is
 * tangent to the two +/-45 degree planar faces and its axis is parallel to Y. */
export function pencilCornerHeight(x: number): number {
  const u = Math.abs(x - PENCIL_CORNER_X);
  const tangent = PENCIL_FILLET_RADIUS / Math.sqrt(2);
  if (u <= tangent) {
    return 4 + PENCIL_FILLET_RADIUS - Math.sqrt(PENCIL_FILLET_RADIUS ** 2 - u ** 2);
  }
  return 4 + u + PENCIL_FILLET_RADIUS * (1 - Math.sqrt(2));
}

export function pencilCornerFixture(nx = 401, ny = 41): PartMesh {
  const positions = new Float32Array(nx * ny * 3);
  let p = 0;
  for (let iy = 0; iy < ny; iy++) {
    const y = PENCIL_FIXTURE_SIZE.y * iy / (ny - 1);
    for (let ix = 0; ix < nx; ix++) {
      const x = PENCIL_FIXTURE_SIZE.x * ix / (nx - 1);
      positions[p++] = x; positions[p++] = y; positions[p++] = pencilCornerHeight(x);
    }
  }
  const indices = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let q = 0;
  for (let iy = 0; iy < ny - 1; iy++) for (let ix = 0; ix < nx - 1; ix++) {
    const a = iy * nx + ix, b = a + 1, c = b + nx, d = a + nx;
    indices[q++] = a; indices[q++] = b; indices[q++] = c;
    indices[q++] = a; indices[q++] = c; indices[q++] = d;
  }
  return {
    positions, indices, source: 'fixture',
    bounds: { min: [0, 0, 4], max: [PENCIL_FIXTURE_SIZE.x, PENCIL_FIXTURE_SIZE.y, pencilCornerHeight(0)] },
  };
}

export function pencilGeometricFloor(cutterRadius: number): number {
  return Math.max(0, (cutterRadius - PENCIL_FILLET_RADIUS) * (Math.sqrt(2) - 1));
}

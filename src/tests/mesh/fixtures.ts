import { exportBinaryStl } from '../../mesh/stl';
import type { MeshBuffers } from '../../mesh/types';

export function unitCube(size = 1): MeshBuffers {
  const s = size;
  return {
    positions: new Float32Array([
      0, 0, 0,
      s, 0, 0,
      s, s, 0,
      0, s, 0,
      0, 0, s,
      s, 0, s,
      s, s, s,
      0, s, s,
    ]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6,
      3, 0, 4, 3, 4, 7,
    ]),
  };
}

export function cubeWithMissingTop(): MeshBuffers {
  const cube = unitCube();
  return {
    positions: cube.positions,
    indices: new Uint32Array(Array.from(cube.indices).slice(0, 6).concat(Array.from(cube.indices).slice(12))),
  };
}

export function selfIntersectingTriangles(): MeshBuffers {
  return {
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0.25, 0.25, -1,
      0.25, 0.25, 1,
      0.75, 0.75, 0,
    ]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
  };
}

export function sphereApprox(radius = 1, segments = 32, rings = 16): MeshBuffers {
  const positions: number[] = [0, 0, radius];
  for (let ring = 1; ring < rings; ring++) {
    const phi = Math.PI * ring / rings;
    const z = radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    for (let seg = 0; seg < segments; seg++) {
      const theta = 2 * Math.PI * seg / segments;
      positions.push(r * Math.cos(theta), r * Math.sin(theta), z);
    }
  }
  const bottom = positions.length / 3;
  positions.push(0, 0, -radius);

  const indices: number[] = [];
  const ringIndex = (ring: number, seg: number) => 1 + (ring - 1) * segments + (seg % segments);
  for (let seg = 0; seg < segments; seg++) indices.push(0, ringIndex(1, seg + 1), ringIndex(1, seg));
  for (let ring = 1; ring < rings - 1; ring++) {
    for (let seg = 0; seg < segments; seg++) {
      const a = ringIndex(ring, seg);
      const b = ringIndex(ring, seg + 1);
      const c = ringIndex(ring + 1, seg);
      const d = ringIndex(ring + 1, seg + 1);
      indices.push(a, b, c, b, d, c);
    }
  }
  for (let seg = 0; seg < segments; seg++) indices.push(ringIndex(rings - 1, seg), ringIndex(rings - 1, seg + 1), bottom);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Closed faceted cylinder (2 planar caps + a smooth curved wall). MSH-3: the
 *  wall must be REFUSED by the prismatic converter as curved, the caps are
 *  planar. Watertight (every edge shared by exactly two triangles). */
export function cylinderApprox(radius = 5, height = 10, segments = 32): MeshBuffers {
  const positions: number[] = [0, 0, 0, 0, 0, height]; // bottomCenter=0, topCenter=1
  const bottomCenter = 0;
  const topCenter = 1;
  const bi = (s: number) => 2 + (s % segments);
  const ti = (s: number) => 2 + segments + (s % segments);
  for (let s = 0; s < segments; s++) { const a = (2 * Math.PI * s) / segments; positions.push(radius * Math.cos(a), radius * Math.sin(a), 0); }
  for (let s = 0; s < segments; s++) { const a = (2 * Math.PI * s) / segments; positions.push(radius * Math.cos(a), radius * Math.sin(a), height); }
  const indices: number[] = [];
  for (let s = 0; s < segments; s++) indices.push(bottomCenter, bi(s + 1), bi(s));       // bottom cap
  for (let s = 0; s < segments; s++) indices.push(topCenter, ti(s), ti(s + 1));           // top cap
  for (let s = 0; s < segments; s++) {                                                    // wall quads
    indices.push(bi(s), bi(s + 1), ti(s));
    indices.push(bi(s + 1), ti(s + 1), ti(s));
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** unitCube with an extra degenerate (repeated-vertex) triangle appended.
 *  MSH-3 criterion 4: must produce a typed 'degenerate-input' failure. */
export function cubeWithDegenerateTriangle(): MeshBuffers {
  const cube = unitCube();
  return {
    positions: cube.positions,
    indices: new Uint32Array([...Array.from(cube.indices), 0, 1, 1]),
  };
}

/** Deterministic seeded reorder of triangles AND cyclic rotation of each
 *  triangle's vertex order (winding preserved). MSH-3 criterion 5 FAILS-IF
 *  probe: a shuffle must not change the converter's output region set. */
export function shuffleTriangles(mesh: MeshBuffers, seed: number): MeshBuffers {
  const triCount = mesh.indices.length / 3;
  const order = [...Array(triCount).keys()];
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = triCount - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const indices = new Uint32Array(mesh.indices.length);
  order.forEach((t, newI) => {
    const rot = Math.floor(rnd() * 3);
    const v = [mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]];
    indices[newI * 3] = v[rot];
    indices[newI * 3 + 1] = v[(rot + 1) % 3];
    indices[newI * 3 + 2] = v[(rot + 2) % 3];
  });
  return { positions: mesh.positions, indices };
}

export function binaryStlFixture(mesh: MeshBuffers = unitCube()): ArrayBuffer {
  return exportBinaryStl(mesh).bytes;
}

export function asciiCubeFixture(): ArrayBuffer {
  const mesh = unitCube();
  const lines = ['solid cube'];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    lines.push('facet normal 0 0 0', 'outer loop');
    for (let j = 0; j < 3; j++) {
      const vi = mesh.indices[i + j] * 3;
      lines.push('vertex ' + String(mesh.positions[vi]) + ' ' + String(mesh.positions[vi + 1]) + ' ' + String(mesh.positions[vi + 2]));
    }
    lines.push('endloop', 'endfacet');
  }
  lines.push('endsolid cube');
  const bytes = new TextEncoder().encode(lines.join('\n'));
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

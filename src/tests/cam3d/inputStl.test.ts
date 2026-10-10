// cam3d input pipeline: STL importer tests.
//
// Real fixture ("obj_1_Platte C.stl", binary, resolved via the Sample Parts
// path helper) plus hand-built binary/ascii payloads for format detection,
// degenerate dropping, open-mesh warning and loud NaN rejection.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectStlFormat, importStlToPartMesh, parseStl } from '../../cam3d/input';
import { resolveSamplePartPath } from '../../cam3d/input/fixturePaths';

function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

function asciiBytes(text: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(text));
}

/** Build a standard binary STL from raw triangles (9 floats each). */
function binaryStl(triangles: number[][]): ArrayBuffer {
  const ab = new ArrayBuffer(84 + 50 * triangles.length);
  const view = new DataView(ab);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((tri, t) => {
    if (tri.length !== 9) throw new Error('test bug: triangle needs 9 floats');
    const base = 84 + t * 50 + 12; // skip the (zeroed) normal
    tri.forEach((v, i) => view.setFloat32(base + i * 4, v, true));
  });
  return ab;
}

/** Watertight tetrahedron as ascii STL (facet normals zeroed; parser ignores them). */
const ASCII_TETRA = `solid tetra
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 0 10 0
      vertex 10 0 0
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 0 10
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 0 0 10
      vertex 0 10 0
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 10 0 0
      vertex 0 10 0
      vertex 0 0 10
    endloop
  endfacet
endsolid tetra
`;

describe('STL format detection', () => {
  it('detects the real fixture as binary', () => {
    const bytes = toArrayBuffer(readFileSync(resolveSamplePartPath('obj_1_Platte C.stl')));
    expect(detectStlFormat(bytes)).toBe('binary');
  });

  it('detects ascii by the leading "solid" keyword', () => {
    expect(detectStlFormat(asciiBytes(ASCII_TETRA))).toBe('ascii');
  });

  it('prefers the binary size contract over a "solid" header prefix', () => {
    // A binary file whose 80-byte comment header happens to start with
    // "solid" -- the size equation must win.
    const ab = binaryStl([[0, 0, 0, 10, 0, 0, 0, 10, 0]]);
    new Uint8Array(ab).set(new TextEncoder().encode('solid header comment'), 0);
    expect(detectStlFormat(ab)).toBe('binary');
  });

  it('fails loud on bytes that are neither binary nor ascii STL', () => {
    expect(() => detectStlFormat(asciiBytes('P6 not an stl at all'))).toThrow(/unrecognized file/);
  });
});

describe('STL import: real fixture', () => {
  it('imports "obj_1_Platte C.stl" into a valid PartMesh', async () => {
    const bytes = toArrayBuffer(readFileSync(resolveSamplePartPath('obj_1_Platte C.stl')));
    const declaredTriangles = new DataView(bytes).getUint32(80, true);
    const r = await importStlToPartMesh(bytes);

    expect(r.mesh.source).toBe('stl');
    expect(r.effectiveDeflectionMm).toBeUndefined(); // STL has no tessellation step
    expect(r.triangleCount).toBeGreaterThan(0);
    expect(r.triangleCount).toBeLessThanOrEqual(declaredTriangles);
    expect(r.mesh.indices.length).toBe(r.triangleCount * 3);

    // No NaN/Inf; bounds match the actual vertex extents.
    const p = r.mesh.positions;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) {
      expect(Number.isFinite(p[i])).toBe(true);
      const axis = i % 3;
      if (p[i] < min[axis]) min[axis] = p[i];
      if (p[i] > max[axis]) max[axis] = p[i];
    }
    expect(r.mesh.bounds.min).toEqual(min);
    expect(r.mesh.bounds.max).toEqual(max);

    // Indices in range; welding produced real sharing (far fewer than 3 verts/tri).
    const vertexCount = p.length / 3;
    for (let i = 0; i < r.mesh.indices.length; i++) {
      expect(r.mesh.indices[i]).toBeLessThan(vertexCount);
    }
    expect(vertexCount).toBeLessThan(declaredTriangles * 3);
  });
});

describe('STL import: hand-built payloads', () => {
  it('imports the ascii tetra watertight, with zero warnings', async () => {
    const r = await importStlToPartMesh(asciiBytes(ASCII_TETRA));
    expect(r.mesh.source).toBe('stl');
    expect(r.triangleCount).toBe(4);
    expect(r.warnings).toEqual([]);
    expect(r.mesh.positions.length).toBe(4 * 3); // welded to 4 unique vertices
  });

  it('drops a degenerate triangle from a binary STL and warns with a count', async () => {
    const tetra: number[][] = [
      [0, 0, 0, 0, 10, 0, 10, 0, 0],
      [0, 0, 0, 10, 0, 0, 0, 0, 10],
      [0, 0, 0, 0, 0, 10, 0, 10, 0],
      [10, 0, 0, 0, 10, 0, 0, 0, 10],
    ];
    const degenerate = [0, 0, 0, 5, 0, 0, 10, 0, 0]; // exactly collinear
    const r = await importStlToPartMesh(binaryStl([...tetra, degenerate]));
    expect(r.triangleCount).toBe(4);
    expect(r.warnings.some((w) => /Dropped 1 exactly-degenerate triangle/.test(w))).toBe(true);
  });

  it('warns on an open mesh (single binary triangle)', async () => {
    const r = await importStlToPartMesh(binaryStl([[0, 0, 0, 10, 0, 0, 0, 10, 0]]));
    expect(r.triangleCount).toBe(1);
    expect(r.warnings.some((w) => /not watertight/.test(w))).toBe(true);
  });

  it('rejects a binary STL containing a NaN vertex loudly', async () => {
    const ab = binaryStl([[0, 0, 0, 10, 0, 0, 0, 10, 0]]);
    new DataView(ab).setFloat32(84 + 12, NaN, true); // first vertex x
    await expect(importStlToPartMesh(ab)).rejects.toThrow(/non-finite/);
  });

  it('fails loud on malformed ascii with a line number', () => {
    const bad = 'solid s\n  facet normal 0 0 0\n    outer loop\n      vertex 0 0\n';
    expect(() => parseStl(asciiBytes(bad))).toThrow(/line 4/);
  });

  it('fails loud on an ascii solid with zero facets', () => {
    expect(() => parseStl(asciiBytes('solid empty\nendsolid empty\n'))).toThrow(/no facets/);
  });
});

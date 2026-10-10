import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MESH_FEATURE_ANGLE_DEG,
  extractMeshEdgeChains,
  type MeshEdgeChain,
} from '../../mesh/edgeChains';
import { convertPrismaticMesh } from '../../mesh/prismatic';
import { importStl } from '../../mesh/stl';
import type { MeshBuffers } from '../../mesh/types';
import { cylinderApprox, shuffleTriangles } from './fixtures';

const PLATTE_FIXTURE = 'src/tests/mesh/fixtures/obj_1_Platte C.stl';
const PROVENANCE = JSON.parse(
  readFileSync('src/tests/evidence/WO-244/fixture-provenance.json', 'utf8'),
) as { stlBytes: number; stlSha256: string };

function loadSampleMachinePlate(): MeshBuffers {
  return importStl(readFileSync(PLATTE_FIXTURE)).mesh;
}

function isFlatAtZ(chain: MeshEdgeChain, z: number): boolean {
  return chain.closed && chain.points.every((point) => point[2] === z);
}

function xyArea(chain: MeshEdgeChain): number {
  return Math.abs(chain.points.reduce((sum, point, index) => {
    const next = chain.points[(index + 1) % chain.points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
}

function reverseVertexOrder(mesh: MeshBuffers): MeshBuffers {
  const vertexCount = mesh.positions.length / 3;
  const positions = new Float32Array(mesh.positions.length);
  const remap = new Uint32Array(vertexCount);
  for (let oldIndex = 0; oldIndex < vertexCount; oldIndex++) {
    const newIndex = vertexCount - 1 - oldIndex;
    remap[oldIndex] = newIndex;
    positions[newIndex * 3] = mesh.positions[oldIndex * 3];
    positions[newIndex * 3 + 1] = mesh.positions[oldIndex * 3 + 1];
    positions[newIndex * 3 + 2] = mesh.positions[oldIndex * 3 + 2];
  }
  return {
    positions,
    indices: new Uint32Array(Array.from(mesh.indices, (index) => remap[index])),
  };
}

function joinedTriangles(angleDeg: number): MeshBuffers {
  const angle = (angleDeg * Math.PI) / 180;
  return {
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, Math.cos(angle), Math.sin(angle),
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 1, 3]),
  };
}

function nonManifoldFan(): MeshBuffers {
  return {
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0.5, 1, 0,
      0.5, -1, 0,
      0.5, 2, 0,
    ]),
    // Three coplanar triangles share edge 0-1. Their six genuine boundary
    // edges form three deterministic A-via-tip-B open chains.
    indices: new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4]),
  };
}

function reconnectingSharpPrism(): MeshBuffers {
  const sideCount = 36;
  const sharpTurnDeg = 50;
  const smoothTurnDeg = (360 - sharpTurnDeg) / (sideCount - 1);
  const normalAngles: number[] = [0];
  for (let side = 1; side < sideCount; side++) {
    normalAngles.push(sharpTurnDeg + (side - 1) * smoothTurnDeg);
  }
  const normals = normalAngles.map((angleDeg) => {
    const angle = (angleDeg * Math.PI) / 180;
    return [Math.cos(angle), Math.sin(angle)] as const;
  });
  const intersection = (left: readonly [number, number], right: readonly [number, number]) => {
    const determinant = left[0] * right[1] - left[1] * right[0];
    return [
      (right[1] - left[1]) / determinant,
      (left[0] - right[0]) / determinant,
    ] as const;
  };
  const profile = normals.map((normal, side) => intersection(
    normals[(side + sideCount - 1) % sideCount],
    normal,
  ));
  const positions: number[] = [0, 0, 0, 0, 0, 2];
  for (const [x, y] of profile) positions.push(x, y, 0);
  for (const [x, y] of profile) positions.push(x, y, 2);
  const bottom = (side: number) => 2 + (side % sideCount);
  const top = (side: number) => 2 + sideCount + (side % sideCount);
  const indices: number[] = [];
  for (let side = 0; side < sideCount; side++) indices.push(0, bottom(side + 1), bottom(side));
  for (let side = 0; side < sideCount; side++) indices.push(1, top(side), top(side + 1));
  for (let side = 0; side < sideCount; side++) {
    indices.push(bottom(side), bottom(side + 1), top(side));
    indices.push(bottom(side + 1), top(side + 1), top(side));
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

describe('WO-244: imported STL feature edges become stable pickable chains', () => {
  it("uses Operator's exact embedded STL and yields one top outer profile plus five top hole loops", () => {
    const bytes = readFileSync(PLATTE_FIXTURE);
    expect(bytes.byteLength).toBe(PROVENANCE.stlBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PROVENANCE.stlSha256);

    const mesh = importStl(bytes).mesh;
    const conversion = convertPrismaticMesh(mesh);
    expect(conversion.ok).toBe(false);
    expect(conversion.ok ? 'ok' : conversion.kind).toBe('refused-curved');
    if (conversion.ok || conversion.kind !== 'refused-curved') throw new Error('expected refused-curved');
    expect(conversion.curvedRegions).toHaveLength(19);

    const chains = extractMeshEdgeChains(mesh);
    const top = chains.filter((chain) => isFlatAtZ(chain, 4));
    expect(top).toHaveLength(6);
    expect(top.map((chain) => chain.points.length).sort((a, b) => a - b)).toEqual([6, 35, 35, 35, 35, 35]);
    const areas = top.map(xyArea).sort((a, b) => a - b);
    expect(areas.slice(0, 5).every((area) => Math.abs(area - 33.0052) < 0.001)).toBe(true);
    expect(areas[5]).toBeGreaterThan(2_600);
    expect(new Set(top.map((chain) => chain.id)).size).toBe(6);
  });

  it('is a pure function of geometry across triangle, corner, and source-vertex reordering', () => {
    const mesh = loadSampleMachinePlate();
    const expected = extractMeshEdgeChains(mesh);
    expect(expected).toHaveLength(38);
    expect(expected.every((chain) => chain.closed)).toBe(true);

    for (const seed of [1, 244, 0xdecafbad]) {
      const shuffled = reverseVertexOrder(shuffleTriangles(mesh, seed));
      expect(extractMeshEdgeChains(shuffled)).toEqual(expected);
    }
  });

  it('keeps a 32-facet cylinder wall smooth instead of emitting one chain per facet', () => {
    const chains = extractMeshEdgeChains(cylinderApprox(5, 10, 32));
    expect(chains).toHaveLength(2);
    expect(chains.every((chain) => chain.closed)).toBe(true);
    expect(chains.map((chain) => chain.points.length)).toEqual([32, 32]);
  });

  it('keeps a sharp edge even when smooth faces reconnect around the same patch', () => {
    const mesh = reconnectingSharpPrism();
    const chains = extractMeshEdgeChains(mesh);
    expect(chains).toHaveLength(3);
    expect(chains.filter((chain) => chain.closed).map((chain) => chain.points.length)).toEqual([36, 36]);
    const sharp = chains.find((chain) => !chain.closed);
    expect(sharp).toMatchObject({ closed: false, points: { length: 2 } });
    expect(sharp?.points[0].slice(0, 2)).toEqual(sharp?.points[1].slice(0, 2));
    expect(sharp?.points.map((point) => point[2])).toEqual([0, 2]);
    expect(extractMeshEdgeChains(reverseVertexOrder(shuffleTriangles(mesh, 244)))).toEqual(chains);
  });

  it('uses the prismatic 30 deg cutoff: 20 deg stays one patch, 40 deg splits', () => {
    expect(DEFAULT_MESH_FEATURE_ANGLE_DEG).toBe(30);
    const smooth = extractMeshEdgeChains(joinedTriangles(20));
    const sharp = extractMeshEdgeChains(joinedTriangles(40));
    expect(smooth).toHaveLength(1);
    expect(smooth[0]).toMatchObject({ closed: true, points: { length: 4 } });
    expect(sharp).toHaveLength(2);
    expect(sharp.every((chain) => chain.closed && chain.points.length === 3)).toBe(true);
  });

  it('chains an open boundary and degrades a non-manifold fan without throwing', () => {
    const openQuad: MeshBuffers = {
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    expect(extractMeshEdgeChains(openQuad)).toMatchObject([
      { closed: true, points: { length: 4 } },
    ]);

    const nonManifold = extractMeshEdgeChains(nonManifoldFan());
    expect(nonManifold).toHaveLength(3);
    expect(nonManifold.every((chain) => !chain.closed && chain.points.length === 3)).toBe(true);
  });
});

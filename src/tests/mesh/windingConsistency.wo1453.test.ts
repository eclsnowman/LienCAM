// WO-1453: mesh winding inconsistency was invisible to every health/repair/promotion path.
//
// reportFromTopology() computed `watertight` from per-edge OCCURRENCE counts only, never from
// the DIRECTION each adjacent triangle traverses a shared edge. A closed box with one reversed
// triangle is fully edge-paired, so it read as healthy: repairMesh() left the conflict in place
// and "Edit as model" minted an item the later solid build rejected.
//
// The rule these tests pin: after orienting, every shell faces the way its nesting says (even
// enclosure depth -> outward, odd -> inward cavity), and a shell that already obeys it is left
// untouched. Edit as model re-orients what it can and refuses only a one-sided surface.
//
// Everything runs through the production entry points -- analyzeMesh() / repairMesh() /
// convertPrismaticMesh() and the real wrapImportedGeometryAsModelItem store action.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { typedMock } from '../support/typedMock';

const cache = new Map<string, ArrayBuffer>();
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id: string, buf: ArrayBuffer) => { cache.set(id, buf); },
  loadCachedSTL: async (id: string) => cache.get(id) ?? null,
  removeCachedSTL: async (id: string) => { cache.delete(id); },
}));

import { analyzeMesh, measureMesh, repairMesh } from '../../mesh/analysis';
import { convertPrismaticMesh } from '../../mesh/prismatic';
import { importStl } from '../../mesh/stl';
import { binaryStlFixture, cubeWithMissingTop, unitCube } from './fixtures';
import type { MeshBuffers } from '../../mesh/types';
import { useCamStore } from '../../store';
import { resetDocumentHolder } from '../../doc/documentHolder';
import type { ImportedGeometry, SceneStock } from '../../types';

function reverseTriangles(mesh: MeshBuffers, reverse: (tri: number) => boolean): MeshBuffers {
  const indices = Array.from(mesh.indices);
  for (let t = 0; t < indices.length / 3; t++) {
    if (!reverse(t)) continue;
    const i = t * 3;
    [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  }
  return { positions: mesh.positions, indices: new Uint32Array(indices) };
}

function translate(mesh: MeshBuffers, d: [number, number, number]): MeshBuffers {
  const positions = new Float32Array(mesh.positions);
  for (let i = 0; i < positions.length; i++) positions[i] += d[i % 3];
  return { positions, indices: mesh.indices };
}

function merge(...meshes: MeshBuffers[]): MeshBuffers {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const m of meshes) {
    const base = positions.length / 3;
    positions.push(...m.positions);
    indices.push(...Array.from(m.indices, (v) => v + base));
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** 10 mm box with triangle `tri` reversed: zero boundary / non-manifold edges. */
const boxWithReversed = (tri = 0): MeshBuffers => reverseTriangles(unitCube(10), (t) => t === tri);
const insideOut = (mesh: MeshBuffers): MeshBuffers => reverseTriangles(mesh, () => true);

/** The audit's probe: a 10 mm outward cube plus a correct 4 mm cavity (every triangle reversed). */
const hollowBox = (): MeshBuffers => merge(unitCube(10), insideOut(translate(unitCube(4), [3, 3, 3])));

/** Minimal 6-vertex triangulation of the projective plane: closed, every edge shared by
 *  exactly two triangles, and one-sided -- no winding makes it consistent. */
function projectivePlane(): MeshBuffers {
  return {
    positions: new Float32Array([0, 0, 0, 10, 0, 1, 3, 9, 2, -6, 5, 7, -4, -8, 3, 5, -4, -9]),
    indices: new Uint32Array([
      0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 1,
      1, 2, 4, 2, 3, 5, 3, 4, 1, 4, 5, 2, 5, 1, 3,
    ]),
  };
}

/** Independent oracle: a consistently wound closed surface uses each DIRECTED edge once. */
function everyDirectedEdgeOnce(mesh: MeshBuffers): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = `${u}>${v}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
}

describe('WO-1453: analyzeMesh() reports winding conflicts', () => {
  it('a clean cube has zero winding conflicts', () => {
    expect(analyzeMesh(unitCube()).windingConflictEdgeCount).toBe(0);
  });

  it('a closed box with one reversed triangle reports the conflict though boundary/non-manifold counts are zero', () => {
    const report = analyzeMesh(boxWithReversed());
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.windingConflictEdgeCount).toBe(3);
    expect(report.warnings.some((w) => /winding/i.test(w))).toBe(true);
  });
});

describe('WO-1453: repairMesh() orients every shell the way its nesting says', () => {
  for (const [label, mesh] of [
    ['reversed triangle is the propagation seed (triangle 0)', boxWithReversed(0)],
    ['reversed triangle is not the seed (triangle 7)', boxWithReversed(7)],
    ['box far from the origin', translate(boxWithReversed(0), [1000, -2000, 500])],
  ] as const) {
    it(`one reversed triangle, ${label}: flipped back, consistent, outward`, () => {
      const result = repairMesh(mesh);
      expect(result.flippedTriangleCount).toBe(1);
      expect(result.report.windingConflictEdgeCount).toBe(0);
      expect(result.measures.signedVolume).toBeCloseTo(1000, 1);

      // Re-check the repaired buffers themselves, not only the bundled report.
      expect(analyzeMesh(result.mesh).windingConflictEdgeCount).toBe(0);
      expect(everyDirectedEdgeOnce(result.mesh)).toBe(true);
      expect(measureMesh(result.mesh).signedVolume).toBeGreaterThan(0);
      expect(repairMesh(result.mesh).flippedTriangleCount).toBe(0);
    });
  }

  it('hollow box with a correct cavity: flips nothing, signed volume stays 936', () => {
    const mesh = hollowBox();
    expect(measureMesh(mesh).signedVolume).toBeCloseTo(936, 3);
    expect(analyzeMesh(mesh).windingConflictEdgeCount).toBe(0);

    const result = repairMesh(mesh);
    expect(result.flippedTriangleCount).toBe(0);
    expect(result.measures.signedVolume).toBeCloseTo(936, 3);
  });

  it('hollow box whose cavity faces outward: only the cavity is turned inward', () => {
    const result = repairMesh(merge(unitCube(10), translate(unitCube(4), [3, 3, 3])));
    expect(result.flippedTriangleCount).toBe(12);
    expect(result.measures.signedVolume).toBeCloseTo(936, 3);
  });

  it('a solid island inside a cavity (depth 2) faces outward again', () => {
    const nested = merge(unitCube(10), insideOut(translate(unitCube(6), [2, 2, 2])), translate(unitCube(2), [4, 4, 4]));
    expect(repairMesh(nested).flippedTriangleCount).toBe(0);

    const islandInsideOut = merge(unitCube(10), insideOut(translate(unitCube(6), [2, 2, 2])), insideOut(translate(unitCube(2), [4, 4, 4])));
    const result = repairMesh(islandInsideOut);
    expect(result.flippedTriangleCount).toBe(12);
    expect(result.measures.signedVolume).toBeCloseTo(1000 - 216 + 8, 3);
  });

  it('a single fully inside-out closed shell is flipped outward', () => {
    const result = repairMesh(insideOut(unitCube(10)));
    expect(result.flippedTriangleCount).toBe(12);
    expect(result.measures.signedVolume).toBeCloseTo(1000, 3);
    expect(everyDirectedEdgeOnce(result.mesh)).toBe(true);
  });

  it('two separate outward cubes: flipped 0', () => {
    const result = repairMesh(merge(unitCube(10), translate(unitCube(10), [20, 0, 0])));
    expect(result.flippedTriangleCount).toBe(0);
    expect(result.measures.signedVolume).toBeCloseTo(2000, 3);
  });

  it('a hole is still filled and the fill winds with its neighbours', () => {
    const result = repairMesh(cubeWithMissingTop());
    expect(result.filledHoleCount).toBe(1);
    expect(result.report.watertight).toBe(true);
    expect(result.report.windingConflictEdgeCount).toBe(0);
    expect(result.measures.signedVolume).toBeGreaterThan(0);
  });
});

describe('WO-1453: convertPrismaticMesh() orients instead of refusing', () => {
  it('a box with one reversed triangle converts and says what it did', () => {
    const conv = convertPrismaticMesh(boxWithReversed());
    expect(conv.ok).toBe(true);
    if (!conv.ok) return;
    expect(conv.notes).toEqual(['Edit as model: re-oriented 1 triangle so the mesh winds consistently']);
    expect(conv.faceSet.faces).toHaveLength(6);
    // Same face set as the clean cube: the corrected mesh is what gets built.
    const clean = convertPrismaticMesh(unitCube(10));
    expect(clean.ok && clean.notes).toEqual([]);
    if (clean.ok) expect(conv.faceSet).toEqual(clean.faceSet);
  });

  it('the hollow box makes no re-orientation note', () => {
    const conv = convertPrismaticMesh(hollowBox());
    expect(conv.ok).toBe(true);
    if (conv.ok) expect(conv.notes).toEqual([]);
  });

  it('a one-sided surface is refused as non-orientable, distinct from the hole message', () => {
    const conv = convertPrismaticMesh(projectivePlane());
    expect(conv.ok).toBe(false);
    if (conv.ok) return;
    expect(conv.kind).toBe('non-orientable');
    expect(conv.message).toMatch(/cannot be oriented/);

    const holed = convertPrismaticMesh(cubeWithMissingTop());
    expect(holed.ok).toBe(false);
    if (holed.ok) return;
    expect(holed.kind).toBe('non-watertight');
  });
});

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
};

function stlRow(): ImportedGeometry {
  return {
    id: 'geo-stl', name: 'Plate', filename: 'plate.stl', type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 }, size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    color: '#abcdef', folderId: undefined,
  };
}

const state = () => useCamStore.getState();
const items = () => state().project.modelItems ?? [];

describe('WO-1453: through the real "Edit as model" store action', () => {
  beforeEach(() => {
    resetDocumentHolder();
    cache.clear();
    useCamStore.setState((s) => ({
      project: {
        ...s.project, setups: [], sceneStock: autoStock,
        geometry: [stlRow()], modelItems: [], modelItemPlacements: [], modelItemDocuments: undefined,
      },
      workspace: 'cam', activeModal: null, activeModelItemId: null, brepImportError: null,
      projectHistory: [], sketchHistory: [], canUndo: false,
    }));
  });

  it('accepts a box with one reversed triangle: an item is minted and the conversion carries the note', async () => {
    const bytes = binaryStlFixture(boxWithReversed());
    cache.set('geo-stl', bytes);

    const result = await state().wrapImportedGeometryAsModelItem('geo-stl');

    expect(result.ok).toBe(true);
    expect(items().map((m) => m.id)).toEqual([result.itemId]);
    expect(state().project.geometry[0].pendingModelItemId).toBe(result.itemId);
    expect(state().brepImportError).toBeNull();

    // The store runs this same conversion on the cached bytes.
    const conv = convertPrismaticMesh(importStl(bytes).mesh);
    expect(conv.ok && conv.notes).toEqual(['Edit as model: re-oriented 1 triangle so the mesh winds consistently']);
  });

  it('refuses a one-sided surface before any item is minted', async () => {
    cache.set('geo-stl', binaryStlFixture(projectivePlane()));
    const before = JSON.stringify(state().project.geometry);

    const result = await state().wrapImportedGeometryAsModelItem('geo-stl');

    expect(result).toEqual({ ok: false, reason: 'mesh-non-orientable' });
    expect(items()).toHaveLength(0);
    expect(state().workspace).toBe('cam');
    expect(state().brepImportError).toMatch(/cannot be oriented/);
    expect(JSON.stringify(state().project.geometry)).toBe(before);
  });
});

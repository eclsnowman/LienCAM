// WO-1846: LienCAM finds the holes in an STL.
//
// Rule 6: every assertion here runs on REAL STL BYTES through
// `importStl` (or `resolveEditedStlMesh`, the WO-1845 resolver every route
// goes through) - never on a hand-built MeshBuffers handed straight to the
// engine. The fixtures below write a binary STL exactly the way a slicer
// would, and the test parses it back.
//
// Ported contract tests, named as the WO asks. These are Next's
// tests/contracts/mesh-*recognition*, hole, counterbore and chamfered-hole
// cases restated on our types:
//   - MESH-HOLE-R1   a closed cylindrical wall between two flat open ends,
//                    with a clear bore, is a through hole  -> 'the four
//                    features', 'a coarse 16-sided hole'
//   - MESH-HOLE-R2   a wall with a floor at one end is a blind hole
//                    -> 'a blind hole is a blind hole'
//   - MESH-HOLE-R3   an obstructed bore is NOT a hole -> 'a bar across the
//                    bore'
//   - MESH-CB-R1     two coaxial bores joined by one flat shoulder are one
//                    counterbore -> 'the four features'
//   - MESH-CHAM-R1   a bore whose end opens through a coaxial cone is a
//                    countersink -> 'the four features', 'the countersink is
//                    90 degrees'
//   - MESH-CYL-R1    every facet must fit, whole-facet; freeform surface
//                    yields nothing -> 'a freeform patch proves nothing'
// Next's exact-predicate contracts (MESH-EXACT-*) are deliberately NOT
// ported: this port replaces the bigint layer with float64 plus a stated
// tolerance (see src/mesh/recognition/types.ts for the decide-and-log).

import { describe, expect, it, vi } from 'vitest';
import { typedMock } from '../support/typedMock';
import type { ImportedGeometry, Project, Setup } from '../../types';
import { exportBinaryStl, importStl } from '../../mesh/stl';
import { resolveEditedStlMesh, sourceFacetIdsOf } from '../../mesh/edit';

// The project save path reads STL bytes through this cache and writes them
// back on load; an in-memory stand-in is all it needs to round trip here.
const stlBytesById = new Map<string, ArrayBuffer>();
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytesById.set(id, buffer); }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytesById.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytesById.delete(id); }),
}));
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}));
const { useCamStore } = await import('../../store');
import { recognizeMeshFeatures, describeFeature } from '../../mesh/recognition';
import type { MeshBuffers, Vec3 } from '../../mesh/types';

// ---------------------------------------------------------------- fixtures

/** A triangle soup being built up, in the unwelded form an STL writer wants. */
class Soup {
  private readonly coords: number[] = [];

  tri(a: Vec3, b: Vec3, c: Vec3): void {
    this.coords.push(...a, ...b, ...c);
  }

  /** two triangles for the quad a-b-c-d, normal by the given winding */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  mesh(): MeshBuffers {
    const positions = Float32Array.from(this.coords);
    const indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    return { positions, indices };
  }

  bytes(): ArrayBuffer {
    return exportBinaryStl(this.mesh()).bytes;
  }
}

/** `n` points evenly round a circle, counter-clockwise seen from +Z. */
function ring(cx: number, cy: number, r: number, z: number, n: number): Vec3[] {
  return Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t), z] as Vec3;
  });
}

/**
 * `n` points round the square of half-size `s`, counter-clockwise from (s, 0),
 * at EXACTLY representable offsets. Dyadic on purpose: neighbouring cells of
 * the plate below share these vertices, and a weld is by exact coordinate.
 */
function squareRing(cx: number, cy: number, s: number, z: number, n: number): Vec3[] {
  const per = n / 8;
  return Array.from({ length: n }, (_, k) => {
    const segment = Math.floor(k / per);
    const f = (k % per) / per;
    const xy: Array<[number, number]> = [
      [s, s * f], [s * (1 - f), s], [-s * f, s], [-s, s * (1 - f)],
      [-s, -s * f], [-s * (1 - f), -s], [s * f, -s], [s, -s * (1 - f)],
    ];
    return [cx + xy[segment][0], cy + xy[segment][1], z] as Vec3;
  });
}

/** A planar strip between an inner loop and an outer loop, normal +Z when
 *  both run counter-clockwise; reversed when `up` is false. */
function annulus(soup: Soup, inner: Vec3[], outer: Vec3[], up: boolean): void {
  const n = inner.length;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    if (up) {
      soup.tri(inner[k], outer[k], outer[j]);
      soup.tri(inner[k], outer[j], inner[j]);
    } else {
      soup.tri(inner[k], outer[j], outer[k]);
      soup.tri(inner[k], inner[j], outer[j]);
    }
  }
}

/** A wall between a lower loop and an upper loop. `outward` puts the normals
 *  away from the axis (a boss, a part's flank); false puts them toward it (a
 *  bore). Both loops run counter-clockwise seen from +Z. */
function wall(soup: Soup, lower: Vec3[], upper: Vec3[], outward: boolean): void {
  const n = lower.length;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    if (outward) {
      soup.tri(lower[k], lower[j], upper[j]);
      soup.tri(lower[k], upper[j], upper[k]);
    } else {
      soup.tri(lower[k], upper[k], upper[j]);
      soup.tri(lower[k], upper[j], lower[j]);
    }
  }
}

/** A flat disk filling a loop: +Z when `up`. */
function disk(soup: Soup, loop: Vec3[], centre: Vec3, up: boolean): void {
  const n = loop.length;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    if (up) soup.tri(centre, loop[k], loop[j]);
    else soup.tri(centre, loop[j], loop[k]);
  }
}

const N = 64;
const HALF = 20;
const THICK = 12;
const CELLS: Array<[number, number]> = [[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]];

/**
 * The acceptance plate: 80 x 80 x 12 mm, four cells, one feature each.
 *   cell 0  a 6 mm through hole
 *   cell 1  a 10/6 mm counterbore, 4 mm deep
 *   cell 2  a 6 mm hole with a 90-degree countersink 3 mm deep (12 mm at
 *           the face)
 *   cell 3  a 12 mm boss, 5 mm tall
 * `segments` controls the tessellation, so the same plate can be written
 * coarse (16-sided) or fine.
 */
function acceptancePlate(segments = N): ArrayBuffer {
  const soup = new Soup();
  const topRingRadius = [3, 5, 6, 6];
  for (let cell = 0; cell < 4; cell++) {
    const [cx, cy] = CELLS[cell];
    const outerTop = squareRing(cx, cy, HALF, THICK, segments);
    const outerBottom = squareRing(cx, cy, HALF, 0, segments);
    // top face of this cell, around whatever the feature leaves open
    annulus(soup, ring(cx, cy, topRingRadius[cell], THICK, segments), outerTop, true);
    // bottom face
    if (cell === 3) disk(soup, outerBottom, [cx, cy, 0], false);
    else annulus(soup, ring(cx, cy, 3, 0, segments), outerBottom, false);

    if (cell === 0) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, THICK, segments), false);
    } else if (cell === 1) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, 8, segments), false);
      annulus(soup, ring(cx, cy, 3, 8, segments), ring(cx, cy, 5, 8, segments), true);
      wall(soup, ring(cx, cy, 5, 8, segments), ring(cx, cy, 5, THICK, segments), false);
    } else if (cell === 2) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, 9, segments), false);
      wall(soup, ring(cx, cy, 3, 9, segments), ring(cx, cy, 6, THICK, segments), false);
    } else {
      wall(soup, ring(cx, cy, 6, THICK, segments), ring(cx, cy, 6, THICK + 5, segments), true);
      disk(soup, ring(cx, cy, 6, THICK + 5, segments), [cx, cy, THICK + 5], true);
    }
  }
  // the plate's own flanks, round the whole 80 x 80 outline
  const outline = squareRing(0, 0, 2 * HALF, 0, segments * 2);
  const outlineTop = squareRing(0, 0, 2 * HALF, THICK, segments * 2);
  wall(soup, outline, outlineTop, true);
  return soup.bytes();
}

/** A plate with one blind hole: 8 mm across, 6 mm deep, flat bottom. */
function blindHolePlate(): ArrayBuffer {
  const soup = new Soup();
  const outerTop = squareRing(0, 0, HALF, THICK, N);
  const outerBottom = squareRing(0, 0, HALF, 0, N);
  annulus(soup, ring(0, 0, 4, THICK, N), outerTop, true);
  disk(soup, outerBottom, [0, 0, 0], false);
  wall(soup, ring(0, 0, 4, 6, N), ring(0, 0, 4, THICK, N), false);
  disk(soup, ring(0, 0, 4, 6, N), [0, 0, 6], true);
  wall(soup, outerBottom, outerTop, true);
  return soup.bytes();
}

/** A box, as an axis-aligned closed shell. Used as the bar across the bore. */
function box(soup: Soup, min: Vec3, max: Vec3): void {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const p = (x: number, y: number, z: number): Vec3 => [x, y, z];
  soup.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)); // +Z
  soup.quad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0), p(x0, y0, z0)); // -Z
  soup.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)); // -Y
  soup.quad(p(x1, y1, z0), p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1)); // +Y
  soup.quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)); // +X
  soup.quad(p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1)); // -X
}

/**
 * A plate with a 6 mm through hole AND a bar standing across the bore.
 *
 * The bar is a closed box whose every VERTEX is well outside the bore - only
 * its body crosses it. That is the whole point: a vertex-sampled corridor scan
 * cannot see it, and the whole-facet scan can.
 */
function ribbedHolePlate(): ArrayBuffer {
  const soup = new Soup();
  const outerTop = squareRing(0, 0, HALF, THICK, N);
  const outerBottom = squareRing(0, 0, HALF, 0, N);
  annulus(soup, ring(0, 0, 3, THICK, N), outerTop, true);
  annulus(soup, ring(0, 0, 3, 0, N), outerBottom, false);
  wall(soup, ring(0, 0, 3, 0, N), ring(0, 0, 3, THICK, N), false);
  wall(soup, outerBottom, outerTop, true);
  box(soup, [-18, -1, 5], [18, 1, 7]);
  return soup.bytes();
}

/** A closed sphere: curved everywhere, cylindrical nowhere. */
function spherePlate(): ArrayBuffer {
  const soup = new Soup();
  const rings = 24;
  const segments = 48;
  const at = (i: number, k: number): Vec3 => {
    const phi = (Math.PI * i) / rings;
    const theta = (2 * Math.PI * k) / segments;
    return [10 * Math.sin(phi) * Math.cos(theta), 10 * Math.sin(phi) * Math.sin(theta), 10 * Math.cos(phi)];
  };
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < segments; k++) {
      const j = (k + 1) % segments;
      if (i === 0) soup.tri(at(0, 0), at(1, k), at(1, j));
      else if (i === rings - 1) soup.tri(at(rings, 0), at(i, j), at(i, k));
      else soup.quad(at(i, k), at(i, j), at(i + 1, j), at(i + 1, k));
    }
  }
  return soup.bytes();
}

// ------------------------------------------------------------------- tests

function featuresOf(bytes: ArrayBuffer, options = {}) {
  const parsed = importStl(bytes);
  return recognizeMeshFeatures(parsed.mesh, sourceFacetIdsOf(parsed.mesh), options);
}

const NOMINAL_CHORD_DEVIATION = 3 * (1 - Math.cos(Math.PI / N));

describe('WO-1846: the four features of the acceptance plate (MESH-HOLE-R1, MESH-CB-R1, MESH-CHAM-R1)', () => {
  const result = featuresOf(acceptancePlate());
  const byKind = new Map(result.features.map((f) => [f.kind, f]));

  it('finds exactly those four, and nothing else', () => {
    expect(result.features.map((f) => f.kind).sort()).toEqual(
      ['boss', 'counterbore', 'countersink', 'through-hole'],
    );
  });

  it('the through hole is 6 mm across and goes all the way through', () => {
    const hole = byKind.get('through-hole');
    expect(hole).toBeDefined();
    expect(hole!.diameterMm).toBeCloseTo(6, 1);
    expect(Math.abs(hole!.diameterMm - 6)).toBeLessThanOrEqual(NOMINAL_CHORD_DEVIATION);
    expect(Math.abs(hole!.depthMm - THICK)).toBeLessThan(1e-6);
    expect(hole!.axis.direction.map((v) => Math.round(v))).toEqual([0, 0, 1]);
  });

  it('the counterbore is 10 over 6', () => {
    const cb = byKind.get('counterbore');
    expect(cb).toBeDefined();
    expect(cb!.bands.map((b) => Number(b.diameterMm.toFixed(2)))).toEqual([6, 10]);
    expect(cb!.diameterMm).toBeCloseTo(6, 1);
    expect(Math.abs(cb!.depthMm - THICK)).toBeLessThan(1e-6);
    // the 10 mm counterbore itself is 4 mm deep
    const big = cb!.bands[1];
    expect(Math.abs(big.axialRangeMm[1] - big.axialRangeMm[0] - 4)).toBeLessThan(1e-6);
  });

  it('the countersink is 90 degrees and opens to 12 mm at the face', () => {
    const cs = byKind.get('countersink');
    expect(cs).toBeDefined();
    const cone = cs!.bands.find((b) => b.surface === 'cone');
    expect(cone).toBeDefined();
    expect(cone!.includedAngleDeg).toBeCloseTo(90, 1);
    expect(Math.max(...cs!.diametersMm)).toBeCloseTo(12, 1);
    expect(cs!.diameterMm).toBeCloseTo(6, 1);
    expect(Math.abs(cs!.depthMm - THICK)).toBeLessThan(1e-6);
  });

  it('the boss is 12 mm across and 5 mm tall', () => {
    const boss = byKind.get('boss');
    expect(boss).toBeDefined();
    expect(boss!.diameterMm).toBeCloseTo(12, 1);
    expect(Math.abs(boss!.depthMm - 5)).toBeLessThan(1e-6);
  });

  it('every feature carries its support facet ids and its measured fit error', () => {
    for (const feature of result.features) {
      expect(feature.sourceFacetIds.length).toBeGreaterThan(0);
      expect(feature.maxDeviationMm).toBeGreaterThan(0);
      expect(feature.maxDeviationMm).toBeLessThanOrEqual(result.toleranceMm);
      // the ids are a set, ascending, and inside the file's triangle range
      const sorted = [...feature.sourceFacetIds].sort((a, b) => a - b);
      expect(feature.sourceFacetIds).toEqual(sorted);
      expect(new Set(feature.sourceFacetIds).size).toBe(feature.sourceFacetIds.length);
      expect(Math.max(...feature.sourceFacetIds)).toBeLessThan(result.facetCount);
    }
  });

  it('no two features claim the same facet', () => {
    const seen = new Set<number>();
    for (const feature of result.features) {
      for (const id of feature.sourceFacetIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  it('reads in plain words', () => {
    const lines = result.features.map(describeFeature).sort();
    expect(lines.some((l) => /through hole 6\.00 mm, 12\.00 mm deep/.test(l))).toBe(true);
    expect(lines.some((l) => /countersink .*90 degree/.test(l))).toBe(true);
  });
});

describe('WO-1846: a coarse hole is still found, and says so (MESH-HOLE-R1)', () => {
  it('a 16-sided plate reports the same features with a bigger deviation', () => {
    const fine = featuresOf(acceptancePlate(N));
    const coarse = featuresOf(acceptancePlate(16));
    expect(coarse.features.map((f) => f.kind).sort()).toEqual(fine.features.map((f) => f.kind).sort());
    const coarseHole = coarse.features.find((f) => f.kind === 'through-hole')!;
    const fineHole = fine.features.find((f) => f.kind === 'through-hole')!;
    expect(coarseHole.maxDeviationMm).toBeGreaterThan(fineHole.maxDeviationMm * 5);
    // the chord deviation of a 16-sided 6 mm hole, measured not assumed
    expect(coarseHole.maxDeviationMm).toBeCloseTo(3 * (1 - Math.cos(Math.PI / 16)), 4);
    // and the diameter is still right to within that chord deviation
    expect(Math.abs(coarseHole.diameterMm - 6)).toBeLessThanOrEqual(3 * (1 - Math.cos(Math.PI / 16)));
  });
});

describe('WO-1846: a blind hole is a blind hole (MESH-HOLE-R2)', () => {
  it('reports the floor depth, not the plate thickness', () => {
    const result = featuresOf(blindHolePlate());
    expect(result.features.map((f) => f.kind)).toEqual(['blind-hole']);
    const hole = result.features[0];
    expect(hole.diameterMm).toBeCloseTo(8, 1);
    expect(Math.abs(hole.depthMm - 6)).toBeLessThan(1e-6);
  });
});

describe('WO-1846: an obstructed bore is not a hole (MESH-HOLE-R3)', () => {
  it('a bar across the bore refuses the through hole', () => {
    const result = featuresOf(ribbedHolePlate());
    expect(result.features).toEqual([]);
    expect(result.refusals.some((r) => r.reason === 'possible-bore-obstruction')).toBe(true);
  });

  it('the same plate WITHOUT the bar is a through hole - so the bar is what refused it', () => {
    const soup = new Soup();
    const outerTop = squareRing(0, 0, HALF, THICK, N);
    const outerBottom = squareRing(0, 0, HALF, 0, N);
    annulus(soup, ring(0, 0, 3, THICK, N), outerTop, true);
    annulus(soup, ring(0, 0, 3, 0, N), outerBottom, false);
    wall(soup, ring(0, 0, 3, 0, N), ring(0, 0, 3, THICK, N), false);
    wall(soup, outerBottom, outerTop, true);
    const result = featuresOf(soup.bytes());
    expect(result.features.map((f) => f.kind)).toEqual(['through-hole']);
  });
});

describe('WO-1846: a freeform patch proves nothing (MESH-CYL-R1)', () => {
  it('a sphere yields no features at all', () => {
    const result = featuresOf(spherePlate());
    expect(result.features).toEqual([]);
  });
});

describe('WO-1846: the facet ids are WO-1845 source-facet ids', () => {
  it('the same ids come back through the resolver every route uses', () => {
    const bytes = acceptancePlate();
    const direct = featuresOf(bytes);
    const resolved = resolveEditedStlMesh(bytes, undefined);
    const throughResolver = recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds);
    expect(throughResolver.features.map((f) => [f.kind, f.sourceFacetIds]))
      .toEqual(direct.features.map((f) => [f.kind, f.sourceFacetIds]));
  });
});

describe('WO-1846: the ids survive the real save/load path', () => {
  const GEO_ID = 'g-stl-1846';

  function stlRow(): ImportedGeometry {
    return {
      id: GEO_ID, name: 'Plate', filename: 'plate.stl', type: 'mesh', format: 'stl',
      boundingBox: {
        min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: 17 },
        size: { x: 80, y: 80, z: 17 }, center: { x: 0, y: 0, z: 8.5 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    } as ImportedGeometry;
  }

  function project(geometry: ImportedGeometry[]): Project {
    return {
      id: 'p-1846', name: 'Features', version: '1.0.0',
      createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
      machine: {
        id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
        travel: { x: 800, y: 600, z: 100 },
        rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
        spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
      },
      toolLibrary: [], geometry,
      setups: [{
        id: 'setup-1846', name: 'Setup 1', operations: [], stock: null, notes: '',
        wcs: {
          id: 'wcs-1', label: 'G54', fixtureOffset: 54,
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
        },
      } as unknown as Setup],
      activeSetupId: 'setup-1846', activeOperationId: null,
      sceneStock: {
        mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
        fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
      },
      notes: '',
    } as unknown as Project;
  }

  it('saves, reloads, and finds the SAME four features with the SAME facet ids', async () => {
    const bytes = acceptancePlate();
    stlBytesById.clear();
    stlBytesById.set(GEO_ID, bytes);
    useCamStore.setState({ project: project([stlRow()]) });

    const before = featuresOf(bytes);
    expect(before.features).toHaveLength(4);

    const savedBlobs: Blob[] = [];
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo1846'; },
      revokeObjectURL: () => {},
    });
    vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) });
    try {
      await useCamStore.getState().saveProjectToFile();
      expect(savedBlobs).toHaveLength(1);
      const fileText = await savedBlobs[0].text();

      // Everything in memory is gone; all that survives is the file.
      stlBytesById.clear();
      useCamStore.setState({ project: project([]) });
      await useCamStore.getState().loadProjectFromFile(fileText);

      const reloadedBytes = stlBytesById.get(GEO_ID);
      expect(reloadedBytes).toBeTruthy();
      const row = useCamStore.getState().project.geometry.find((g) => g.id === GEO_ID);
      expect(row).toBeTruthy();

      // Through THE resolver, exactly as a consumer route would.
      const resolved = resolveEditedStlMesh(reloadedBytes!, row!.meshEdits);
      const after = recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds);
      expect(after.features.map((f) => [f.kind, f.sourceFacetIds]))
        .toEqual(before.features.map((f) => [f.kind, f.sourceFacetIds]));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

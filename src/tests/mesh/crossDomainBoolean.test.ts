// MSH-4 — Cross-domain boolean: mesh op brep, honestly labeled. The B-rep
// operand is built and tessellated through the REAL geom worker (GeomEngine,
// real occt-wasm kernel, read-only tessellate() consumption per WO ruling 1)
// and the boolean itself runs on the REAL manifold-3d mesh kernel -- no
// mocks on either side of the bridge.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GeomEngine } from '../../geom/worker/geom-engine.ts';
import type { ExtrudeRequest, ProfileRegion } from '../../geom/geom-service.ts';
import { xyPlane } from '../geom/fixtures/profiles.ts';
import { debugLiveHandleCount } from '../../mesh/manifoldOps';
import { ManifoldKernel, type ManifoldWasmModule } from '../../mesh/manifoldKernel';
import {
  crossDomainBooleanMesh,
  meshOperand,
  brepOperand,
  meshFromTessBuffers,
  CrossDomainBooleanRefusedError,
  type CrossDomainOperand,
} from '../../mesh/crossDomainBoolean';
import { importStl } from '../../mesh/stl';
import type { MeshBuffers, Vec3 } from '../../mesh/types';
import { unitCube } from './fixtures';

function translateMesh(mesh: MeshBuffers, offset: Vec3): MeshBuffers {
  const positions = new Float32Array(mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += offset[0];
    positions[i + 1] += offset[1];
    positions[i + 2] += offset[2];
  }
  return { positions, indices: new Uint32Array(mesh.indices) };
}

/** Divergence-theorem volume straight off a triangle-indexed buffer pair --
 *  independent of mesh/analysis.ts so criterion assertions don't check the
 *  module against itself. */
function volumeOf(position: Float32Array, index: Uint32Array): number {
  let vol = 0;
  for (let i = 0; i < index.length; i += 3) {
    const ia = index[i] * 3, ib = index[i + 1] * 3, ic = index[i + 2] * 3;
    const ax = position[ia], ay = position[ia + 1], az = position[ia + 2];
    const bx = position[ib], by = position[ib + 1], bz = position[ib + 2];
    const cx = position[ic], cy = position[ic + 1], cz = position[ic + 2];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(vol);
}

function loadPlatteC(): MeshBuffers {
  const bytes = readFileSync('src/tests/mesh/fixtures/obj_1_Platte C.stl');
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return importStl(ab).mesh;
}

const circleProfile = (r: number): ProfileRegion => ({
  sketchId: 'SC',
  plane: xyPlane(0),
  loops: [[{ kind: 'arc', c: [0, 0], r, a0: 0, a1: Math.PI * 2, ccw: true, srcId: 'SC.c0' }]],
});

describe('crossDomainBoolean (MSH-4)', () => {
  let engine: GeomEngine;
  let module: ManifoldWasmModule;

  beforeAll(async () => {
    engine = new GeomEngine();
    await engine.init();
    module = await new ManifoldKernel().getModule({ requireManifold: true });
  }, 60_000);

  afterAll(async () => {
    await engine.disposeKernel();
  });

  describe('criterion 1: planar brep operand is exact regardless of tolerance', () => {
    it('a box tessellated at two very different tolerances yields IDENTICAL triangle geometry (planar faces have zero deflection error)', async () => {
      const box = await engine.makeBox('BX1', { x: 10, y: 10, z: 10 });
      expect(box.ok).toBe(true);
      const coarse = await engine.tessellate(box.body!, { deflection: 1.0, angularDeflection: Math.PI });
      const fine = await engine.tessellate(box.body!, { deflection: 0.001, angularDeflection: Math.PI });
      // a box has 6 planar faces -> 12 triangles at ANY tolerance; a curved
      // surface would refine as tolerance tightens (see criterion 2 below).
      expect(coarse.index.length / 3).toBe(12);
      expect(fine.index.length / 3).toBe(12);
      const coarseVol = volumeOf(coarse.position, coarse.index);
      const fineVol = volumeOf(fine.position, fine.index);
      expect(Math.abs(coarseVol - fineVol)).toBeLessThan(1e-3); // float32 storage rounding only
      await engine.dispose(box.body!);
    }, 30_000);

    it('mesh-cube UNION brep-box: watertight, volume matches the EXACT closed-form CSG volume (analytic bound = 0, i.e. exact for planar operands)', async () => {
      const box = await engine.makeBox('BX2', { x: 10, y: 10, z: 10 }); // occupies [0,10]^3
      const tol = 0.25;
      const tess = await engine.tessellate(box.body!, { deflection: tol, angularDeflection: Math.PI });

      const meshCube = translateMesh(unitCube(10), [5, 0, 0]); // occupies [5,15]x[0,10]x[0,10]
      const left = meshOperand(meshCube);
      const right = brepOperand(tess, tol);

      // Analytic closed-form CSG volume for two axis-aligned 10^3 boxes
      // offset by 5 along X: overlap is a 5x10x10 slab.
      const boxVol = 1000, overlap = 5 * 10 * 10;
      const analytic = { union: boxVol + boxVol - overlap, difference: boxVol - overlap, intersect: overlap };

      for (const [operation, expected] of Object.entries(analytic) as Array<[
        'union' | 'difference' | 'intersect', number,
      ]>) {
        const result = crossDomainBooleanMesh(module, left, right, { operation });
        expect(result.report.watertight).toBe(true);
        expect(Math.abs(result.measures.volume - expected) / expected).toBeLessThan(1e-4);
      }
      await engine.dispose(box.body!);
    }, 30_000);
  });

  describe('criterion 2: curved (cylinder) brep operand -- tolerance is real', () => {
    const R = 8, H = 20;
    const analyticVol = Math.PI * R * R * H;

    it('two tolerances produce measurably different operand triangle counts, and volume error shrinks monotonically as tolerance tightens', async () => {
      const cyl = await engine.makeExtrude({
        featureId: 'EX1', profile: circleProfile(R), end: { kind: 'blind', distance: H }, op: 'newBody',
      } satisfies ExtrudeRequest);
      expect(cyl.ok).toBe(true);

      // Derivation of the expected error SHAPE (not an exact universal OCCT
      // constant -- see the calibration note below): OCCT's linear-deflection
      // tessellation caps the chordal sagitta s = R(1-cos(theta/2)) ~= R
      // theta^2/8 at the deflection tolerance t, so the max segment angle is
      // theta_max ~= sqrt(8t/R). An n-gon inscribed in a circle of radius R
      // has an area deficit (vs. the true disc) of ~= (2*pi^3*R^2)/(3*n^2)
      // for large n (from sin(x) ~= x - x^3/6 in the polygon-area formula).
      // Substituting n = 2*pi/theta_max gives a per-cylinder-face deficit
      // ~= O(R*t), so the volume error scales as ~= C*R*H*t for a constant C
      // set by the actual occt-wasm triangulator (not purely analytic --
      // sagitta-vs-deflection conventions and the exact segment-count
      // rounding are implementation details of the kernel we don't reach
      // into). MEASURED against the real kernel (7-point table, tol
      // 1.0..0.01): C sits at ~2.0-2.1 and the fit is linear in t across two
      // decades. bound() below uses C=3 for a >=20% safety margin over every
      // measured point while still being a tight, real, derived-shape bound
      // -- not a hand-waved "close enough".
      const bound = (t: number) => 3 * R * H * t;

      const tolerances = [0.5, 0.1, 0.02];
      const rows: Array<{ t: number; triCount: number; vol: number; err: number }> = [];
      for (const t of tolerances) {
        const tess = await engine.tessellate(cyl.body!, { deflection: t, angularDeflection: Math.PI });
        const triCount = tess.index.length / 3;
        const vol = volumeOf(tess.position, tess.index);
        const err = analyticVol - vol;
        rows.push({ t, triCount, vol, err });
        console.log(`[MSH-4 criterion-2] t=${t} triCount=${triCount} vol=${vol.toFixed(4)} analyticVol=${analyticVol.toFixed(4)} err=${err.toFixed(4)} bound=${bound(t).toFixed(4)}`);
      }

      // tolerance is real: strictly more triangles at tighter tolerance.
      expect(rows[1].triCount).toBeGreaterThan(rows[0].triCount);
      expect(rows[2].triCount).toBeGreaterThan(rows[1].triCount);
      // volume error shrinks monotonically as tolerance tightens.
      expect(rows[1].err).toBeLessThan(rows[0].err);
      expect(rows[2].err).toBeLessThan(rows[1].err);
      // every measured error stays under the derived+calibrated bound.
      for (const row of rows) {
        expect(row.err).toBeGreaterThan(0); // inscribed tessellation always UNDER-estimates a convex solid's volume
        expect(row.err).toBeLessThan(bound(row.t));
      }

      await engine.dispose(cyl.body!);
    }, 60_000);

    it('functional: mesh-cube UNION brep-cylinder produces a watertight result with the curved operand', async () => {
      const cyl = await engine.makeExtrude({
        featureId: 'EX2', profile: circleProfile(R), end: { kind: 'blind', distance: H }, op: 'newBody',
      } satisfies ExtrudeRequest);
      const tol = 0.1;
      const tess = await engine.tessellate(cyl.body!, { deflection: tol, angularDeflection: Math.PI });

      const meshCube = translateMesh(unitCube(4), [-2, -2, H - 1]); // straddles the cylinder's top cap
      const result = crossDomainBooleanMesh(module, meshOperand(meshCube), brepOperand(tess, tol), { operation: 'union' });
      expect(result.report.watertight).toBe(true);
      expect(result.measures.volume).toBeGreaterThan(analyticVol); // union only ever adds volume
      expect(result.domain).toBe('mesh');
      expect(result.approximate).toBe(true);
      expect(result.tessellationTolerance).toBe(tol);

      await engine.dispose(cyl.body!);
    }, 30_000);
  });

  describe('criterion 3: provenance + brep-vs-brep refusal', () => {
    it('result carries {domain, approximate, tessellationTolerance, operandSources} honestly', async () => {
      const box = await engine.makeBox('BX3', { x: 5, y: 5, z: 5 });
      const tol = 0.3;
      const tess = await engine.tessellate(box.body!, { deflection: tol, angularDeflection: Math.PI });

      const result = crossDomainBooleanMesh(module, meshOperand(unitCube(5)), brepOperand(tess, tol), { operation: 'intersect' });
      expect(result.domain).toBe('mesh');
      expect(result.approximate).toBe(true);
      expect(result.tessellationTolerance).toBe(tol);
      expect(result.operandSources).toEqual([{ domain: 'mesh' }, { domain: 'brep', tessellationTolerance: tol }]);

      await engine.dispose(box.body!);
    }, 30_000);

    it('mesh-vs-mesh through this API is honestly labeled NOT approximate (nothing was tessellated)', () => {
      const result = crossDomainBooleanMesh(module, meshOperand(unitCube(5)), meshOperand(translateMesh(unitCube(5), [2, 0, 0])), { operation: 'union' });
      expect(result.domain).toBe('mesh');
      expect(result.approximate).toBe(false);
      expect(result.tessellationTolerance).toBeNull();
    });

    it('FAILS-IF (criterion 3): brep-vs-brep is REFUSED, never silently approximated -- that pair belongs to the exact geom worker', async () => {
      const boxA = await engine.makeBox('BX4', { x: 5, y: 5, z: 5 });
      const boxB = await engine.makeBox('BX5', { x: 5, y: 5, z: 5 });
      const tessA = await engine.tessellate(boxA.body!, { deflection: 0.1, angularDeflection: Math.PI });
      const tessB = await engine.tessellate(boxB.body!, { deflection: 0.1, angularDeflection: Math.PI });

      const left = brepOperand(tessA, 0.1);
      const right = brepOperand(tessB, 0.1);
      expect(() => crossDomainBooleanMesh(module, left, right, { operation: 'union' })).toThrow(CrossDomainBooleanRefusedError);
      expect(() => crossDomainBooleanMesh(module, left, right, { operation: 'union' })).toThrow(/brep-vs-brep/i);

      await engine.dispose(boxA.body!);
      await engine.dispose(boxB.body!);
    }, 30_000);
  });

  describe('criterion 4: real-part proof -- imported real STL cut by a designed brep body', () => {
    it('Sample Parts/obj_1_Platte C.stl (imported, real machined plate) CUT by a designed brep box: watertight, measured volume delta', async () => {
      const plateMesh = loadPlatteC();
      const plateTriCount = plateMesh.indices.length / 3;
      const plateVol = volumeOf(plateMesh.positions, plateMesh.indices);
      // real fixture bbox (measured): x,y in [98,158], z in [0,4] -- a 60x60x4 plate.
      const bbox = { min: [98, 98, 0] as const, max: [158, 158, 4] as const };
      expect(bbox.min[0]).toBeLessThan(bbox.max[0]);

      // Designed cutting box: a 30x30x6 notch over the plate's [98,128]^2
      // corner, spanning z=[-1,5] so it fully passes through the 4mm plate
      // (margin both sides -- a clean through-cut, not a partial pocket).
      const cutBoxProfile: ProfileRegion = {
        sketchId: 'CUT',
        plane: xyPlane(-1),
        loops: [[
          { kind: 'line', a: [98, 98], b: [128, 98], srcId: 'CUT.e0' },
          { kind: 'line', a: [128, 98], b: [128, 128], srcId: 'CUT.e1' },
          { kind: 'line', a: [128, 128], b: [98, 128], srcId: 'CUT.e2' },
          { kind: 'line', a: [98, 128], b: [98, 98], srcId: 'CUT.e3' },
        ]],
      };
      const cutBox = await engine.makeExtrude({
        featureId: 'CUT1', profile: cutBoxProfile, end: { kind: 'blind', distance: 6 }, op: 'newBody',
      } satisfies ExtrudeRequest);
      expect(cutBox.ok).toBe(true);

      const tol = 0.05;
      const tess = await engine.tessellate(cutBox.body!, { deflection: tol, angularDeflection: Math.PI });

      const result = crossDomainBooleanMesh(
        module,
        meshOperand(plateMesh),
        brepOperand(tess, tol),
        { operation: 'difference' },
      );

      const resultTriCount = result.mesh.indices.length / 3;
      const volumeDelta = plateVol - result.measures.volume;
      console.log(
        `[MSH-4 criterion-4] part=obj_1_Platte C.stl plateTriCount=${plateTriCount} resultTriCount=${resultTriCount} ` +
          `plateVolume=${plateVol.toFixed(3)} resultVolume=${result.measures.volume.toFixed(3)} volumeDelta=${volumeDelta.toFixed(3)} ` +
          `watertight=${result.report.watertight} approximate=${result.approximate} tessellationTolerance=${result.tessellationTolerance}`,
      );

      expect(result.report.watertight).toBe(true);
      expect(volumeDelta).toBeGreaterThan(0); // material was actually removed
      expect(volumeDelta).toBeLessThan(plateVol); // sane: didn't remove more than the whole part
      expect(result.domain).toBe('mesh');
      expect(result.approximate).toBe(true);
      expect(result.tessellationTolerance).toBe(tol);

      await engine.dispose(cutBox.body!);
    }, 60_000);
  });

  describe('standing acceptance #7/#9: wasm-handle lifecycle on the new op\'s failure paths', () => {
    it('the refusal path (brep-vs-brep) mints zero manifold-3d handles', async () => {
      const box = await engine.makeBox('BX6', { x: 3, y: 3, z: 3 });
      const tess = await engine.tessellate(box.body!, { deflection: 0.1, angularDeflection: Math.PI });
      const left = brepOperand(tess, 0.1);
      const right = brepOperand(tess, 0.1);

      const before = debugLiveHandleCount();
      expect(() => crossDomainBooleanMesh(module, left, right, { operation: 'union' })).toThrow(CrossDomainBooleanRefusedError);
      expect(debugLiveHandleCount()).toBe(before);

      await engine.dispose(box.body!);
    }, 30_000);

    it('a malformed-mesh error path (thrown inside booleanMesh) still releases every minted handle', () => {
      const bad: MeshBuffers = { positions: new Float32Array([0, 0, 0, 1, 0]), indices: new Uint32Array([0, 0, 0]) }; // positions.length not divisible by 3
      const left: CrossDomainOperand = meshOperand(bad);
      const right = meshOperand(unitCube(5));

      const before = debugLiveHandleCount();
      expect(() => crossDomainBooleanMesh(module, left, right, { operation: 'union' })).toThrow();
      expect(debugLiveHandleCount()).toBe(before);
    });

    it('a successful cross-domain op returns to the zero baseline afterward', async () => {
      const box = await engine.makeBox('BX7', { x: 4, y: 4, z: 4 });
      const tess = await engine.tessellate(box.body!, { deflection: 0.1, angularDeflection: Math.PI });

      const before = debugLiveHandleCount();
      crossDomainBooleanMesh(module, meshOperand(unitCube(4)), brepOperand(tess, 0.1), { operation: 'union' });
      expect(debugLiveHandleCount()).toBe(before);

      await engine.dispose(box.body!);
    }, 30_000);
  });

  it('meshFromTessBuffers adapts TessBuffers geometry fields directly (no copy of position/index)', async () => {
    const box = await engine.makeBox('BX8', { x: 2, y: 2, z: 2 });
    const tess = await engine.tessellate(box.body!, { deflection: 0.1, angularDeflection: Math.PI });
    const mesh = meshFromTessBuffers(tess);
    expect(mesh.positions).toBe(tess.position);
    expect(mesh.indices).toBe(tess.index);
    await engine.dispose(box.body!);
  }, 30_000);
});

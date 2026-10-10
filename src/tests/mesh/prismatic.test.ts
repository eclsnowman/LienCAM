// MSH-3 mesh-side prismatic converter: segmentation, confidence report,
// curved refusal, robustness gates, and determinism (criteria 2-5, mesh side).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertPrismaticMesh, type PrismaticConversionResult } from '../../mesh/prismatic';
import { importStl } from '../../mesh/stl';
import {
  unitCube,
  sphereApprox,
  cylinderApprox,
  cubeWithMissingTop,
  cubeWithDegenerateTriangle,
  shuffleTriangles,
} from './fixtures';

function loadPlate() {
  const bytes = readFileSync('src/tests/mesh/fixtures/prismatic-plate.stl');
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return importStl(ab).mesh;
}

/** Real Sample Parts fixture (MSH-3-R1.1: committed, not read in place -- 71KB
 *  permits copying per the WO). Copied byte-for-byte from
 *  "Sample Parts/obj_1_Platte C.stl". This part has 14 cylindrical bore/fillet
 *  features and is genuinely NOT prismatic, so it pins the honest V1 REFUSAL
 *  the auditor probed by hand -- it is not the criterion-2 success fixture
 *  (that is the synthetic prismatic-plate.stl above; see WO adjudication). */
function loadRealPlatteC() {
  const bytes = readFileSync('src/tests/mesh/fixtures/obj_1_Platte C.stl');
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return importStl(ab).mesh;
}

/** Canonical serialization of a conversion's face set for equality checks. */
function faceSetSignature(r: PrismaticConversionResult): string {
  if (!r.ok) throw new Error('expected ok conversion');
  const round = (x: number) => Math.round(x * 1e4) / 1e4;
  return JSON.stringify(
    r.faceSet.faces.map((f) => ({
      n: [round(f.plane.normal.x), round(f.plane.normal.y), round(f.plane.normal.z)],
      outer: f.outer.map((p) => [round(p.x), round(p.y), round(p.z)]),
      holes: f.holes.map((h) => h.map((p) => [round(p.x), round(p.y), round(p.z)])),
    })),
  );
}

describe('convertPrismaticMesh — segmentation', () => {
  it('cube -> exactly 6 planar faces, residual ~0, high confidence', () => {
    const r = convertPrismaticMesh(unitCube(10));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.faceCount).toBe(6);
    expect(r.faceSet.faces).toHaveLength(6);
    for (const f of r.faceSet.faces) {
      expect(f.outer).toHaveLength(4);
      expect(f.holes).toHaveLength(0);
    }
    expect(r.report.maxResidual).toBeLessThan(1e-6);
    expect(r.report.minConfidence).toBeGreaterThan(0.999);
  });

  it('prismatic plate (2 rectangular holes) -> 14 faces, caps carry both holes', () => {
    const r = convertPrismaticMesh(loadPlate(), { convertId: 'CNVP' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.faceCount).toBe(14);
    const capsWithHoles = r.faceSet.faces.filter((f) => f.holes.length === 2);
    expect(capsWithHoles).toHaveLength(2); // top + bottom, each with both holes
    // every hole loop is a rectangle (4 corners after collinear collapse)
    for (const cap of capsWithHoles) for (const h of cap.holes) expect(h).toHaveLength(4);
    expect(r.report.maxResidual).toBeLessThan(1e-3);
  });
});

describe('convertPrismaticMesh — curved refusal (criterion 3)', () => {
  it('sphere -> refused, names the curved region + share + explanation, no faceSet', () => {
    const r = convertPrismaticMesh(sphereApprox(10, 32, 16));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('refused-curved');
    if (r.kind !== 'refused-curved') return;
    expect(r.curvedRegions.length).toBeGreaterThanOrEqual(1);
    const region = r.curvedRegions[0];
    expect(region.triangleCount).toBeGreaterThan(0);
    expect(region.triangleShare).toBeGreaterThan(0.9);
    expect(region.shapeHint).toBe('sphere-like');
    expect(r.message.toLowerCase()).toContain('curved');
    expect('faceSet' in r).toBe(false);
  });

  it('cylinder -> refused, wall is named cylinder-like, caps counted as planar', () => {
    const r = convertPrismaticMesh(cylinderApprox(5, 12, 48));
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== 'refused-curved') return;
    expect(r.curvedRegions.some((c) => c.shapeHint === 'cylinder-like')).toBe(true);
    // the two flat caps are still recognized as planar in the transparency report
    expect(r.report.faceCount).toBe(2);
  });

  it('R1.1: real Sample Parts/obj_1_Platte C.stl -> refused-curved (honest V1 limitation on a real part)', () => {
    const r = convertPrismaticMesh(loadRealPlatteC());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('refused-curved');
    if (r.kind !== 'refused-curved') return;
    // measured against the committed fixture; matches the auditor's own probe
    // (19 curved regions, 14 planar faces found before refusal).
    expect(r.curvedRegions).toHaveLength(19);
    expect(r.curvedRegions.every((c) => c.triangleCount > 0)).toBe(true);
    expect(r.message.toLowerCase()).toContain('curved');
    // transparency: the planar faces the segmentation DID find are still named
    // in the report, even though no solid is emitted.
    expect(r.report.faceCount).toBe(14);
    expect(r.report.faces).toHaveLength(14);
    for (const f of r.report.faces) {
      expect(f.triangleCount).toBeGreaterThan(0);
      expect(f.normal.some((n) => n !== 0)).toBe(true);
    }
    expect('faceSet' in r).toBe(false);
  });
});

describe('convertPrismaticMesh — robustness (criterion 4)', () => {
  it('non-watertight input -> typed non-watertight failure, no crash', () => {
    const r = convertPrismaticMesh(cubeWithMissingTop());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('non-watertight');
    if (r.kind !== 'non-watertight') return;
    expect(r.boundaryEdgeCount).toBeGreaterThan(0);
  });

  it('degenerate-triangle input -> typed degenerate failure, no crash', () => {
    const r = convertPrismaticMesh(cubeWithDegenerateTriangle());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('degenerate-input');
    if (r.kind !== 'degenerate-input') return;
    expect(r.degenerateTriangleCount).toBeGreaterThan(0);
  });

  it('empty mesh -> typed empty failure', () => {
    const r = convertPrismaticMesh({ positions: new Float32Array(), indices: new Uint32Array() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('empty');
  });
});

describe('convertPrismaticMesh — determinism (criterion 5)', () => {
  it('FAILS-IF: seeded shuffles of triangle order produce identical face sets', () => {
    const base = convertPrismaticMesh(loadPlate());
    const sigBase = faceSetSignature(base);
    for (const seed of [1, 7, 42, 1337]) {
      const shuffled = convertPrismaticMesh(shuffleTriangles(loadPlate(), seed));
      expect(shuffled.ok).toBe(true);
      expect(faceSetSignature(shuffled)).toBe(sigBase);
    }
  });

  it('two runs on the same input are byte-identical', () => {
    const a = convertPrismaticMesh(unitCube(10));
    const b = convertPrismaticMesh(unitCube(10));
    expect(faceSetSignature(a)).toBe(faceSetSignature(b));
  });
});

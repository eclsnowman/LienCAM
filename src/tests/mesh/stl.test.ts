import { describe, expect, it } from 'vitest';
import { exportBinaryStl, importStl, parseStl } from '../../mesh/stl';
import { asciiCubeFixture, binaryStlFixture, selfIntersectingTriangles, unitCube } from './fixtures';

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

describe('mesh STL import/export', () => {
  it('round-trips a binary STL through export and reimport', () => {
    const first = importStl(binaryStlFixture());
    const exported = exportBinaryStl(first.mesh);
    const second = importStl(exported.bytes);

    expect(first.format).toBe('binary');
    expect(second.report.triangleCount).toBe(first.report.triangleCount);
    expect(second.measures.volume).toBeCloseTo(first.measures.volume, 6);
  });

  it('round-trips an ASCII STL through binary export and reimport', () => {
    const first = importStl(asciiCubeFixture());
    const exported = exportBinaryStl(first.mesh);
    const second = importStl(exported.bytes);

    expect(first.format).toBe('ascii');
    expect(second.report.triangleCount).toBe(first.report.triangleCount);
    expect(second.measures.volume).toBeCloseTo(first.measures.volume, 6);
  });

  it('emits byte-identical deterministic STL for the same input', () => {
    const mesh = unitCube();
    const a = exportBinaryStl(mesh).bytes;
    const b = exportBinaryStl(mesh).bytes;
    expect(sameBytes(a, b)).toBe(true);
  });

  it('gates import-time self-intersection checks behind an opt-in flag', () => {
    const bytes = exportBinaryStl(selfIntersectingTriangles()).bytes;

    expect(importStl(bytes).report.selfIntersections).toBe(false);
    expect(importStl(bytes, { checkSelfIntersections: true }).report.selfIntersections).toBe(true);
  });

  it('detects malformed ASCII STL loudly', () => {
    const bytes = new TextEncoder().encode('solid bad\nvertex 0 0 0\nendsolid bad');
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    expect(() => parseStl(ab)).toThrow(/malformed ascii STL/);
  });
});

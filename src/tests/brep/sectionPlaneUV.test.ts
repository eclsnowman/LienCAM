// Headless (no-OCCT) unit tests for the plane-UV flatten/unflatten helpers that
// back sectionAtPlane (derive.ts). These are the SAME math Item 2's viewport
// unflatten mirrors (geometry_local -> O + X*u + Y*v), so a round-trip guarantee
// here pins both sides of the section representation.
import { describe, expect, it } from "vitest";
import {
  flattenToPlaneUV,
  unflattenUV,
} from "../../lib/cam/geometry/occt/model/derive";

type P3 = [number, number, number];

const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: P3): P3 => {
  const m = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / m, a[1] / m, a[2] / m];
};
const cross = (a: P3, b: P3): P3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

describe("flattenToPlaneUV / unflattenUV", () => {
  it("horizontal axis-aligned frame: flatten([x,y,z]) === [x,y]", () => {
    const O: P3 = [0, 0, 7];
    const X: P3 = [1, 0, 0];
    const Y: P3 = [0, 1, 0];
    const cases: P3[] = [
      [0, 0, 7],
      [3, -4, 7],
      [-12.5, 8.25, 7],
      [100, 200, 7],
    ];
    for (const p of cases) {
      const uv = flattenToPlaneUV(p, O, X, Y);
      // Exact equality: u=x, v=y (the byte-identical horizontal guarantee).
      expect(uv[0]).toBe(p[0]);
      expect(uv[1]).toBe(p[1]);
    }
  });

  it("tilted orthonormal frame: unflatten(flatten(p)) reconstructs p in-plane (<1e-9)", () => {
    // A genuinely tilted, right-handed orthonormal frame.
    const O: P3 = [2, -3, 5];
    const X = norm([1, 1, 0]); // 45 deg in XY
    const N0 = norm([0, -1, 2]); // arbitrary normal
    // Re-orthonormalize: Y = N x X, then N = X x Y (right-handed).
    const Y = norm(cross(N0, X));
    const N = norm(cross(X, Y));

    // Sanity: frame is orthonormal.
    expect(Math.abs(dot(X, Y))).toBeLessThan(1e-12);
    expect(Math.abs(dot(X, N))).toBeLessThan(1e-12);
    expect(Math.abs(dot(Y, N))).toBeLessThan(1e-12);

    // Points that LIE IN the plane (O + X*u + Y*v) must round-trip to themselves.
    const inPlane: [number, number][] = [
      [0, 0],
      [3.5, -2.25],
      [-10, 4],
      [0.001, 99.5],
    ];
    for (const [u, v] of inPlane) {
      const p = unflattenUV(u, v, O, X, Y);
      const uv = flattenToPlaneUV(p, O, X, Y);
      expect(Math.abs(uv[0] - u)).toBeLessThan(1e-9);
      expect(Math.abs(uv[1] - v)).toBeLessThan(1e-9);
      const back = unflattenUV(uv[0], uv[1], O, X, Y);
      expect(Math.abs(back[0] - p[0])).toBeLessThan(1e-9);
      expect(Math.abs(back[1] - p[1])).toBeLessThan(1e-9);
      expect(Math.abs(back[2] - p[2])).toBeLessThan(1e-9);
    }
  });

  it("off-plane component is dropped by flatten, recoverable only along the normal", () => {
    const O: P3 = [0, 0, 0];
    const X = norm([2, 0, 1]);
    const N0 = norm([-1, 0, 2]);
    const Y = norm(cross(N0, X));
    const N = norm(cross(X, Y));

    // A point offset off the plane by d along N flattens to the same (u,v) as its
    // in-plane projection -> unflatten lands the projection, not the original.
    const base = unflattenUV(4, -1.5, O, X, Y);
    const d = 3.3;
    const offset: P3 = [
      base[0] + N[0] * d,
      base[1] + N[1] * d,
      base[2] + N[2] * d,
    ];
    const uv = flattenToPlaneUV(offset, O, X, Y);
    const projected = unflattenUV(uv[0], uv[1], O, X, Y);
    expect(Math.abs(projected[0] - base[0])).toBeLessThan(1e-9);
    expect(Math.abs(projected[1] - base[1])).toBeLessThan(1e-9);
    expect(Math.abs(projected[2] - base[2])).toBeLessThan(1e-9);
    // The dropped distance equals the normal component (sanity on the frame).
    expect(Math.abs(dot([offset[0], offset[1], offset[2]], N) - d)).toBeLessThan(1e-9);
  });
});

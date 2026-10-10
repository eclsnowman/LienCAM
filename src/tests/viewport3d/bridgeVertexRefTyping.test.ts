// viewport3d BridgeVertexRef typing (WO UI-2 acceptance #3 FAILS-IF): "a test
// must fail if a BridgeVertexRef is ever presented typed as StableId". Two
// independent guards:
//  (a) compile-time: a @ts-expect-error line that only stays valid while
//      BridgeVertexRef is NOT assignable to StableId. tsconfig.app.json's
//      `include` is ["src"] (confirmed by reading it), so `npm run build`'s
//      `tsc -b` type-checks this file; if the brand is ever weakened so the
//      assignment below type-checks, the @ts-expect-error itself becomes an
//      "unused directive" compile error and the build fails.
//  (b) runtime: a REAL PickEngine vertex-pick result, asserting its `.id` is
//      not a string and does carry `.adjacentEdgeIds` -- this is what
//      actually fails a `vitest run` if the pick code path ever regressed to
//      returning a bare StableId string for a vertex hit (a type-only guard
//      would not catch that; vitest doesn't type-check).

import { describe, expect, it } from 'vitest';
import { GeometryCache } from '../../viewport3d/GeometryCache';
import { PickEngine } from '../../viewport3d/PickEngine';
import { makeBridgeVertexRef, type BridgeVertexRef, type RayLike, type StableId } from '../../viewport3d/types';
import { makeBoxFixture } from './fixtures';

const BODY_ID = 'box-1';

function ray(origin: [number, number, number], direction: [number, number, number]): RayLike {
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    direction: { x: direction[0], y: direction[1], z: direction[2] },
  };
}

describe('BridgeVertexRef vs StableId typing', () => {
  it('compile-time guard: BridgeVertexRef is not assignable to StableId', () => {
    const ref: BridgeVertexRef = makeBridgeVertexRef(['E1', 'E2']);
    // @ts-expect-error BridgeVertexRef intentionally does NOT structurally satisfy
    // StableId (WO UI-1 R1.2 / architect ruling, restated in WO UI-2's binding
    // rulings): a vertex-pick id must never be usable where a document-reference
    // StableId is expected. If this line stops erroring, the brand has been
    // removed or bypassed -- `npm run build` (tsc -b) fails on the resulting
    // unused @ts-expect-error directive.
    const asStableId: StableId = ref;
    void asStableId;
  });

  it('runtime guard: a real vertex pick returns a BridgeVertexRef, not a bare StableId string', () => {
    const fixture = makeBoxFixture();
    const cache = new GeometryCache();
    cache.ingest(BODY_ID, fixture.buffers);
    const engine = new PickEngine(cache);

    const corner = fixture.corners[6];
    const [cx, cy, cz] = corner.position;
    const hit = engine.pick(BODY_ID, ray([cx + 30, cy + 30, cz], [-1, -1, 0]), 'vertex');

    expect(hit).not.toBeNull();
    if (hit === null) throw new Error('unreachable');
    expect(hit.kind).toBe('vertex');
    // Deliberately NOT narrowing via `hit.kind !== 'vertex'` before this check --
    // the point is to prove at runtime (not just via the type system) that
    // `.id` is not a string, independent of the discriminated-union narrowing.
    expect(typeof hit.id).not.toBe('string');
    if (hit.kind !== 'vertex') throw new Error('unreachable');
    expect(Array.isArray(hit.id.adjacentEdgeIds)).toBe(true);
    expect(hit.id.adjacentEdgeIds.length).toBeGreaterThan(0);
    expect([...hit.id.adjacentEdgeIds].sort()).toEqual(corner.expectedAdjacentEdgeIds);
  });
});

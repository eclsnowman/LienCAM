import { describe, expect, it } from 'vitest'
import {
  heightIntentAfterNumericEdit,
  operationSafetyHeightIntent,
  resolveHeightIntent,
  type OperationSafetyPlane,
} from '../../lib/cam/heightIntent'
import { buildParallel3dSmartIntent } from '../../lib/cam/smartHeights'
import type { HeightIntentV1, HeightParams } from '../../types'

// WO-1390 / BUG-538: a typed height must back-solve against the LIVE reference
// plane the Smart Height V2 resolver would use, not the legacy flat mirror,
// which a pending setup-level change (e.g. a new material start) may not have
// recomputed yet.
describe('heightIntentAfterNumericEdit backs solve against a live plane (BUG-538)', () => {
  function heightsWithStalePlane(): HeightParams {
    return {
      clearanceHeight: 130, clearanceHeightMode: 'absolute',
      retractHeight: 115, feedHeight: 105,
      // The legacy mirror still reflects the OLD stock top (100): a setup
      // material-start change has happened but no recompute has run yet.
      topHeight: 100, topHeightMode: 'stock_top',
      bottomHeight: -5, bottomHeightMode: 'model_bottom',
      heightIntent: {
        version: 1,
        clearance: { reference: 'retract', offset: 15, provenance: 'inferred' },
        retract: { reference: 'feed', offset: 10, provenance: 'inferred' },
        // feed reads from top, which itself reads from stock_top - the chain
        // a typed Feed Height must walk live, not through the stale mirror.
        feed: { reference: 'top', offset: 5, provenance: 'inferred' },
        top: { reference: 'stock_top', offset: 0, provenance: 'inferred' },
        bottom: { reference: 'top', offset: -8, provenance: 'inferred' },
      },
    } as HeightParams
  }

  it('resolves the typed value exactly, even though the mirror is stale', () => {
    const heights = heightsWithStalePlane()
    // The setup's material start moved from 100 (the stale mirror) to 102
    // (what a live resolver, e.g. resolveIntentReferenceWcsZ, would report).
    const liveStockTop = 102
    const typedFeedZ = 108

    const nextIntent = heightIntentAfterNumericEdit(
      heights, 'feed', typedFeedZ,
      reference => (reference === 'stock_top' ? liveStockTop : undefined),
    )

    // The authored reference is preserved (still relative to top)...
    expect(nextIntent.feed.reference).toBe('top')
    // ...and resolving that intent against the SAME live stock top the typed
    // edit used reproduces exactly what the operator typed.
    const resolved = resolveHeightIntent(nextIntent, {
      wcsOriginZ: 0,
      referenceWcsZ: { stock_top: liveStockTop },
    })
    expect(resolved.wcs.feed).toBeCloseTo(typedFeedZ, 9)
  })

  it('would have resolved to the WRONG value if back-solved against the stale mirror', () => {
    // Documents the bug this fix removes: heightParamValue(heights, 'top')
    // would have returned the stale mirror (100), not the live top (102).
    const heights = heightsWithStalePlane()
    const staleTop = heights.topHeight // 100 - what the OLD code read
    const liveStockTop = 102
    const typedFeedZ = 108

    const staleOffset = typedFeedZ - staleTop // what the old code would author
    const resolvedAgainstLive = liveStockTop /* top */ + staleOffset
    expect(resolvedAgainstLive).not.toBeCloseTo(typedFeedZ, 9)
  })

  it('acceptance 5: with no pending plane change, typed heights resolve exactly as today', () => {
    const heights = heightsWithStalePlane()
    // No pending change: the live resolver agrees with the mirror.
    const liveStockTop = heights.topHeight
    const typedFeedZ = 108

    const nextIntent = heightIntentAfterNumericEdit(
      heights, 'feed', typedFeedZ,
      reference => (reference === 'stock_top' ? liveStockTop : undefined),
    )
    const resolved = resolveHeightIntent(nextIntent, {
      wcsOriginZ: 0,
      referenceWcsZ: { stock_top: liveStockTop },
    })
    expect(resolved.wcs.feed).toBeCloseTo(typedFeedZ, 9)
  })

  it('falls back to an explicit WCS absolute when the live reference is unavailable', () => {
    const heights = heightsWithStalePlane()
    const nextIntent = heightIntentAfterNumericEdit(heights, 'feed', 42, () => undefined)
    expect(nextIntent.feed).toEqual({ reference: 'wcs_plane', offset: 42, provenance: 'user' })
  })
})

// WO-1390 / BUG-409: an untouched canonical default must stay distinguishable
// from a deliberate (setup or user) choice all the way through operation
// safety-plane authoring, so a policy that only rebinds a truly generic
// default (Parallel 3D's stock-top retract, which can legally have no stock)
// never overrides a deliberate setup-relative retract.
describe('operationSafetyHeightIntent preserves the default marker (BUG-409)', () => {
  function safetyIntent(retractProvenance: 'default' | 'inferred' | 'user'): HeightIntentV1 {
    return {
      version: 1,
      clearance: { reference: 'retract', offset: 10, provenance: 'default' },
      retract: { reference: 'stock_top', offset: 5, provenance: retractProvenance },
      feed: { reference: 'top', offset: 5, provenance: 'default' },
      top: { reference: 'stock_top', offset: 0, provenance: 'default' },
      bottom: { reference: 'top', offset: -5, provenance: 'default' },
    }
  }

  it('keeps an untouched default as default, not inferred', () => {
    const result = operationSafetyHeightIntent(safetyIntent('default'), new Set())
    expect(result.retract.provenance).toBe('default')
    expect(result.retract.reference).toBe('stock_top')
  })

  it('a deliberate (setup) choice is not relabelled as default', () => {
    const result = operationSafetyHeightIntent(safetyIntent('inferred'), new Set())
    expect(result.retract.provenance).toBe('inferred')
  })

  it('an operation-level user override still wins over default', () => {
    const overrides = new Set<OperationSafetyPlane>(['retract'])
    const result = operationSafetyHeightIntent(safetyIntent('default'), overrides)
    expect(result.retract.provenance).toBe('user')
  })

  // WO-1616: Parallel 3D authors every retract as written; the rebind to the
  // model Top happens only when no stock is proven, and never to a user override.
  it('Parallel 3D keeps the authored Stock top retract, default or deliberate', () => {
    for (const provenance of ['default', 'inferred'] as const) {
      const intent = buildParallel3dSmartIntent({
        setupId: 'setup-1', geometryIds: ['geo-1'],
        safetyIntent: operationSafetyHeightIntent(safetyIntent(provenance), new Set()),
      })
      expect(intent.safety.retract.reference).toBe('stock_top')
    }
    const user = buildParallel3dSmartIntent({
      setupId: 'setup-1', geometryIds: ['geo-1'],
      safetyIntent: operationSafetyHeightIntent(safetyIntent('default'), new Set(['retract'])),
    })
    expect(user.safety.retract).toMatchObject({ reference: 'stock_top', owner: { kind: 'user_override' } })
  })
})

import { describe, expect, it } from 'vitest'
import {
  selectStartingHeightPolicy,
  type LiveSmartHeightOperationType,
  type StartingHeightSelectionContext,
} from '../../lib/cam/newOperationHeightDefaults'
import { OPERATION_HEIGHT_POLICIES } from '../../lib/cam/smartHeights/policies'

describe('new operation Smart Height V2 starting policy', () => {
  const cases: Array<{
    operationType: LiveSmartHeightOperationType
    context: StartingHeightSelectionContext
    variant: string
    ready: boolean
  }> = [
    {
      operationType: 'face',
      context: { hasSetupStock: true, hasSelectedGeometry: true, hasSelectedFeature: true },
      variant: 'target_face', ready: true,
    },
    {
      operationType: 'contour_2d',
      context: { hasSetupStock: true, hasSelectedGeometry: true, hasSelectedFeature: true },
      variant: 'selected_feature', ready: true,
    },
    {
      operationType: 'pocket_2d',
      context: { hasSetupStock: true, boundarySource: 'stock', hasTargetSurface: true },
      variant: 'stock_rough', ready: true,
    },
    {
      operationType: 'adaptive_clearing_2d',
      context: { hasSetupStock: true, boundarySource: 'geometry', hasSelectedGeometry: true },
      variant: 'geometry_floor', ready: true,
    },
    {
      operationType: 'drill',
      context: { hasSetupStock: true, hasSelectedGeometry: true, hasSelectedFeature: true },
      variant: 'detected_features', ready: true,
    },
    {
      operationType: 'bore',
      context: { hasSetupStock: true, hasSelectedGeometry: true, explicitEndConfirmed: true },
      variant: 'explicit_depth', ready: true,
    },
    {
      operationType: 'thread_mill',
      context: {
        hasSetupStock: true,
        hasSelectedGeometry: true,
        hasSelectedFeature: true,
        threadKind: 'external',
        externalThreadReference: 'base',
      },
      variant: 'external_base', ready: true,
    },
    {
      operationType: 'engrave',
      context: { hasSetupStock: true, hasSelectedGeometry: true, useWidthForDepth: true },
      variant: 'width_derived', ready: true,
    },
    {
      operationType: 'chamfer',
      context: { hasSetupStock: true, hasSelectedGeometry: true, hasSelectedFeature: true },
      variant: 'edge_width_formula', ready: true,
    },
    {
      operationType: 'pattern',
      context: { hasSetupStock: true, explicitEndConfirmed: true },
      variant: 'explicit_depth', ready: true,
    },
    {
      operationType: 'vcarve',
      context: { hasSetupStock: true, hasSelectedGeometry: true, hasFlatDepth: true },
      variant: 'flat_depth', ready: true,
    },
    {
      operationType: 'parallel_3d',
      context: {
        hasSetupStock: true,
        hasSelectedGeometry: true,
        hasTargetSurface: true,
        finishDepthMm: 4,
      },
      variant: 'bounded_surface', ready: true,
    },
    {
      operationType: 'steep_shallow_3d',
      context: {
        hasSetupStock: true,
        hasSelectedGeometry: true,
        hasTargetSurface: true,
        finishDepthMm: 4,
      },
      variant: 'bounded_surface', ready: true,
    },
    {
      operationType: 'scallop_3d',
      context: {
        hasSetupStock: true,
        hasSelectedGeometry: true,
        hasTargetSurface: true,
        finishDepthMm: 4,
      },
      variant: 'bounded_surface', ready: true,
    },
    {
      operationType: 'pencil_3d',
      context: {
        hasSetupStock: true,
        hasSelectedGeometry: true,
        hasTargetSurface: true,
        finishDepthMm: 4,
      },
      variant: 'bounded_surface', ready: true,
    },
    {
      operationType: 'waterline_3d',
      context: { hasSetupStock: true, hasSelectedGeometry: true, hasTargetSurface: true },
      variant: 'target_surface', ready: true,
    },
    {
      operationType: 'adaptive_3d',
      context: {
        hasSetupStock: true,
        hasSelectedGeometry: true,
        hasTargetSurface: true,
        hasRemainingMaterial: true,
      },
      variant: 'current_material', ready: true,
    },
  ]

  it('covers every live family in the compliance registry exactly once', () => {
    const registeredLive = Object.values(OPERATION_HEIGHT_POLICIES)
      .filter(policy => policy.support === 'live')
      .map(policy => policy.operationType)
      .sort()
    expect(cases.map(testCase => testCase.operationType).sort()).toEqual(registeredLive)
  })

  it.each(cases)('$operationType selects $variant from available context', testCase => {
    const selected = selectStartingHeightPolicy(testCase.operationType, testCase.context)
    expect(selected.variant).toBe(testCase.variant)
    expect(selected.ready).toBe(testCase.ready)
    expect(
      Object.prototype.hasOwnProperty.call(
        OPERATION_HEIGHT_POLICIES[testCase.operationType].variants,
        selected.variant,
      ),
    ).toBe(true)
  })

  it('uses explicit policies instead of inventing evidence when context is empty', () => {
    const empty: StartingHeightSelectionContext = { hasSetupStock: false }
    expect(selectStartingHeightPolicy('face', empty)).toMatchObject({ variant: 'explicit_depth', ready: false })
    expect(selectStartingHeightPolicy('contour_2d', empty)).toMatchObject({ variant: 'explicit_depth', ready: false })
    expect(selectStartingHeightPolicy('drill', empty)).toMatchObject({ variant: 'explicit_depth', ready: false })
    expect(selectStartingHeightPolicy('bore', empty)).toMatchObject({ variant: 'explicit_depth', ready: false })
    expect(selectStartingHeightPolicy('thread_mill', empty)).toMatchObject({ variant: 'internal_explicit', ready: false })
  })

  it('does not automatically require rest machining merely because remaining material exists', () => {
    expect(selectStartingHeightPolicy('adaptive_3d', {
      hasSetupStock: true,
      hasSelectedGeometry: true,
      hasTargetSurface: true,
      hasRemainingMaterial: true,
    })).toMatchObject({ variant: 'current_material', basis: 'remaining_material', ready: true })
  })
})

import { describe, expect, it } from 'vitest'
import type { Operation, OperationType } from '../../types'
import {
  OPERATION_HEIGHT_POLICIES,
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  SmartHeightPersistenceError,
} from '../../lib/cam/smartHeights'
import { useCamStore } from '../../store'

type LiveType = Extract<OperationType,
  | 'adaptive_3d'
  | 'parallel_3d'
  | 'steep_shallow_3d'
  | 'face'
  | 'pocket_2d'
  | 'adaptive_clearing_2d'
  | 'contour_2d'
  | 'drill'
  | 'bore'
  | 'thread_mill'
  | 'chamfer'
  | 'engrave'
  | 'vcarve'
  | 'waterline_3d'
  | 'scallop_3d'
  | 'pencil_3d'
>

const liveCases: ReadonlyArray<{ type: LiveType; variant: string }> = [
  { type: 'adaptive_3d', variant: 'current_material' },
  { type: 'parallel_3d', variant: 'bounded_surface' },
  { type: 'steep_shallow_3d', variant: 'bounded_surface' },
  { type: 'waterline_3d', variant: 'target_surface' },
  { type: 'scallop_3d', variant: 'bounded_surface' },
  { type: 'pencil_3d', variant: 'bounded_surface' },
  { type: 'vcarve', variant: 'flat_depth' },
  { type: 'face', variant: 'explicit_depth' },
  { type: 'pocket_2d', variant: 'explicit_depth' },
  { type: 'adaptive_clearing_2d', variant: 'explicit_depth' },
  { type: 'contour_2d', variant: 'explicit_depth' },
  { type: 'drill', variant: 'explicit_depth' },
  { type: 'bore', variant: 'explicit_depth' },
  { type: 'thread_mill', variant: 'internal_explicit' },
  { type: 'chamfer', variant: 'edge_width_formula' },
  { type: 'engrave', variant: 'explicit_depth' },
]

function operation(type: LiveType, variant: string, withAuthority = true): Operation {
  const owner = { kind: 'operation_policy' as const }
  return {
    id: `exact-preview-${type}`,
    name: `Exact preview ${type}`,
    type,
    enabled: true,
    status: 'pending',
    toolId: 'tool-1',
    geometrySelections: ['geo-1'],
    heights: {
      clearanceHeight: 15,
      clearanceHeightMode: 'absolute',
      retractHeight: 10,
      feedHeight: 7,
      topHeight: 5,
      topHeightMode: 'absolute',
      bottomHeight: -3,
      bottomHeightMode: 'absolute',
    },
    ...(withAuthority ? {
      smartHeight: {
        kind: 'smart_v2' as const,
        intent: {
          version: SMART_HEIGHT_INTENT_VERSION,
          policyVersion: SMART_HEIGHT_POLICY_VERSION,
          policy: { operationType: type, variant },
          safety: {
            clearance: { reference: 'wcs_plane' as const, offsetMm: 15, owner },
            retract: { reference: 'wcs_plane' as const, offsetMm: 10, owner },
            feed: { reference: 'wcs_plane' as const, offsetMm: 7, owner },
          },
          machining: {
            start: { value: { kind: 'policy_default' as const }, owner },
            end: { value: { kind: 'policy_default' as const }, owner },
            scope: {
              value: { kind: 'selected_geometry' as const, geometryIds: ['geo-1'] },
              owner,
            },
          },
        },
      },
    } : {}),
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge',
      leadInRadius: 0,
      leadOutRadius: 0,
      rampAngle: 2,
      rampLength: 5,
      retractType: 'full',
      transitionType: 'safe_height',
    },
    params: {},
  }
}

describe('Smart Height exact V2 preview dispatch', () => {
  it('covers every live operation family exactly once', () => {
    const registeredLive = Object.values(OPERATION_HEIGHT_POLICIES)
      .filter(policy => policy.support === 'live')
      .map(policy => policy.operationType)
      .sort()
    expect(liveCases.map(testCase => testCase.type).sort()).toEqual(registeredLive)
  })

  it.each(liveCases)('$type enters its exact V2 plan branch', async ({ type, variant }) => {
    const result = await useCamStore.getState()
      .previewOperationSmartHeightPlan('__missing_exact_preview_setup__', operation(type, variant))
      .then(plan => ({ plan }), error => ({ error }))

    expect(result).toHaveProperty('error')
    if (!('error' in result)) return
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error).not.toBeInstanceOf(SmartHeightPersistenceError)
    expect((result.error as Error).message).not.toContain('Smart Height is not supported')
  })

  const snapshotCases: ReadonlyArray<{
    type: LiveType
    variant: string
    invoke: (op: Operation) => unknown
  }> = [
    { type: 'adaptive_3d', variant: 'current_material', invoke: op => useCamStore.getState().previewAdaptive3dSmartHeights('setup', op) },
    { type: 'parallel_3d', variant: 'bounded_surface', invoke: op => useCamStore.getState().previewParallel3dSmartHeights('setup', op) },
    { type: 'waterline_3d', variant: 'target_surface', invoke: op => useCamStore.getState().previewWaterline3dSmartHeights('setup', op) },
    { type: 'face', variant: 'explicit_depth', invoke: op => useCamStore.getState().previewFaceSmartHeights('setup', op) },
    { type: 'pocket_2d', variant: 'explicit_depth', invoke: op => useCamStore.getState().previewPlanarRoughSmartHeights('setup', op) },
    { type: 'adaptive_clearing_2d', variant: 'explicit_depth', invoke: op => useCamStore.getState().previewPlanarRoughSmartHeights('setup', op) },
    { type: 'contour_2d', variant: 'explicit_depth', invoke: op => useCamStore.getState().previewContourSmartHeights('setup', op) },
    { type: 'drill', variant: 'explicit_depth', invoke: op => useCamStore.getState().previewDrillBoreSmartHeights('setup', op) },
    { type: 'bore', variant: 'explicit_depth', invoke: op => useCamStore.getState().previewDrillBoreSmartHeights('setup', op) },
    { type: 'thread_mill', variant: 'internal_explicit', invoke: op => useCamStore.getState().previewThreadMillSmartHeights('setup', op) },
    { type: 'chamfer', variant: 'edge_width_formula', invoke: op => useCamStore.getState().previewChamferSmartHeights('setup', op) },
    { type: 'engrave', variant: 'explicit_depth', invoke: op => useCamStore.getState().previewEngraveSmartHeights('setup', op) },
  ]

  it.each(snapshotCases)(
    '$type snapshot preview rejects missing V2 authority synchronously',
    ({ type, variant, invoke }) => {
      expect(() => invoke(operation(type, variant, false))).toThrowError(
        expect.objectContaining({ code: 'missing_live_authority' }),
      )
    },
  )

  it('keeps the exact plan API asynchronous while preserving the same authority refusal', async () => {
    const invalid = operation('face', 'explicit_depth', false)
    let request: Promise<unknown> | undefined
    expect(() => {
      request = useCamStore.getState().previewOperationSmartHeightPlan('setup', invalid)
    }).not.toThrow()
    await expect(request).rejects.toMatchObject({ code: 'missing_live_authority' })
  })
})

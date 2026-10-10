import { describe, expect, it } from 'vitest'
import type { HeightParams, Operation, Setup } from '../../types'
import type { OperationHeightIntentV2 } from '../../lib/cam/smartHeights'
import {
  applyRecipeToSetup,
  createMachiningRecipe,
  deserializeRecipe,
  serializeRecipe,
} from '../../lib/recipes'

const heights: HeightParams = {
  clearanceHeight: 999,
  clearanceHeightMode: 'absolute',
  retractHeight: 998,
  feedHeight: 997,
  topHeight: 996,
  topHeightMode: 'absolute',
  bottomHeight: 995,
  bottomHeightMode: 'absolute',
}

function faceIntent(operationType: 'face' | 'contour_2d' = 'face'): OperationHeightIntentV2 {
  const setupOwner = { kind: 'setup' as const, setupId: 'source-setup' }
  const policyOwner = { kind: 'operation_policy' as const }
  return {
    version: 2,
    policyVersion: 1,
    policy: operationType === 'face'
      ? { operationType: 'face', variant: 'target_face' }
      : { operationType: 'contour_2d', variant: 'explicit_depth' },
    safety: {
      clearance: { reference: 'retract', offsetMm: 10, owner: setupOwner },
      retract: { reference: 'stock_top', offsetMm: 5, owner: setupOwner },
      feed: { reference: 'top', offsetMm: 2, owner: setupOwner },
    },
    machining: {
      start: { value: { kind: 'policy_default' }, owner: policyOwner },
      end: { value: { kind: 'policy_default' }, owner: policyOwner },
      scope: {
        value: { kind: 'selected_geometry', geometryIds: ['source-part'] },
        owner: setupOwner,
      },
    },
  }
}

function operation(smartHeight?: Operation['smartHeight']): Operation {
  return {
    id: 'source-op',
    name: 'Face stock',
    type: 'face',
    enabled: true,
    status: 'ready',
    toolId: '',
    geometrySelections: ['source-part'],
    heights: { ...heights },
    ...(smartHeight ? { smartHeight } : {}),
    passes: {
      stepdown: 1,
      stepover: 2,
      stockToLeave: 0,
      floorStockToLeave: 0,
      finishPasses: 0,
      springPasses: 0,
    },
    linking: {
      entryType: 'plunge',
      rampAngle: 0,
      rampLength: 0,
      leadInRadius: 0,
      leadOutRadius: 0,
      retractType: 'full',
      transitionType: 'safe_height',
    },
    params: { boundarySource: 'stock' },
  }
}

function targetSetup(): Setup {
  return {
    id: 'target-setup',
    name: 'Target setup',
    wcs: {
      id: 'target-wcs',
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: {
      type: 'rectangular',
      width: 100,
      height: 80,
      depth: 12,
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [],
    notes: '',
  }
}

describe('machining recipes preserve Smart Height V2 authority', () => {
  it('round-trips V2 intent, removes source geometry identity, and rebinds setup owners', () => {
    const sourceIntent = faceIntent()
    const source = operation({ kind: 'smart_v2', intent: sourceIntent })
    const recipe = deserializeRecipe(serializeRecipe(
      createMachiningRecipe('V2 face recipe', [source], []),
    ))

    expect(recipe.version).toBe(2)
    expect(recipe.operations[0].heightAuthority).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'face', variant: 'target_face' },
        machining: { scope: { value: { kind: 'selected_geometry', geometryIds: [] } } },
      },
    })

    const result = applyRecipeToSetup(recipe, targetSetup(), [], () => 'applied-op')
    expect(result.repairRequired).toEqual([])
    expect(result.addedOperations[0]).toMatchObject({
      id: 'applied-op',
      status: 'pending',
      geometrySelections: [],
      smartHeight: {
        kind: 'smart_v2',
        intent: {
          policy: { operationType: 'face', variant: 'target_face' },
          safety: {
            clearance: { owner: { kind: 'setup', setupId: 'target-setup' } },
            retract: { owner: { kind: 'setup', setupId: 'target-setup' } },
          },
          machining: {
            scope: {
              owner: { kind: 'setup', setupId: 'target-setup' },
              value: { kind: 'selected_geometry', geometryIds: [] },
            },
          },
        },
      },
    })
    expect(sourceIntent.machining.scope.value).toEqual({
      kind: 'selected_geometry',
      geometryIds: ['source-part'],
    })
  })

  it('marks missing and operation-mismatched authority for explicit repair', () => {
    const missingRecipe = createMachiningRecipe('Missing authority', [operation()], [])
    expect(missingRecipe.operations[0].heightAuthority).toMatchObject({
      kind: 'repair_required',
      reason: 'missing_v2_authority',
    })

    const mismatched = operation({ kind: 'smart_v2', intent: faceIntent('contour_2d') })
    const mismatchedRecipe = createMachiningRecipe('Wrong authority', [mismatched], [])
    expect(mismatchedRecipe.operations[0].heightAuthority).toMatchObject({
      kind: 'repair_required',
      reason: 'operation_type_mismatch',
    })

    const invalid = operation({
      kind: 'smart_v2',
      intent: { ...faceIntent(), version: 99 },
    })
    expect(createMachiningRecipe('Invalid authority', [invalid], []).operations[0].heightAuthority)
      .toMatchObject({ kind: 'repair_required', reason: 'invalid_v2_authority' })

    const result = applyRecipeToSetup(missingRecipe, targetSetup(), [], () => 'repair-op')
    expect(result.repairRequired).toEqual([expect.objectContaining({
      operationName: 'Face stock',
      reason: 'missing_v2_authority',
    })])
    expect(result.addedOperations[0]).toMatchObject({
      id: 'repair-op',
      status: 'error',
      errorMessage: expect.stringContaining('no valid Smart Height V2 setup'),
    })
    expect(result.addedOperations[0].smartHeight).toBeUndefined()
  })

  it('does not let poisoned scalar mirrors replace restored V2 intent', () => {
    const recipe = createMachiningRecipe(
      'Poisoned mirrors',
      [operation({ kind: 'smart_v2', intent: faceIntent() })],
      [],
    )
    recipe.operations[0].heights = {
      ...recipe.operations[0].heights,
      clearanceHeight: -5000,
      bottomHeight: 5000,
    }

    const result = applyRecipeToSetup(recipe, targetSetup(), [], () => 'safe-op')
    const restored = result.addedOperations[0].smartHeight
    expect(restored?.kind).toBe('smart_v2')
    expect((restored?.intent as OperationHeightIntentV2).safety.clearance.offsetMm).toBe(10)
    expect((restored?.intent as OperationHeightIntentV2).machining.end.value)
      .toEqual({ kind: 'policy_default' })
  })
})

import { describe, expect, it } from 'vitest'
import type { HeightParams, Operation, Tool } from '../../types'
import {
  createMachiningRecipe,
  deserializeRecipe,
  serializeRecipe,
  type MachiningRecipeOperation,
} from '../../lib/recipes'

const heights: HeightParams = {
  clearanceHeight: 15,
  clearanceHeightMode: 'absolute',
  retractHeight: 10,
  feedHeight: 2,
  topHeight: 0,
  topHeightMode: 'stock_top',
  bottomHeight: -8,
  bottomHeightMode: 'absolute',
}

function tool(id: string, name: string, diameter: number): Tool {
  return {
    id,
    name,
    type: 'flat_end_mill',
    diameter,
    fluteLength: 25,
    shankDiameter: diameter,
    overallLength: 60,
    numberOfFlutes: 3,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {
      default: {
        rpm: 18000,
        feedRate: 1600,
        plungeRate: 300,
        depthOfCut: 2,
        stepover: 1.2,
        coolant: 'mist',
      },
    },
  }
}

function operation(id: string, name: string, toolId: string, depth: number): Operation {
  return {
    id,
    name,
    type: 'adaptive_clearing_2d',
    enabled: true,
    status: 'ready',
    toolId,
    geometrySelections: [`source-face-${id}`],
    modelReferences: [{ bodyId: `source-body-${id}`, stableIds: [`face-${id}`], role: 'machining-boundary' }],
    heights: { ...heights, bottomHeight: -depth },
    passes: {
      stepdown: 2,
      stepover: 1.2,
      stockToLeave: 0.2,
      finishPasses: 1,
      springPasses: 0,
    },
    linking: {
      entryType: 'ramp_helical',
      rampAngle: 3,
      rampLength: 10,
      leadInRadius: 1,
      leadOutRadius: 1,
      retractType: 'partial',
      transitionType: 'avoid_stock',
    },
    feedrateOverride: {
      enabled: true,
      rpm: 18000,
      feedRate: 1600,
      plungeRate: 300,
      rampFeedrate: 650,
      leadInFeedrate: 800,
      leadOutFeedrate: 850,
      fastTraverseFeedrate: 2500,
      finishFeedrate: 1000,
    },
    params: {
      geometryId: `source-geometry-${id}`,
      loopIds: [`source-loop-${id}`],
      boundarySource: 'geometry',
      climb: true,
      rampAngle: 3,
      tolerance: 0.02,
      wallFinish: true,
    },
    toolpathMoves: [{ x: 1, y: 2, z: -depth, type: 'feed' }],
    computeTimeMs: 42,
  }
}

describe('WO-238 machining recipe model', () => {
  it('round-trips selected operation order, exact tools, and machining settings', () => {
    const tools = [tool('tool-6', '6 mm rougher', 6), tool('tool-4', '4 mm finisher', 4)]
    const selected = [
      operation('op-rough', 'Rough pockets', 'tool-6', 8),
      operation('op-finish', 'Finish walls', 'tool-4', 8.2),
    ]

    const recipe = createMachiningRecipe('Fixture plate operations', selected, tools)
    const restored = deserializeRecipe(serializeRecipe(recipe))

    expect(restored.operations.map((candidate) => candidate.name)).toEqual([
      'Rough pockets',
      'Finish walls',
    ])
    expect(restored.operations.map((candidate) => candidate.tool)).toEqual(tools)
    expect(restored.operations[0]).toMatchObject({
      heights: selected[0].heights,
      passes: selected[0].passes,
      linking: selected[0].linking,
      feedrateOverride: selected[0].feedrateOverride,
      params: {
        boundarySource: 'geometry',
        climb: true,
        rampAngle: 3,
        tolerance: 0.02,
        wallFinish: true,
      },
    })
    expect(serializeRecipe(restored)).toBe(serializeRecipe(recipe))
  })

  it('serializes only allow-listed operation fields', () => {
    const recipe = createMachiningRecipe(
      'Identity-free template',
      [operation('op-source', 'Source operation', 'tool-6', 8)],
      [tool('tool-6', '6 mm rougher', 6)],
    )
    const contaminatedOperation: MachiningRecipeOperation & Record<string, unknown> = {
      ...recipe.operations[0],
      stock: { width: 100, height: 60, depth: 12 },
      wcs: { label: 'G55' },
      fixtureOffset: 55,
      modelId: 'source-model',
      geometrySelections: ['source-face'],
      futureOperationIdentity: 'must-not-travel',
      params: {
        ...recipe.operations[0].params,
        geometryId: 'nested-source-geometry',
        loopIds: ['nested-source-loop'],
        fixtureOffset: 55,
        futureParam: 'must-not-travel',
      },
      tool: {
        ...recipe.operations[0].tool!,
        modelId: 'nested-tool-model',
      } as Tool,
      heights: {
        ...recipe.operations[0].heights,
        futureHeightIdentity: 'must-not-travel',
      } as HeightParams,
    }

    const parsed = JSON.parse(serializeRecipe({
      ...recipe,
      operations: [contaminatedOperation],
    })) as { operations: Array<Record<string, unknown>> }

    expect(parsed.operations[0]).not.toHaveProperty('stock')
    expect(parsed.operations[0]).not.toHaveProperty('wcs')
    expect(parsed.operations[0]).not.toHaveProperty('fixtureOffset')
    expect(parsed.operations[0]).not.toHaveProperty('modelId')
    expect(parsed.operations[0]).not.toHaveProperty('geometrySelections')
    expect(parsed.operations[0]).not.toHaveProperty('futureOperationIdentity')
    expect(parsed.operations[0].params).not.toHaveProperty('geometryId')
    expect(parsed.operations[0].params).not.toHaveProperty('loopIds')
    expect(parsed.operations[0].params).not.toHaveProperty('fixtureOffset')
    expect(parsed.operations[0].params).not.toHaveProperty('futureParam')
    expect(parsed.operations[0].tool).not.toHaveProperty('modelId')
    expect(parsed.operations[0].heights).not.toHaveProperty('futureHeightIdentity')
  })
})

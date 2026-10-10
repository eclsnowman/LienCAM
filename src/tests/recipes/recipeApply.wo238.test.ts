import { describe, expect, it } from 'vitest'
import type { HeightParams, Operation, Setup, Tool } from '../../types'
import { applyRecipeToSetup, createMachiningRecipe } from '../../lib/recipes'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

const heights: HeightParams = {
  clearanceHeight: 12,
  clearanceHeightMode: 'absolute',
  retractHeight: 8,
  feedHeight: 2,
  topHeight: 0,
  topHeightMode: 'stock_top',
  bottomHeight: -6,
  bottomHeightMode: 'absolute',
}

function tool(id: string, name: string, type: Tool['type'], diameter: number): Tool {
  return {
    id,
    name,
    type,
    diameter,
    fluteLength: 30,
    shankDiameter: diameter,
    overallLength: 65,
    numberOfFlutes: type === 'drill' ? 2 : 3,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {
      default: {
        rpm: 16000,
        feedRate: 1200,
        plungeRate: 250,
        depthOfCut: 2,
        stepover: Math.max(0.5, diameter * 0.25),
        coolant: 'mist',
      },
    },
  }
}

function operation(
  id: string,
  name: string,
  type: Operation['type'],
  toolId: string,
  setting: number,
): Operation {
  const opHeights = { ...heights, bottomHeight: -setting }
  const opParams = type === 'drill'
    ? {
        geometryId: `source-geometry-${id}`,
        loopIds: [`source-loop-${id}`],
        cycleType: 'peck',
        peckDepth: setting,
        chipBreakRetract: 0.5,
        dwell: 0.2,
        retractMode: 'retract',
        sortStrategy: 'nearest_neighbor',
      }
    : {
        geometryId: `source-geometry-${id}`,
        loopIds: [`source-loop-${id}`],
        boundarySource: 'geometry',
        direction: 'climb',
        planeOffset: setting,
        tolerance: 0.02,
      }
  return {
    id,
    name,
    type,
    enabled: true,
    status: 'ready',
    toolId,
    geometrySelections: [`geometry-${id}`],
    heights: opHeights,
    // Stamped for Smart Height V2 (commit 2e5678b7): createMachiningRecipe
    // captures the SOURCE operation's smartHeight as the recipe's
    // heightAuthority (recipeModel.ts's projectHeightAuthority); with none
    // present, applyRecipeToSetup's restoreHeightAuthority treats it as
    // missing_v2_authority and lands every applied operation at status
    // 'error' instead of 'pending'.
    smartHeight: smartHeightAuthorityFixture(type, {
      setupId: 'source-setup', heights: opHeights, params: opParams,
      geometryIds: [`source-geometry-${id}`],
    }),
    passes: {
      stepdown: setting,
      stepover: setting / 2,
      stockToLeave: setting / 10,
      finishPasses: 1,
      springPasses: 0,
    },
    linking: {
      entryType: type === 'drill' ? 'plunge' : 'ramp_helical',
      rampAngle: 3,
      rampLength: 10,
      leadInRadius: setting,
      leadOutRadius: setting,
      retractType: 'partial',
      transitionType: 'avoid_stock',
    },
    feedrateOverride: {
      enabled: true,
      rpm: 16000 + setting,
      feedRate: 1200 + setting,
      plungeRate: 250 + setting,
      rampFeedrate: 500 + setting,
      leadInFeedrate: 600 + setting,
      leadOutFeedrate: 650 + setting,
      fastTraverseFeedrate: 2400 + setting,
    },
    params: opParams,
    toolpathMoves: [{ x: 0, y: 0, z: -setting, type: 'feed' }],
  }
}

function setup(operations: Operation[] = []): Setup {
  return {
    id: 'target-setup',
    name: 'Target setup',
    wcs: {
      id: 'target-wcs',
      label: 'G55',
      fixtureOffset: 55,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: {
      type: 'rectangular',
      width: 120,
      height: 80,
      depth: 15,
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: '6061 aluminum',
    },
    operations,
    notes: '',
  }
}

function sequentialIds(): () => string {
  let nextId = 0
  return () => `applied-op-${++nextId}`
}

describe('WO-238 machining recipe apply rules', () => {
  it('inserts a genuine three-operation template in order with empty geometry', () => {
    const tools = [
      tool('tool-face', '12 mm face mill', 'face_mill', 12),
      tool('tool-rough', '6 mm rougher', 'flat_end_mill', 6),
      tool('tool-drill', '5 mm drill', 'drill', 5),
    ]
    const sourceOperations = [
      operation('source-face', 'Face stock', 'face', 'tool-face', 0.5),
      operation('source-rough', 'Rough pockets', 'adaptive_clearing_2d', 'tool-rough', 2),
      operation('source-drill', 'Drill bolt holes', 'drill', 'tool-drill', 3),
    ]
    const existingOperation = operation(
      'target-existing',
      'Existing target operation',
      'face',
      'tool-face',
      0.25,
    )
    const targetSetup = setup([existingOperation])
    const recipe = createMachiningRecipe('Fixture plate', sourceOperations, tools)

    const result = applyRecipeToSetup(recipe, targetSetup, tools, sequentialIds())

    expect(result.addedOperations.map((candidate) => candidate.name)).toEqual([
      'Face stock',
      'Rough pockets',
      'Drill bolt holes',
    ])
    expect(result.setup.operations).toEqual([existingOperation, ...result.addedOperations])
    expect(result.addedOperations.map((candidate) => candidate.toolId)).toEqual([
      'tool-face',
      'tool-rough',
      'tool-drill',
    ])
    result.addedOperations.forEach((applied, index) => {
      expect(applied.id).toBe(`applied-op-${index + 1}`)
      expect(applied.status).toBe('pending')
      expect(applied.geometrySelections).toEqual([])
      expect(applied.heights).toEqual(sourceOperations[index].heights)
      expect(applied.passes).toEqual(sourceOperations[index].passes)
      expect(applied.linking).toEqual(sourceOperations[index].linking)
      expect(applied.feedrateOverride).toEqual(sourceOperations[index].feedrateOverride)
      expect(applied.params).toEqual(recipe.operations[index].params)
      expect(applied.params).not.toHaveProperty('geometryId')
      expect(applied.params).not.toHaveProperty('loopIds')
      expect(applied).not.toHaveProperty('toolpathMoves')
      expect(applied).not.toHaveProperty('modelReferences')
    })
    expect(result.missingTools).toEqual([])
    expect(targetSetup.operations).toEqual([existingOperation])
  })

  it('applies a missing-tool operation unset and names the exact missing tool', () => {
    const expectedDrill = tool('tool-drill', '5 mm carbide drill', 'drill', 5)
    const recipe = createMachiningRecipe(
      'Drilling cycle',
      [operation('source-drill', 'Drill bolt holes', 'drill', expectedDrill.id, 3)],
      [expectedDrill],
    )
    const similarButDifferentTool = tool('tool-drill-substitute', '5 mm carbide drill', 'drill', 5)

    const result = applyRecipeToSetup(
      recipe,
      setup(),
      [similarButDifferentTool],
      sequentialIds(),
    )

    expect(result.addedOperations).toHaveLength(1)
    expect(result.addedOperations[0]).toMatchObject({
      name: 'Drill bolt holes',
      toolId: '',
      geometrySelections: [],
      status: 'pending',
    })
    expect(result.missingTools).toEqual([{
      operationName: 'Drill bolt holes',
      toolId: 'tool-drill',
      toolName: '5 mm carbide drill',
    }])
  })
})

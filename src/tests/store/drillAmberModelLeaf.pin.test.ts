// DRILL-AMBER-AFTER-MODEL-EDIT-PIN (S23 lane flag 2026-07-25, MODEL-ROW-CITIZEN
// batch 1): a drill op bound to a specific pre-edit body LEAF (a face/edge
// stableId, role 'drill-targets') must show amber after the model is edited.
//
// The COARSE body-touch amber (markDrillTargetOpsOutdated on syncModelBodies /
// updateModelItemPlacement) is already pinned by camDrillAdapter.rederive.test.ts.
// This file pins the complementary LEAF-LEVEL contract: the SAME async
// re-resolution authority (store.reresolveModelReferences ->
// modelReferenceResolution) that a real workbench regen fires must amber a DRILL
// op exactly like it ambers a contour op, so the "drill notices its referenced
// leaf moved / vanished" contract cannot silently change. modelReferenceReresolve
// .test.ts only exercises this path for a contour_2d op; drill (role
// 'drill-targets') is the op the S23 lane flagged, so it gets its own pin.
//
// MUTATION proof: flip applyVerdictToOp's drill handling (e.g. make the
// 'ready'->outdated stale-fallback / stale-changed arms return the op unchanged,
// or make classifyOperation ignore role 'drill-targets') -> the amber assertions
// below go RED. The op-type is 'drill' throughout; nothing here is contour.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type {
  Operation, Setup, WCS, HeightParams, PassParams, LinkingParams, ToolpathMove,
} from '../../types'
import type { ModelReference } from '../../lib/cam/types'
import type { BodyResolution, RawResolution } from '../../lib/cam/modelReferenceResolution'

const heights: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 2,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -5, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const MOVE = { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' } as ToolpathMove

function makeWcs(): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
}

/** A drill op bound to a pre-edit body leaf via role 'drill-targets'. */
function drillOp(
  id: string,
  bodyId: string,
  leaf: string,
  status: Operation['status'] = 'ready',
): Operation {
  const refs: ModelReference[] = [{ bodyId, stableIds: [leaf], role: 'drill-targets' }]
  return {
    id, name: id, type: 'drill', enabled: true, status,
    toolId: 'tool-1', geometrySelections: [],
    modelReferences: refs,
    heights, passes, linking,
    params: {
      geometryId: 'geo-model', loopIds: [], cycleType: 'simple', peckDepth: 2,
      chipBreakRetract: 1, dwell: 0, retractMode: 'retract', sortStrategy: 'none',
    },
    toolpathMoves: [MOVE],
  } as Operation
}

function makeSetup(ops: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations: ops, notes: '',
  }
}
function body(bodyId: string, changed: boolean, resolutions: RawResolution[]): BodyResolution {
  return { bodyId, changed, resolutions }
}

const store = () => useCamStore.getState()
const opById = (id: string): Operation =>
  store().project.setups[0].operations.find((o) => o.id === id)!

function install(ops: Operation[]): void {
  useCamStore.setState((s) => ({
    lastModelReresolveSeq: 0,
    project: { ...s.project, geometry: [], setups: [makeSetup(ops)] },
  }))
}

describe('DRILL-AMBER leaf-level: a drill op ambers when its model leaf moves/vanishes', () => {
  beforeEach(() => {
    install([drillOp('op-drill', 'BODY-A', 'BODY-A:wall')])
  })

  it('leaf LOST after edit -> drill op degrades (amber), retains toolpath', () => {
    const changed = store().reresolveModelReferences([
      body('BODY-A', true, [{ id: 'BODY-A:wall', status: 'lost' }]),
    ])
    expect(changed).toEqual(['op-drill'])
    expect(opById('op-drill').status).toBe('degraded')
    expect(opById('op-drill').toolpathMoves).toEqual([MOVE]) // last-known kept
  })

  it('leaf re-bound APPROXIMATELY (fallback) after edit -> drill op outdated + named note', () => {
    const changed = store().reresolveModelReferences([
      body('BODY-A', true, [{ id: 'BODY-A:wall', status: 'fallback' }]),
    ])
    expect(changed).toEqual(['op-drill'])
    expect(opById('op-drill').status).toBe('outdated')
    expect(opById('op-drill').modelReferenceNote).toMatch(/moved/i)
  })

  it('body regenerated but leaf EXACT -> drill op still ambers (outdated), toolpath kept', () => {
    const changed = store().reresolveModelReferences([
      body('BODY-A', true, [{ id: 'BODY-A:wall', status: 'exact' }]),
    ])
    expect(changed).toEqual(['op-drill'])
    expect(opById('op-drill').status).toBe('outdated')
    expect(opById('op-drill').toolpathMoves).toEqual([MOVE])
  })

  it('nothing changed (leaf exact, body unchanged) -> drill op stays ready', () => {
    const changed = store().reresolveModelReferences([
      body('BODY-A', false, [{ id: 'BODY-A:wall', status: 'exact' }]),
    ])
    expect(changed).toEqual([])
    expect(opById('op-drill').status).toBe('ready')
  })
})

// WO-1372 (BUG-506 / BUG-479): updateTool, removeTool and removeModelItem all
// mutate state a 'ready' operation's generation fingerprint depends on
// (toolLibrary or project.geometry) without ever running the freshness
// reconcile that already exists for this exact purpose
// (reconcileProjectGenerationFreshness, src/lib/cam/generationFingerprint.ts).
// This drives the three real store actions and asserts the dependent
// operation goes stale, mirroring operationDependencyFreshness.wo1208.test.ts's
// own fixture shape for a legitimately 'ready' operation.

import { beforeEach, describe, expect, it } from 'vitest'

import { projectOperationFingerprint } from '../../lib/cam/generationFingerprint'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { useCamStore } from '../../store'
import type {
  ImportedGeometry,
  Operation,
  Project,
  ResolvedHeightSnapshotV1,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const SETUP_ID = 'setup-wo1372'

const TOOL: Tool = {
  id: 'tool-wo1372-a',
  name: 'WO-1372 cutter A',
  type: 'flat_end_mill',
  diameter: 6,
} as Tool

const OTHER_TOOL: Tool = {
  id: 'tool-wo1372-b',
  name: 'WO-1372 cutter B',
  type: 'flat_end_mill',
  diameter: 4,
} as Tool

const SNAPSHOT: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 10, retract: 8, feed: 6, top: 5, bottom: 0 },
  machine: { clearance: 10, retract: 8, feed: 6, top: 5, bottom: 0 },
  intent: defaultHeightIntent(),
  dependencyIds: [SETUP_ID, 'stock-wo1372', 'geo-wo1372', TOOL.id],
}

const MOVES: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
  { type: 'feed', x: 1, y: 1, z: 0, feed: 300, role: 'cut' },
]

function modelGeo(id: string, modelItemId: string): ImportedGeometry {
  return {
    id,
    name: id,
    filename: id,
    type: 'brep',
    format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    modelItemId,
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      display: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2], edgePositions: [], edgeOffsets: [0],
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    },
  } as ImportedGeometry
}

function makeOperation(id: string, toolId: string, geometrySelections: string[]): Operation {
  const operation: Operation = {
    id,
    name: id,
    type: 'face',
    enabled: true,
    status: 'ready',
    toolId,
    geometrySelections,
    heights: {
      clearanceHeight: 10,
      clearanceHeightMode: 'absolute',
      retractHeight: 8,
      feedHeight: 6,
      topHeight: 5,
      topHeightMode: 'absolute',
      bottomHeight: 0,
      bottomHeightMode: 'absolute',
      heightIntent: defaultHeightIntent(),
    },
    smartHeight: smartHeightAuthorityFixture('face'),
    resolvedHeights: SNAPSHOT,
    passes: {
      stepdown: 1,
      stepover: 1,
      stockToLeave: 0,
      finishPasses: 0,
      springPasses: 0,
    },
    linking: {
      entryType: 'plunge',
      rampAngle: 3,
      rampLength: 5,
      leadInRadius: 0,
      leadOutRadius: 0,
      retractType: 'full',
      transitionType: 'direct',
    },
    params: { depth: 1 },
    toolpathMoves: MOVES,
  } as Operation
  operation.resolvedHeightPlan = smartHeightPlanFixture(operation, SNAPSHOT)
  return operation
}

function readyProject(): Project {
  const setup: Setup = {
    id: SETUP_ID,
    name: 'WO-1372 setup',
    wcs: {
      id: 'wcs-wo1372',
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId: 'stock-wo1372',
    },
    stock: {
      type: 'rectangular',
      width: 20,
      height: 20,
      depth: 5,
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: 'aluminum',
    },
    operationFolders: [],
    operations: [
      makeOperation('op-tool', TOOL.id, ['geo-wo1372']),
      makeOperation('op-other-tool', OTHER_TOOL.id, ['geo-wo1372']),
      makeOperation('op-contour', TOOL.id, ['geo-model']),
    ],
    notes: '',
  }
  const project = {
    id: 'project-wo1372',
    name: 'WO-1372 project',
    version: '1',
    schemaVersion: 11,
    machine: { id: 'machine-wo1372', name: 'Machine', rapidRate: 1000 },
    geometry: [
      {
        id: 'geo-wo1372',
        name: 'Part',
        format: 'step',
        stockId: 'stock-wo1372',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        boundingBox: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 20, y: 20, z: 5 },
          size: { x: 20, y: 20, z: 5 },
          center: { x: 10, y: 10, z: 2.5 },
        },
      },
      modelGeo('geo-model', 'item-a'),
    ],
    modelItems: [{ id: 'item-a', name: 'Item A' }],
    setups: [setup],
    stocks: [{ id: 'stock-wo1372', name: 'Stock', mode: 'derived' }],
    sceneStock: {
      mode: 'auto',
      autoOffsetXY: 0,
      autoOffsetZTop: 0,
      fixedWidth: 20,
      fixedHeight: 20,
      fixedDepth: 5,
      fixedStocks: [],
    },
    toolLibrary: [],
  } as unknown as Project

  const resolveTool = (toolId: string): Tool | undefined =>
    [TOOL, OTHER_TOOL].find((t) => t.id === toolId)
  for (const operation of setup.operations) {
    operation.generationFingerprint = projectOperationFingerprint(
      project, setup, operation, SNAPSHOT, undefined, resolveTool,
    )
  }
  return project
}

function installProject(project: Project): void {
  useCamStore.setState((state) => ({
    project,
    toolLibrary: [TOOL, OTHER_TOOL],
    projectHistory: [],
    canUndo: false,
    activeModelItemId: null,
    viewer: { ...state.viewer, selectedFolderId: null },
  }))
}

function operationById(id: string): Operation {
  const operation = useCamStore.getState().project.setups[0].operations
    .find((candidate) => candidate.id === id)
  if (!operation) throw new Error(`Missing operation ${id}`)
  return operation
}

beforeEach(() => installProject(readyProject()))

describe('WO-1372: tool edits and model-item deletes stale dependent operations', () => {
  it('BUG-506: updateTool destales the operation on the edited cutter, leaves an unrelated tool\'s operation ready', () => {
    expect(operationById('op-tool').status).toBe('ready')
    expect(operationById('op-other-tool').status).toBe('ready')

    useCamStore.getState().updateTool(TOOL.id, { diameter: 12 })

    expect(operationById('op-tool').status).not.toBe('ready')
    expect(operationById('op-other-tool').status).toBe('ready')
  })

  it('BUG-506: removeTool destales the operation that resolved the deleted cutter', () => {
    expect(operationById('op-tool').status).toBe('ready')

    useCamStore.getState().removeTool(TOOL.id)

    expect(operationById('op-tool').status).not.toBe('ready')
    expect(operationById('op-other-tool').status).toBe('ready')
  })

  it('BUG-479: removeModelItem destales the Contour built on the deleted item', () => {
    expect(operationById('op-contour').status).toBe('ready')

    useCamStore.getState().removeModelItem('item-a')

    expect(operationById('op-contour').status).not.toBe('ready')
  })

  it('undo of the model-item delete restores the geometry but never resurrects a falsely-ready operation', () => {
    useCamStore.getState().removeModelItem('item-a')
    expect(operationById('op-contour').status).not.toBe('ready')

    useCamStore.getState().undo()

    // The deleted model item's geometry is back (undo is a real restore, not
    // a no-op) -- but pushHistory always strips toolpathMoves and downgrades
    // a 'ready' op to 'outdated' in the snapshot it stores, so this op was
    // ALREADY 'outdated' in the pre-delete snapshot undo restores. It must
    // never come back 'ready' against geometry nothing just recomputed
    // against -- that would be the exact "restored-but-regenerated" lie the
    // acceptance criterion rules out.
    const restoredProject = useCamStore.getState().project
    expect(restoredProject.geometry.some((g) => g.id === 'geo-model')).toBe(true)
    expect(restoredProject.modelItems?.some((item) => item.id === 'item-a')).toBe(true)
    expect(operationById('op-contour').status).not.toBe('ready')
  })
})

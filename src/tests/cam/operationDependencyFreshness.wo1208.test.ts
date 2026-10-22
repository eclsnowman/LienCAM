import { beforeEach, describe, expect, it } from 'vitest'

import {
  generationFingerprint,
  projectOperationFingerprint,
} from '../../lib/cam/generationFingerprint'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { useCamStore } from '../../store'
import type {
  Operation,
  Project,
  ResolvedHeightSnapshotV1,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

type DependencyOperation = Operation & {
  dependsOnPredecessors?: boolean
}

const SETUP_ID = 'setup-wo1208'
const TOOL = {
  id: 'tool-wo1208',
  name: 'WO-1208 cutter',
  type: 'flat_end_mill',
  diameter: 6,
} as Tool

const resolveTool = (toolId: string): Tool | undefined =>
  toolId === TOOL.id ? TOOL : undefined

const SNAPSHOT: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 10, retract: 8, feed: 6, top: 5, bottom: 0 },
  machine: { clearance: 10, retract: 8, feed: 6, top: 5, bottom: 0 },
  intent: defaultHeightIntent(),
  dependencyIds: [SETUP_ID, 'stock-wo1208', 'geo-wo1208', TOOL.id],
}

const MOVES: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
  { type: 'feed', x: 1, y: 1, z: 0, feed: 300, role: 'cut' },
]

function makeOperation(
  id: string,
  dependsOnPredecessors = false,
  folderId?: string,
): DependencyOperation {
  const operation: DependencyOperation = {
    id,
    name: id,
    type: 'face',
    enabled: true,
    folderId,
    status: 'ready',
    toolId: TOOL.id,
    geometrySelections: ['geo-wo1208'],
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
    params: { depth: id.length },
    toolpathMoves: MOVES,
    dependsOnPredecessors: dependsOnPredecessors || undefined,
  }
  operation.resolvedHeightPlan = smartHeightPlanFixture(operation, SNAPSHOT)
  return operation
}

function readyProject(dependent = true, folderedPredecessor = false): Project {
  const setup: Setup = {
    id: SETUP_ID,
    name: 'WO-1208 setup',
    wcs: {
      id: 'wcs-wo1208',
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId: 'stock-wo1208',
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
    operationFolders: folderedPredecessor
      ? [{ id: 'folder-roughing', name: 'Roughing', parentId: null }]
      : [],
    operations: [
      makeOperation('op-a', false, folderedPredecessor ? 'folder-roughing' : undefined),
      makeOperation('op-b'),
      makeOperation('op-dependent', dependent),
    ],
    notes: '',
  }
  const project = {
    id: 'project-wo1208',
    name: 'WO-1208 project',
    version: '1',
    schemaVersion: 11,
    machine: { id: 'machine-wo1208', name: 'Machine', rapidRate: 1000 },
    geometry: [{
      id: 'geo-wo1208',
      name: 'Part',
      format: 'step',
      stockId: 'stock-wo1208',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 20, y: 20, z: 5 },
        size: { x: 20, y: 20, z: 5 },
        center: { x: 10, y: 10, z: 2.5 },
      },
    }],
    setups: [setup],
    stocks: [{ id: 'stock-wo1208', name: 'Stock', mode: 'derived' }],
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

  for (const operation of setup.operations) {
    operation.generationFingerprint = projectOperationFingerprint(
      project, setup, operation, SNAPSHOT, TOOL, resolveTool,
    )
  }
  return project
}

function installProject(project: Project): void {
  useCamStore.setState((state) => ({
    project,
    toolLibrary: [TOOL],
    projectHistory: [],
    canUndo: false,
    viewer: { ...state.viewer, selectedFolderId: null },
  }))
}

function operationById(id: string): DependencyOperation {
  const operation = useCamStore.getState().project.setups[0].operations
    .find((candidate) => candidate.id === id)
  if (!operation) throw new Error(`Missing operation ${id}`)
  return operation as DependencyOperation
}

function restampReadyThroughStore(id: string): void {
  const project = useCamStore.getState().project
  const setup = project.setups.find((candidate) => candidate.id === SETUP_ID)!
  const existing = setup.operations.find((candidate) => candidate.id === id) as DependencyOperation
  const restored: DependencyOperation = {
    ...existing,
    status: 'ready',
    resolvedHeights: SNAPSHOT,
    toolpathMoves: MOVES,
    errorMessage: undefined,
  }
  restored.resolvedHeightPlan = smartHeightPlanFixture(restored, SNAPSHOT)
  const fingerprintSetup = {
    ...setup,
    operations: setup.operations.map((candidate) => candidate.id === id ? restored : candidate),
  }
  const fingerprintProject = {
    ...project,
    setups: project.setups.map((candidate) => candidate.id === SETUP_ID
      ? fingerprintSetup
      : candidate),
  }
  restored.generationFingerprint = projectOperationFingerprint(
    fingerprintProject, fingerprintSetup, restored, SNAPSHOT, TOOL, resolveTool,
  )
  // WO-2976 repin: the operation.update command refuses a patch that carries
  // `id` (src/kernel/camCommands.ts), so the restamp sends every field but it.
  const { id: _id, ...patch } = restored
  void _id
  useCamStore.getState().updateOperation(SETUP_ID, id, patch)
}

beforeEach(() => installProject(readyProject()))

describe('WO-1208 operation dependency freshness', () => {
  it('keeps a live dependent toolpath ready when a non-input progress field updates', () => {
    const before = operationById('op-dependent')

    useCamStore.getState().updateOperation(SETUP_ID, 'op-a', { progress: 0.5 })

    expect(operationById('op-dependent')).toMatchObject({
      status: 'ready',
      generationFingerprint: before.generationFingerprint,
      toolpathMoves: MOVES,
    })
  })

  it('marks a dependent operation stale when an earlier enabled operation moves past it', () => {
    useCamStore.getState().reorderOperations(SETUP_ID, 0, 2)

    expect(operationById('op-dependent')).toMatchObject({
      status: 'outdated',
      generationFingerprint: undefined,
      toolpathMoves: undefined,
    })
  })

  it('marks a dependent operation stale when a predecessor is suppressed and again when re-enabled', () => {
    useCamStore.getState().updateOperation(SETUP_ID, 'op-a', { enabled: false })
    expect(operationById('op-dependent').status).toBe('outdated')

    restampReadyThroughStore('op-dependent')
    expect(operationById('op-dependent').status).toBe('ready')

    useCamStore.getState().updateOperation(SETUP_ID, 'op-a', { enabled: true })
    expect(operationById('op-dependent').status).toBe('outdated')
  })

  it('marks a dependent operation stale when an earlier operation is edited', () => {
    useCamStore.getState().updateOperation(SETUP_ID, 'op-a', {
      params: { depth: 99 },
    })

    expect(operationById('op-dependent').status).toBe('outdated')
  })

  it('marks an operation stale when predecessor dependency is toggled on or off', () => {
    installProject(readyProject(false))
    const enableDependency: Partial<DependencyOperation> = {
      dependsOnPredecessors: true,
    }
    useCamStore.getState().updateOperation(
      SETUP_ID, 'op-dependent', enableDependency,
    )
    expect(operationById('op-dependent').status).toBe('outdated')

    installProject(readyProject(true))
    const disableDependency: Partial<DependencyOperation> = {
      dependsOnPredecessors: false,
    }
    useCamStore.getState().updateOperation(
      SETUP_ID, 'op-dependent', disableDependency,
    )
    expect(operationById('op-dependent').status).toBe('outdated')
  })

  it('marks a downstream dependent stale when an earlier dependency declaration changes', () => {
    const project = readyProject(true)
    const setup = project.setups[0]
    const earlier = setup.operations[1] as DependencyOperation
    earlier.dependsOnPredecessors = true
    for (const operation of setup.operations) {
      operation.generationFingerprint = projectOperationFingerprint(
        project, setup, operation, SNAPSHOT, TOOL, resolveTool,
      )
    }
    installProject(project)

    const disableDependency: Partial<DependencyOperation> = {
      dependsOnPredecessors: false,
    }
    useCamStore.getState().updateOperation(SETUP_ID, earlier.id, disableDependency)

    expect(operationById('op-dependent').status).toBe('outdated')
  })

  it('marks a dependent operation stale when an earlier operation is deleted', () => {
    useCamStore.getState().removeOperation(SETUP_ID, 'op-a')

    expect(operationById('op-dependent').status).toBe('outdated')
  })

  it('marks a dependent operation stale through folder suppression', () => {
    installProject(readyProject(true, true))

    useCamStore.getState().setOperationFolderEnabled(
      SETUP_ID, 'folder-roughing', false,
    )

    expect(operationById('op-dependent').status).toBe('outdated')
  })

  it('does not change any status or fingerprint when reordered operations have no dependency', () => {
    installProject(readyProject(false))
    const before = Object.fromEntries(
      useCamStore.getState().project.setups[0].operations.map((operation) => [
        operation.id,
        { status: operation.status, fingerprint: operation.generationFingerprint },
      ]),
    )

    useCamStore.getState().reorderOperations(SETUP_ID, 0, 2)

    const after = Object.fromEntries(
      useCamStore.getState().project.setups[0].operations.map((operation) => [
        operation.id,
        { status: operation.status, fingerprint: operation.generationFingerprint },
      ]),
    )
    expect(after).toEqual(before)
    expect(Object.values(after).every((value) => value.status === 'ready')).toBe(true)
  })

  it('keeps the legacy fingerprint bytes when no predecessor term is supplied', () => {
    const project = readyProject(false)
    const setup = project.setups[0]
    const operation = setup.operations[0]

    const legacyFingerprint = projectOperationFingerprint(
      project, setup, operation, SNAPSHOT, TOOL, resolveTool,
    )
    // WO-1883 repin: contract v3 hashes geometry without presentation fields
    // (names, colours), so these bytes changed; the pin still guards that no
    // predecessor term leaks into a non-dependent operation's fingerprint.
    // WO-2272 repin: the old value was already red before WO-2272 touched the
    // fingerprint (WO-2027 hashes the tool's normalized cut hand); the WO-2272
    // predecessor change leaves a non-dependent operation's bytes unchanged.
    // WO-2976 repin: WO-2904 bumped CAM_GENERATION_CONTRACT_VERSION 3 -> 4 and
    // the version is hashed, so every stamp's bytes changed once.
    expect(legacyFingerprint).toBe('camgen-v4-dc8b52aa5d9dd526')
    expect(legacyFingerprint).toBe(
      generationFingerprint({
        operation,
        setup,
        tool: TOOL,
        resolvedHeights: SNAPSHOT,
        geometry: project.geometry,
        stocks: project.stocks ?? [],
        sceneStock: project.sceneStock,
        machine: project.machine,
      }),
    )
  })

  it('gives a dependent operation moved first the same fingerprint as a non-dependent operation', () => {
    useCamStore.getState().reorderOperations(SETUP_ID, 2, 0)
    expect(operationById('op-dependent').status).toBe('outdated')

    const project = useCamStore.getState().project
    const setup = project.setups[0]
    const dependent = operationById('op-dependent')
    const nonDependent = { ...dependent, dependsOnPredecessors: undefined }

    expect(projectOperationFingerprint(
      project, setup, dependent, SNAPSHOT, TOOL, resolveTool,
    )).toBe(
      projectOperationFingerprint(
        project, setup, nonDependent, SNAPSHOT, TOOL, resolveTool,
      ),
    )

    restampReadyThroughStore('op-dependent')
    expect(operationById('op-dependent').status).toBe('ready')
  })
})

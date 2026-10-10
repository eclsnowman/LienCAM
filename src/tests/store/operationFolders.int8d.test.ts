import { beforeEach, describe, expect, it } from 'vitest'
import { selectEnabledOperations, setupEnabledCutTimeMs } from '../../lib/cam/operationSuppression'
import { useCamStore } from '../../store'
import type { Operation, Project, Setup } from '../../types'

const heights = {
  clearanceHeight: 10,
  clearanceHeightMode: 'absolute' as const,
  retractHeight: 8,
  feedHeight: 6,
  topHeight: 0,
  topHeightMode: 'absolute' as const,
  bottomHeight: -1,
  bottomHeightMode: 'absolute' as const,
}

const passes = {
  stepdown: 1,
  stepover: 1,
  stockToLeave: 0,
  finishPasses: 0,
  springPasses: 0,
}

const linking = {
  entryType: 'plunge' as const,
  rampAngle: 3,
  rampLength: 5,
  leadInRadius: 0,
  leadOutRadius: 0,
  retractType: 'full' as const,
  transitionType: 'direct' as const,
}

function makeOp(id: string, folderId?: string | null): Operation {
  return {
    id,
    name: id,
    type: 'contour_2d',
    enabled: true,
    folderId,
    status: 'pending',
    toolId: 'tool-1',
    geometrySelections: ['geo-1'],
    heights,
    passes,
    linking,
    params: { geometryId: 'geo-1', loopIds: ['loop-1'] },
  }
}

function makeSetup(): Setup {
  return {
    id: 'setup-1',
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1',
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: {
      type: 'rectangular',
      width: 10,
      height: 10,
      depth: 5,
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: 'aluminum',
    },
    operationFolders: [],
    operations: [makeOp('op-a'), makeOp('op-b'), makeOp('op-root')],
    notes: '',
  }
}

function installProject(setup: Setup): void {
  useCamStore.setState((state) => ({
    project: {
      ...state.project,
      setups: [setup],
      activeSetupId: setup.id,
      activeOperationId: null,
    } as Project,
    projectHistory: [],
    canUndo: false,
  }))
}

beforeEach(() => installProject(makeSetup()))

describe('INT-8D operation folders', () => {
  it('creates and renames a setup-local folder, then files an operation in it', () => {
    const store = useCamStore.getState()
    const folderId = store.addOperationFolder('setup-1', 'Roughing')

    store.setOperationFolderId('setup-1', 'op-a', folderId)
    store.renameOperationFolder('setup-1', folderId, 'Working operations')

    const setup = useCamStore.getState().project.setups[0]
    expect(setup.operationFolders?.[0]).toMatchObject({
      id: folderId,
      name: 'Working operations',
      parentId: null,
    })
    expect(setup.operations.find((operation) => operation.id === 'op-a')?.folderId).toBe(folderId)
  })

  it('deletes a folder tree without deleting its operations', () => {
    const store = useCamStore.getState()
    const parentId = store.addOperationFolder('setup-1', 'Parent')
    const childId = store.addOperationFolder('setup-1', 'Child', parentId)
    store.setOperationFolderId('setup-1', 'op-a', parentId)
    store.setOperationFolderId('setup-1', 'op-b', childId)

    store.removeOperationFolder('setup-1', parentId)

    const setup = useCamStore.getState().project.setups[0]
    expect(setup.operationFolders).toEqual([])
    expect(setup.operations.map((operation) => operation.id)).toEqual([
      'op-a',
      'op-b',
      'op-root',
    ])
    expect(setup.operations.find((operation) => operation.id === 'op-a')?.folderId).toBeNull()
    expect(setup.operations.find((operation) => operation.id === 'op-b')?.folderId).toBeNull()
  })

  it('suppresses a folder tree without touching setup-root operations', () => {
    const store = useCamStore.getState()
    const parentId = store.addOperationFolder('setup-1', 'Parent')
    const childId = store.addOperationFolder('setup-1', 'Child', parentId)
    store.setOperationFolderId('setup-1', 'op-a', parentId)
    store.setOperationFolderId('setup-1', 'op-b', childId)

    store.setOperationFolderEnabled('setup-1', parentId, false)

    let setup = useCamStore.getState().project.setups[0]
    expect(setup.operations.find((operation) => operation.id === 'op-a')?.enabled).toBe(false)
    expect(setup.operations.find((operation) => operation.id === 'op-b')?.enabled).toBe(false)
    expect(setup.operations.find((operation) => operation.id === 'op-root')?.enabled).toBe(true)

    useCamStore.getState().setOperationFolderEnabled('setup-1', parentId, true)
    setup = useCamStore.getState().project.setups[0]
    expect(setup.operations.every((operation) => operation.enabled)).toBe(true)
  })

  it('excludes a suppressed selected operation from execution and runtime', () => {
    const ready = {
      ...makeOp('ready'),
      status: 'ready' as const,
      estimatedCutTimeMs: 2_000,
    }
    const suppressed = {
      ...makeOp('suppressed'),
      enabled: false,
      status: 'ready' as const,
      estimatedCutTimeMs: 9_000,
    }

    expect(selectEnabledOperations([ready, suppressed], 'suppressed')).toEqual([])
    expect(selectEnabledOperations([ready, suppressed], null)).toEqual([ready])
    expect(setupEnabledCutTimeMs([ready, suppressed])).toBe(2_000)
  })
})

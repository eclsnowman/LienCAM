// WO-1883: an operation stays ready and postable after an edit that does not
// change what it cuts (rename, recolour, hide/show, folder move, loop rename),
// and still outdates when the cut does change (shape, placement, tool).
//
// Cosmetic edits run through the real store actions; every verdict is read at
// the production post boundary (buildPostInput -> validateOpsCurrent), which is
// where OP_OUTDATED refused the post before this order.

import { beforeEach, describe, expect, it } from 'vitest'

import {
  generationFingerprint,
  projectOperationFingerprint,
} from '../../lib/cam/generationFingerprint'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { buildPostInput } from '../../lib/post/buildPostInput'
import { validateOpsCurrent } from '../../lib/post/validate'
import { useCamStore } from '../../store'
import type {
  ImportedGeometry,
  Loop2D,
  Operation,
  Project,
  ResolvedHeightSnapshotV1,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const SETUP_ID = 'setup-wo1883'
const TOOL = {
  id: 'tool-wo1883',
  name: 'WO-1883 cutter',
  type: 'flat_end_mill',
  diameter: 6,
} as Tool

const SNAPSHOT: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 10, retract: 8, feed: 6, top: 5, bottom: 0 },
  machine: { clearance: 10, retract: 8, feed: 6, top: 5, bottom: 0 },
  intent: defaultHeightIntent(),
  dependencyIds: [SETUP_ID, 'stock-wo1883', 'geo-a', TOOL.id],
}

const MOVES: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
  { type: 'feed', x: 1, y: 1, z: 0, feed: 300, role: 'cut' },
]

function square(id: string, x0: number): Loop2D {
  return {
    id,
    name: `${id} label`,
    points: [
      { x: x0, y: 0 }, { x: x0 + 10, y: 0 }, { x: x0 + 10, y: 10 }, { x: x0, y: 10 },
    ],
    closed: true,
    type: 'contour',
    layerId: 'layer-0',
    area: 100,
  }
}

function part(id: string, x0: number): ImportedGeometry {
  return {
    id,
    name: `Part ${id}`,
    filename: `${id}.dxf`,
    type: 'curves_2d',
    format: 'dxf',
    loaded: true,
    stockId: 'stock-wo1883',
    color: '#808080',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: x0, y: 0, z: 0 },
      max: { x: x0 + 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 },
      center: { x: x0 + 5, y: 5, z: 0 },
    },
    loops: [square(`${id}-loop`, x0)],
    layers2d: [{ id: 'layer-0', name: 'Layer 0', color: '#ffffff', visible: true }],
  } as ImportedGeometry
}

function makeOperation(id: string, type: Operation['type'], geometryId: string): Operation {
  const operation = {
    id,
    name: id,
    type,
    enabled: true,
    status: 'ready',
    toolId: TOOL.id,
    geometrySelections: [geometryId],
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
    smartHeight: smartHeightAuthorityFixture(type),
    resolvedHeights: SNAPSHOT,
    passes: { stepdown: 1, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge',
      rampAngle: 3,
      rampLength: 5,
      leadInRadius: 0,
      leadOutRadius: 0,
      retractType: 'full',
      transitionType: 'direct',
    },
    params: { geometryId },
    toolpathMoves: MOVES,
  } as unknown as Operation
  operation.resolvedHeightPlan = smartHeightPlanFixture(operation, SNAPSHOT)
  return operation
}

function readyProject(): Project {
  const setup: Setup = {
    id: SETUP_ID,
    name: 'WO-1883 setup',
    wcs: {
      id: 'wcs-wo1883',
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId: 'stock-wo1883',
    },
    stock: {
      type: 'rectangular',
      width: 40,
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
      makeOperation('op-contour-a', 'contour_2d', 'geo-a'),
      // The 3D strategy reads the whole scene (no single part named).
      makeOperation('op-parallel-scene', 'parallel_3d', '__all__'),
    ],
    notes: '',
  } as unknown as Setup
  const project = {
    id: 'project-wo1883',
    name: 'WO-1883 project',
    version: '1',
    schemaVersion: 11,
    machine: { id: 'machine-wo1883', name: 'Machine', rapidRate: 1000 },
    geometry: [part('geo-a', 0), part('geo-b', 20)],
    geometryFolders: [{ id: 'folder-x', name: 'Folder X', parentId: null }],
    setups: [setup],
    stocks: [{ id: 'stock-wo1883', name: 'Stock', mode: 'derived' }],
    sceneStock: {
      mode: 'auto',
      autoOffsetXY: 0,
      autoOffsetZTop: 0,
      fixedWidth: 40,
      fixedHeight: 20,
      fixedDepth: 5,
      fixedStocks: [],
    },
    toolLibrary: [TOOL],
  } as unknown as Project

  for (const operation of setup.operations) {
    operation.generationFingerprint = projectOperationFingerprint(
      project, setup, operation, SNAPSHOT,
    )
  }
  return project
}

function installProject(project: Project): void {
  useCamStore.setState({
    project,
    toolLibrary: [TOOL],
    projectHistory: [],
    canUndo: false,
  } as never)
}

function outdatedAtPost(): string[] {
  const project = useCamStore.getState().project
  const setup = project.setups.find((candidate) => candidate.id === SETUP_ID)!
  return validateOpsCurrent(buildPostInput(project, setup).setup.operations)
    .filter((diag) => diag.code === 'OP_OUTDATED')
    .map((diag) => diag.opId!)
    .sort()
}

function statuses(): Record<string, string> {
  return Object.fromEntries(
    useCamStore.getState().project.setups[0].operations.map((op) => [op.id, op.status]),
  )
}

function editGeometry(id: string, edit: (geo: ImportedGeometry) => ImportedGeometry): void {
  useCamStore.setState((state) => ({
    project: {
      ...state.project,
      geometry: state.project.geometry.map((geo) => (geo.id === id ? edit(geo) : geo)),
    },
  }))
}

describe('WO-1883 presentation edits never outdate a toolpath', () => {
  beforeEach(() => installProject(readyProject()))

  it('starts ready and postable', () => {
    expect(outdatedAtPost()).toEqual([])
  })

  it('rename B, recolour A, hide/show B, rename a loop on A, move A to a folder: still ready and posts', () => {
    const store = useCamStore.getState()
    store.updateGeometryName('geo-b', 'Renamed B')
    store.updateGeometryColor('geo-a', '#ff0000')
    store.patchGeometry('geo-b', { hidden: true })
    store.patchGeometry('geo-b', { hidden: false })
    store.updateGeometryLoopName('geo-a', 'geo-a-loop', 'Outer edge')
    store.setGeometryFolderId('geo-a', 'folder-x')
    store.updateGeometryLayer('geo-a', 'layer-0', { name: 'Cut layer', color: '#00ff00' })

    const geometry = useCamStore.getState().project.geometry
    // The edits really landed on the project (a no-op action would prove nothing).
    expect(geometry.find((geo) => geo.id === 'geo-b')?.name).toBe('Renamed B')
    expect(geometry.find((geo) => geo.id === 'geo-a')?.color).toBe('#ff0000')
    expect(geometry.find((geo) => geo.id === 'geo-a')?.loops?.[0].name).toBe('Outer edge')
    expect(geometry.find((geo) => geo.id === 'geo-a')?.layers2d?.[0].name).toBe('Cut layer')

    expect(statuses()).toEqual({ 'op-contour-a': 'ready', 'op-parallel-scene': 'ready' })
    expect(outdatedAtPost()).toEqual([])
  })

  it('hiding a part that another operation names does not outdate it', () => {
    useCamStore.getState().patchGeometry('geo-b', { hidden: true })
    expect(outdatedAtPost()).not.toContain('op-contour-a')
  })

  it('hiding a part DOES outdate an all-parts operation (hidden parts leave that cut)', () => {
    useCamStore.getState().patchGeometry('geo-b', { hidden: true })
    expect(outdatedAtPost()).toContain('op-parallel-scene')
  })
})

describe('WO-1883 edits that change the cut still outdate', () => {
  beforeEach(() => installProject(readyProject()))

  it('moving a vertex of A\'s contour outdates the contour on A', () => {
    editGeometry('geo-a', (geo) => ({
      ...geo,
      loops: geo.loops!.map((loop) => ({
        ...loop,
        points: loop.points.map((p, i) => (i === 2 ? { x: p.x + 1, y: p.y } : p)),
      })),
    }))
    expect(outdatedAtPost()).toContain('op-contour-a')
  })

  it('changing the tool outdates the operation', () => {
    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        toolLibrary: state.project.toolLibrary.map((tool) => ({ ...tool, diameter: 8 })),
      },
    }))
    expect(outdatedAtPost()).toEqual(['op-contour-a', 'op-parallel-scene'])
  })

  it('a whole-scene 3D operation: moving part B outdates it, renaming B does not', () => {
    useCamStore.getState().updateGeometryName('geo-b', 'Renamed B')
    expect(outdatedAtPost()).not.toContain('op-parallel-scene')

    editGeometry('geo-b', (geo) => ({ ...geo, position: { x: 5, y: 0, z: 0 } }))
    expect(outdatedAtPost()).toContain('op-parallel-scene')
  })

  it('a cosmetic-only difference gives the same fingerprint; a shape difference does not', () => {
    const project = readyProject()
    const setup = project.setups[0]
    const operation = setup.operations[0]
    const base = {
      operation,
      setup,
      tool: TOOL,
      resolvedHeights: SNAPSHOT,
      stocks: project.stocks ?? [],
      sceneStock: project.sceneStock,
      machine: project.machine,
    }
    const cosmetic = project.geometry.map((geo) => ({
      ...geo,
      name: 'x',
      filename: 'y.dxf',
      color: '#123456',
      folderId: 'folder-x',
      locked: true,
      loops: geo.loops?.map((loop) => ({ ...loop, name: 'renamed' })),
      layers2d: geo.layers2d?.map((layer) => ({ ...layer, name: 'L', color: '#000000' })),
    }))
    const moved = project.geometry.map((geo) => ({ ...geo, position: { x: 1, y: 0, z: 0 } }))

    const reference = generationFingerprint({ ...base, geometry: project.geometry })
    expect(reference).toMatch(/^camgen-v3-/)
    expect(generationFingerprint({ ...base, geometry: cosmetic })).toBe(reference)
    expect(generationFingerprint({ ...base, geometry: moved })).not.toBe(reference)
  })
})

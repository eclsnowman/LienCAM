// WO-1440 (BUG-508, family K5): a holder id is an identity CLAIM, not a content
// guarantee. addHolder and loadProjectFromFile's holder merge both used to keep
// whichever holder reached an id first and silently drop any later one carrying
// the same id with different dimensions - so a tool pointed at the wrong
// clearance geometry with nothing said.
//
// These drive the REAL store actions (addHolder / addTool / loadProjectFromFile)
// and resolve each tool's holder exactly the way the crash guard does: the
// session library by holderId.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import type { Operation, Project, Setup, Tool, ToolHolder } from '../../types'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { CURRENT_PROJECT_SCHEMA_VERSION } = await import('../../store/migrations/projectMigrations')
const { resetDocumentHolder } = await import('../../doc/documentHolder')

const G = '9f1c2b7e-fusion-holder-guid'

function makeHolder(segments: ToolHolder['segments'], over: Partial<ToolHolder> = {}): ToolHolder {
  return { id: G, name: 'ER32 holder', vendor: 'Acme', productId: 'ER32-60', gaugeLength: 60, segments, ...over }
}

// Acceptance 1/2: the library record under G has a 20 mm segment; the second
// import claims G with different segment dimensions.
const holder20 = makeHolder([{ height: 20, lowerDiameter: 20, upperDiameter: 20 }])
const holderOther = makeHolder([
  { height: 35, lowerDiameter: 32, upperDiameter: 32 },
  { height: 15, lowerDiameter: 32, upperDiameter: 50 },
])

// Acceptance 3: the file's holder is 38.1 mm OD; the library copy was live-edited
// to 45 mm OD under the same id.
const holderFile381 = makeHolder([{ height: 40, lowerDiameter: 38.1, upperDiameter: 38.1 }])
const holderEdited45 = makeHolder([{ height: 40, lowerDiameter: 45, upperDiameter: 45 }])

function makeTool(id: string, over: Partial<Tool> = {}): Tool {
  return {
    id, name: id, type: 'flat_endmill',
    diameter: 6, fluteLength: 18, shankDiameter: 6, overallLength: 55,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1200, plungeRate: 300, depthOfCut: 3, stepover: 2.4 } },
    ...over,
  } as unknown as Tool
}

function makeOperation(id: string, toolId: string): Operation {
  return {
    id, name: 'Pocket 1', type: 'pocket', toolId, enabled: true, status: 'pending',
    geometryIds: [], params: {}, heights: {},
  } as unknown as Operation
}

function makeSetup(operations: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations,
    notes: '',
  } as unknown as Setup
}

function makeProjectFile(over: Partial<Project>): string {
  return JSON.stringify({
    id: 'wo1440-project', name: 'Pre-edit project', version: '1.0.0',
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry: [], setups: [],
    activeSetupId: null, activeOperationId: null,
    sceneStock: { mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1, fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [] },
    notes: '',
    ...over,
  })
}

const state = () => useCamStore.getState()

/** The holder a tool resolves to, the way the crash guard resolves it. */
function holderOfTool(toolId: string): ToolHolder | undefined {
  const tool = state().toolLibrary.find((t) => t.id === toolId)
  if (!tool?.holderId) return undefined
  return state().holders.find((h) => h.id === tool.holderId)
    ?? state().project.holders?.find((h) => h.id === tool.holderId)
}

/** The holder the reopened project's operation actually resolves to. */
function holderOfOperation(opId: string): ToolHolder | undefined {
  const op = state().project.setups.flatMap((s) => s.operations).find((o) => o.id === opId)
  return op ? holderOfTool(op.toolId) : undefined
}

const holderMessages = () => state().consoleEvents.filter((e) => /holder/i.test(e.message))

beforeEach(() => {
  resetDocumentHolder()
  vi.stubGlobal('alert', vi.fn())
  useCamStore.setState((s) => ({
    project: { ...s.project, geometry: [], setups: [] },
    toolLibrary: [],
    toolLibraries: [],
    holders: [],
    consoleEvents: [],
    consoleReadThroughId: 0,
    projectHistory: [],
    sketchHistory: [],
    projectFuture: [],
    sketchFuture: [],
    toolSlicesHistory: [],
    toolSlicesFuture: [],
    canUndo: false,
    canRedo: false,
  }))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('WO-1440: addHolder compares content behind a colliding id', () => {
  it('AC1: a second holder claiming the same id with different dimensions keeps both, and its tool links to its own geometry', () => {
    const firstId = state().addHolder(structuredClone(holder20))
    expect(state().addTool(makeTool('t-first', { holderId: firstId }))).toBe(true)

    const secondId = state().addHolder(structuredClone(holderOther))
    expect(state().addTool(makeTool('t-second', { holderId: secondId }))).toBe(true)

    expect(firstId).toBe(G)
    expect(secondId).not.toBe(G)
    expect(state().holders).toHaveLength(2)
    // The library record under G was not overwritten.
    expect(state().holders.find((h) => h.id === G)?.segments).toEqual(holder20.segments)
    expect(holderOfTool('t-first')?.segments).toEqual(holder20.segments)
    expect(holderOfTool('t-second')?.segments).toEqual(holderOther.segments)
    // Said once, in the console.
    expect(holderMessages()).toHaveLength(1)
  })

  it('AC2: the reverse arrival order resolves the same way - each tool keeps its own assembly', () => {
    const firstId = state().addHolder(structuredClone(holderOther))
    state().addTool(makeTool('t-other', { holderId: firstId }))
    const secondId = state().addHolder(structuredClone(holder20))
    state().addTool(makeTool('t-20', { holderId: secondId }))

    expect(firstId).not.toBe(secondId)
    expect(state().holders).toHaveLength(2)
    expect(holderOfTool('t-other')?.segments).toEqual(holderOther.segments)
    expect(holderOfTool('t-20')?.segments).toEqual(holder20.segments)
    const dims = state().holders.map((h) => JSON.stringify(h.segments)).sort()
    expect(dims).toEqual([JSON.stringify(holder20.segments), JSON.stringify(holderOther.segments)].sort())
  })

  it('AC4: byte-identical holder content under the same id still dedupes to one shared record', () => {
    const a = state().addHolder(structuredClone(holder20))
    const b = state().addHolder(structuredClone(holder20))
    expect(a).toBe(G)
    expect(b).toBe(G)
    expect(state().holders).toHaveLength(1)
    expect(holderMessages()).toHaveLength(0)
  })

  it('a repeated conflicting import shares the copy it made the first time (no id churn)', () => {
    state().addHolder(structuredClone(holder20))
    const once = state().addHolder(structuredClone(holderOther))
    const twice = state().addHolder(structuredClone(holderOther))
    expect(twice).toBe(once)
    expect(state().holders).toHaveLength(2)
  })
})

describe('WO-1440: loadProjectFromFile compares content behind a colliding holder id', () => {
  it('AC3: reopening a project whose holder collides with a live-edited library holder resolves its tool to the file\'s own 38.1 mm assembly', async () => {
    // The live session: the project's tool is in the library, and its holder was
    // edited from 38.1 to 45 mm OD after the file was saved.
    useCamStore.setState({
      holders: [structuredClone(holderEdited45)],
      toolLibrary: [makeTool('t-proj', { holderId: G })],
    })

    await state().loadProjectFromFile(makeProjectFile({
      toolLibrary: [makeTool('t-proj', { holderId: G })],
      holders: [structuredClone(holderFile381)],
      setups: [makeSetup([makeOperation('op-1', 't-proj')])],
    }))

    expect(state().project.id).toBe('wo1440-project')
    expect(holderOfOperation('op-1')?.segments).toEqual(holderFile381.segments)
    // The live edit is not overwritten; it is still in the library under G.
    expect(state().holders.find((h) => h.id === G)?.segments).toEqual(holderEdited45.segments)
    expect(holderOfTool('t-proj')?.segments).toEqual(holderEdited45.segments)
    expect(holderMessages()).toHaveLength(1)
  })

  it('AC3 variant: the project\'s tool not yet in the library links to the file\'s own assembly', async () => {
    useCamStore.setState({ holders: [structuredClone(holderEdited45)] })

    await state().loadProjectFromFile(makeProjectFile({
      toolLibrary: [makeTool('t-new', { holderId: G })],
      holders: [structuredClone(holderFile381)],
      setups: [makeSetup([makeOperation('op-1', 't-new')])],
    }))

    expect(holderOfOperation('op-1')?.segments).toEqual(holderFile381.segments)
    expect(holderOfTool('t-new')?.segments).toEqual(holderFile381.segments)
    expect(state().holders).toHaveLength(2)
  })

  it('AC4 on open: an embedded holder identical to the library copy is shared, nothing re-identified', async () => {
    useCamStore.setState({
      holders: [structuredClone(holderFile381)],
      toolLibrary: [makeTool('t-proj', { holderId: G })],
    })

    await state().loadProjectFromFile(makeProjectFile({
      toolLibrary: [makeTool('t-proj', { holderId: G })],
      holders: [structuredClone(holderFile381)],
      setups: [makeSetup([makeOperation('op-1', 't-proj')])],
    }))

    expect(state().holders).toHaveLength(1)
    expect(state().toolLibrary.map((t) => t.id)).toEqual(['t-proj'])
    expect(state().project.setups[0].operations[0].toolId).toBe('t-proj')
    expect(holderOfOperation('op-1')?.segments).toEqual(holderFile381.segments)
    expect(holderMessages()).toHaveLength(0)
  })

  it('reopening the same conflicting file twice does not mint another copy', async () => {
    useCamStore.setState({
      holders: [structuredClone(holderEdited45)],
      toolLibrary: [makeTool('t-proj', { holderId: G })],
    })
    const file = makeProjectFile({
      toolLibrary: [makeTool('t-proj', { holderId: G })],
      holders: [structuredClone(holderFile381)],
      setups: [makeSetup([makeOperation('op-1', 't-proj')])],
    })

    await state().loadProjectFromFile(file)
    const afterFirst = { holders: state().holders.length, tools: state().toolLibrary.length }
    await state().loadProjectFromFile(file)

    expect(state().holders).toHaveLength(afterFirst.holders)
    expect(state().toolLibrary).toHaveLength(afterFirst.tools)
    expect(holderOfOperation('op-1')?.segments).toEqual(holderFile381.segments)
  })
})

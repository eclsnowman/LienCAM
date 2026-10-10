// @vitest-environment jsdom
//
// WO-2663 Tier 2: an operation that turns outdated (amber) says why, through the
// production store, the real DesignTree badge hover and the real Properties
// panel Summary "Status" row. The operator 2026-10-07: "how can a user tell why a
// operation has failed or is orange?"
//
// Fixture: three ready operations in one setup, the last built on what the
// earlier ones left (dependsOnPredecessors, WO-1208), every generation claim
// stamped through projectOperationFingerprint exactly like a compute does.

import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { DesignTree } = await import('../../components/panels/DesignTree')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { projectOperationFingerprint } = await import('../../lib/cam/generationFingerprint')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { smartHeightAuthorityFixture } = await import('../helpers/smartHeightAuthorityFixture')
const { smartHeightPlanFixture } = await import('../helpers/smartHeightPlanFixture')
type Operation = import('../../types').Operation
type Project = import('../../types').Project
type ResolvedHeightSnapshotV1 = import('../../types').ResolvedHeightSnapshotV1
type Setup = import('../../types').Setup
type Tool = import('../../types').Tool
type ToolpathMove = import('../../types').ToolpathMove

const SETUP_ID = 'setup-wo2663'
const TOOL = { id: 'tool-wo2663', name: 'WO-2663 cutter', type: 'flat_end_mill', diameter: 6 } as Tool
const resolveTool = (toolId: string): Tool | undefined => (toolId === TOOL.id ? TOOL : undefined)
const SNAPSHOT: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 10, retract: 8, feed: 6, top: 5, bottom: 0 },
  machine: { clearance: 10, retract: 8, feed: 6, top: 5, bottom: 0 },
  intent: defaultHeightIntent(),
  dependencyIds: [SETUP_ID, 'stock-wo2663', 'geo-wo2663', TOOL.id],
}
const MOVES: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
  { type: 'feed', x: 1, y: 1, z: 0, feed: 300, role: 'cut' },
]

const UPSTREAM = '3D Finish 3'
const DOWNSTREAM = 'Contour 2'

function makeOperation(id: string, name: string, dependsOnPredecessors = false): Operation {
  const operation = {
    id, name, type: 'face', enabled: true, status: 'ready', toolId: TOOL.id,
    geometrySelections: ['geo-wo2663'],
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 8, feedHeight: 6,
      topHeight: 5, topHeightMode: 'absolute', bottomHeight: 0, bottomHeightMode: 'absolute',
      heightIntent: defaultHeightIntent(),
    },
    smartHeight: smartHeightAuthorityFixture('face'),
    resolvedHeights: SNAPSHOT,
    passes: { stepdown: 1, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 3, rampLength: 5, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'direct',
    },
    params: { depth: id.length },
    toolpathMoves: MOVES,
    ...(dependsOnPredecessors ? { dependsOnPredecessors: true } : {}),
  } as unknown as Operation
  operation.resolvedHeightPlan = smartHeightPlanFixture(operation, SNAPSHOT)
  return operation
}

/** upstreamHasResult=false: the upstream operation has not been computed yet
 *  (outdated, no toolpath) and the downstream one was built on that. */
function project(upstreamHasResult: boolean): Project {
  const upstream = makeOperation('op-upstream', UPSTREAM)
  if (!upstreamHasResult) {
    Object.assign(upstream, { status: 'outdated', toolpathMoves: undefined, resolvedHeightPlan: undefined })
  }
  const setup = {
    id: SETUP_ID, name: 'Setup 5',
    wcs: {
      id: 'wcs-wo2663', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: 'stock-wo2663',
    },
    stock: {
      type: 'rectangular', width: 20, height: 20, depth: 5,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operationFolders: [],
    operations: [makeOperation('op-first', 'Adaptive 1'), upstream, makeOperation('op-downstream', DOWNSTREAM, true)],
    notes: '',
  } as unknown as Setup
  const built = {
    id: 'project-wo2663', name: 'WO-2663', version: '1', schemaVersion: 11,
    machine: { id: 'machine-wo2663', name: 'Machine', rapidRate: 1000 },
    geometry: [{
      id: 'geo-wo2663', name: 'Part', format: 'step', stockId: 'stock-wo2663',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 5 },
        size: { x: 20, y: 20, z: 5 }, center: { x: 10, y: 10, z: 2.5 },
      },
    }],
    setups: [setup],
    stocks: [{ id: 'stock-wo2663', name: 'Stock', mode: 'derived' }],
    sceneStock: {
      mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0,
      fixedWidth: 20, fixedHeight: 20, fixedDepth: 5, fixedStocks: [],
    },
    toolLibrary: [],
    activeSetupId: SETUP_ID,
    activeOperationId: 'op-downstream',
  } as unknown as Project
  for (const operation of setup.operations) {
    if (operation.status !== 'ready') continue
    operation.generationFingerprint = projectOperationFingerprint(
      built, setup, operation, SNAPSHOT, TOOL, resolveTool,
    )
  }
  return built
}

function install(upstreamHasResult: boolean) {
  act(() => {
    useCamStore.setState((state) => ({
      project: project(upstreamHasResult),
      toolLibrary: [TOOL],
      projectHistory: [],
      canUndo: false,
      viewer: { ...state.viewer, selectedFolderId: null },
    }))
    useUiPrefs.setState({
      treeGeometryExpanded: true,
      treeSetupsExpanded: true,
      expandedSetupIds: [SETUP_ID],
      collapsedOperationFolderIds: [],
    })
  })
}

const op = (id: string): Operation =>
  useCamStore.getState().project.setups[0].operations.find((candidate) => candidate.id === id)!

/** The upstream operation's compute publishes its result through the store's
 *  one result writer, stamped the way a compute stamps it. */
function publishUpstreamResult() {
  const live = useCamStore.getState().project
  const setup = live.setups[0]
  const published = {
    ...op('op-upstream'), status: 'ready' as const, toolpathMoves: MOVES, resolvedHeights: SNAPSHOT,
  }
  published.resolvedHeightPlan = smartHeightPlanFixture(published, SNAPSHOT)
  const publishedSetup = {
    ...setup, operations: setup.operations.map((o) => (o.id === published.id ? published : o)),
  }
  published.generationFingerprint = projectOperationFingerprint(
    { ...live, setups: [publishedSetup] }, publishedSetup, published, SNAPSHOT, TOOL, resolveTool,
  )
  act(() => {
    useCamStore.getState().updateOperation(SETUP_ID, 'op-upstream', {
      status: 'ready',
      toolpathMoves: published.toolpathMoves,
      resolvedHeights: published.resolvedHeights,
      resolvedHeightPlan: published.resolvedHeightPlan,
      generationFingerprint: published.generationFingerprint,
    })
  })
}

function treeBadgeHover(name: string): string | null {
  const label = screen.getAllByTestId('tree-name-op').find((node) => node.textContent === name)
  if (!label) throw new Error(`no tree row for ${name}`)
  let row: HTMLElement | null = label
  while (row && !row.querySelector('.tree-op-status')) row = row.parentElement
  return row!.querySelector('.tree-op-status')!.getAttribute('data-tooltip')
}

function summaryStatus(): HTMLElement {
  const label = screen.getAllByText('Status').find((node) => node.classList.contains('props-label'))
  if (!label) throw new Error('no Summary Status row')
  return label.nextElementSibling as HTMLElement
}

beforeEach(() => { mem.clear() })
afterEach(() => { cleanup() })

describe('WO-2663: an outdated operation says why', () => {
  it('names the earlier operation whose new result outdated it, on the badge hover and the Summary row', () => {
    install(false)
    expect(op('op-downstream').status).toBe('ready')

    publishUpstreamResult()

    expect(op('op-upstream').status).toBe('ready')
    expect(op('op-downstream').status).toBe('outdated')
    render(React.createElement(DesignTree))
    expect(treeBadgeHover(DOWNSTREAM)).toBe(
      'Outdated: 3D Finish 3 changed after this was computed. Regenerate to update.')
    cleanup()

    render(React.createElement(PropertiesPanel))
    const status = summaryStatus()
    expect(status.className).toBe('props-value status-outdated')
    expect(status.textContent).toBe('outdated - 3D Finish 3 changed after this was computed')
    expect(status.getAttribute('data-tooltip')).toBe(
      'Outdated: 3D Finish 3 changed after this was computed. Regenerate to update.')
  })

  it('names the earlier operation when it is edited', () => {
    install(true)
    act(() => { useCamStore.getState().updateOperation(SETUP_ID, 'op-upstream', { params: { depth: 42 } }) })

    expect(op('op-downstream').status).toBe('outdated')
    render(React.createElement(DesignTree))
    expect(treeBadgeHover(DOWNSTREAM)).toBe(
      'Outdated: 3D Finish 3 changed after this was computed. Regenerate to update.')
  })

  it('an edit to the operation\'s own tool says its tool changed', () => {
    install(true)
    act(() => { useCamStore.getState().updateTool(TOOL.id, { diameter: 8 }) })

    expect(op('op-first').status).toBe('outdated')
    render(React.createElement(DesignTree))
    expect(treeBadgeHover('Adaptive 1')).toBe('Outdated: its tool changed. Regenerate to update.')
    cleanup()

    act(() => { useCamStore.getState().setActiveOperation('op-first') })
    render(React.createElement(PropertiesPanel))
    expect(summaryStatus().textContent).toBe('outdated - its tool changed')
  })

  it('the reason is dropped once the operation recomputes, and a ready operation keeps its plain row', () => {
    install(false)
    publishUpstreamResult()
    expect(op('op-downstream').outdatedReason).toEqual({ kind: 'earlier-changed', operationName: UPSTREAM })

    act(() => { useCamStore.getState().updateOperation(SETUP_ID, 'op-downstream', { status: 'computing' }) })
    expect(op('op-downstream').outdatedReason).toBeUndefined()

    act(() => { useCamStore.getState().setActiveOperation('op-upstream') })
    render(React.createElement(PropertiesPanel))
    const status = summaryStatus()
    expect(status.textContent).toBe('ready')
    expect(status.hasAttribute('data-tooltip')).toBe(false)
  })

  it('turning an earlier operation off, or deleting it, names it', () => {
    install(true)
    act(() => { useCamStore.getState().updateOperation(SETUP_ID, 'op-upstream', { enabled: false }) })
    expect(op('op-downstream').status).toBe('outdated')
    expect(op('op-downstream').outdatedReason).toEqual({ kind: 'earlier-disabled', operationName: UPSTREAM })

    install(true)
    act(() => { useCamStore.getState().removeOperation(SETUP_ID, 'op-upstream') })
    expect(op('op-downstream').status).toBe('outdated')
    render(React.createElement(DesignTree))
    expect(treeBadgeHover(DOWNSTREAM)).toBe(
      'Outdated: 3D Finish 3 was deleted after this was computed. Regenerate to update.')
  })

  it('moving the setup origin says the origin changed', () => {
    install(true)
    act(() => { useCamStore.getState().updateSetup(SETUP_ID, { wcs: { origin: { x: 5, y: 0, z: 0 } } as never }) })

    expect(op('op-first').status).toBe('outdated')
    render(React.createElement(DesignTree))
    expect(treeBadgeHover('Adaptive 1')).toBe('Outdated: the setup origin changed. Regenerate to update.')
  })

  it('a part move that outdates every operation gives each the real cause, not the operation above it', () => {
    install(true)
    act(() => {
      useCamStore.getState().updateGeometryTransform('geo-wo2663', { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    })

    render(React.createElement(DesignTree))
    for (const [id, name] of [['op-first', 'Adaptive 1'], ['op-upstream', UPSTREAM], ['op-downstream', DOWNSTREAM]]) {
      expect(op(id).status).toBe('outdated')
      expect(treeBadgeHover(name)).not.toMatch(/changed after this was computed/)
    }
  })

  it('undo brings an operation back without its toolpath and says so', () => {
    install(true)
    act(() => {
      useCamStore.getState().pushHistory()
      useCamStore.getState().updateOperation(SETUP_ID, 'op-first', { name: 'Adaptive 1b' })
    })
    act(() => { useCamStore.getState().undo() })

    expect(op('op-first').status).toBe('outdated')
    render(React.createElement(DesignTree))
    expect(treeBadgeHover('Adaptive 1')).toBe(
      'Outdated: undo brought it back without its toolpath. Regenerate to update.')
  })
})

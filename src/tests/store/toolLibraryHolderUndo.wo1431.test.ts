// WO-1431 (BUG-374): toolLibrary / toolLibraries / holders are ROOT store
// slices, outside `project`. Every tool, library and holder mutator already
// called pushHistory(), but the undo/redo seam only snapshotted and restored
// `project` + `activeSketch` - so Undo lit up and then silently did nothing:
// a deleted tool, library or holder was gone for good.
//
// These drive the REAL store actions (removeTool / removeToolLibrary /
// removeHolder / updateGeometryTransform) and the real undo()/redo().

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore } from '../../store'
import type { ImportedGeometry, Tool, ToolHolder, ToolLibrary } from '../../types'

function makeTool(id: string, over: Partial<Tool> = {}): Tool {
  return {
    id, name: id, type: 'flat_endmill',
    diameter: 4, fluteLength: 12, shankDiameter: 4, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 1.6 } },
    ...over,
  } as unknown as Tool
}

function makeGeo(): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -25, y: -25, z: 0 }, max: { x: 25, y: 25, z: 10 },
      size: { x: 50, y: 50, z: 10 }, center: { x: 0, y: 0, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
  }
}

const libA: ToolLibrary = { id: 'lib-a', name: 'Library A' }
const libB: ToolLibrary = { id: 'lib-b', name: 'Library B' }
const holder: ToolHolder = { id: 'holder-1', name: 'ER20', segments: [] }

const state = () => useCamStore.getState()
const toolIds = () => state().toolLibrary.map((t) => t.id)

describe('WO-1431: Undo/Redo covers tools, tool libraries and holders', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {})
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [], setups: [] },
      activeSketch: null,
      toolLibrary: [
        makeTool('t-1', { libraryId: 'lib-a', holderId: 'holder-1' } as Partial<Tool>),
        makeTool('t-2', { libraryId: 'lib-b' } as Partial<Tool>),
      ],
      toolLibraries: [libA, libB],
      holders: [holder],
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

  it('undo restores a deleted tool; redo deletes it again', () => {
    state().removeTool('t-1')
    expect(toolIds()).toEqual(['t-2'])

    state().undo()
    expect(toolIds()).toEqual(['t-1', 't-2'])

    state().redo()
    expect(toolIds()).toEqual(['t-2'])
  })

  it('undo restores a deleted tool library and the tools it cascaded; redo removes both again', () => {
    state().removeToolLibrary('lib-a')
    expect(state().toolLibraries.map((l) => l.id)).toEqual(['lib-b'])
    expect(toolIds()).toEqual(['t-2'])

    state().undo()
    expect(state().toolLibraries.map((l) => l.id)).toEqual(['lib-a', 'lib-b'])
    expect(toolIds()).toEqual(['t-1', 't-2'])

    state().redo()
    expect(state().toolLibraries.map((l) => l.id)).toEqual(['lib-b'])
    expect(toolIds()).toEqual(['t-2'])
  })

  it('undo restores a deleted holder and the tool link it cleared; redo removes both again', () => {
    state().removeHolder('holder-1')
    expect(state().holders).toEqual([])
    expect(state().toolLibrary.find((t) => t.id === 't-1')?.holderId).toBeUndefined()

    state().undo()
    expect(state().holders.map((h) => h.id)).toEqual(['holder-1'])
    expect(state().toolLibrary.find((t) => t.id === 't-1')?.holderId).toBe('holder-1')

    state().redo()
    expect(state().holders).toEqual([])
    expect(state().toolLibrary.find((t) => t.id === 't-1')?.holderId).toBeUndefined()
  })

  it('a project-only edit interleaved with a tool delete undoes and redoes each step in order', () => {
    state().addGeometry(makeGeo())
    state().removeTool('t-1')
    state().updateGeometryTransform('geo-1', { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    const pos = () => state().project.geometry[0]?.position.x

    // Undo the move: geometry back, tool still deleted.
    state().undo()
    expect(pos()).toBe(0)
    expect(toolIds()).toEqual(['t-2'])

    // Undo the tool delete: tool back, geometry unchanged.
    state().undo()
    expect(toolIds()).toEqual(['t-1', 't-2'])
    expect(pos()).toBe(0)
    expect(state().project.geometry).toHaveLength(1)

    // Redo the tool delete, then the move.
    state().redo()
    expect(toolIds()).toEqual(['t-2'])
    expect(pos()).toBe(0)

    state().redo()
    expect(toolIds()).toEqual(['t-2'])
    expect(pos()).toBe(10)
  })

  it('a fresh edit after undo clears the tool redo step with the project redo step', () => {
    state().removeTool('t-1')
    state().undo()
    expect(state().toolSlicesFuture).toHaveLength(1)

    state().renameToolLibrary('lib-b', 'Renamed')
    expect(state().canRedo).toBe(false)
    expect(state().toolSlicesFuture).toEqual([])
    state().redo()
    expect(toolIds()).toEqual(['t-1', 't-2'])
  })

  it('a project stack edited without its tool pairing never applies another step\'s tools', () => {
    state().removeTool('t-1')
    // A caller that rewrites projectHistory directly (as many tests do) leaves
    // the tool entry unpaired; undo must restore the project and leave tools.
    useCamStore.setState((s) => ({ projectHistory: [{ ...s.project }], sketchHistory: [null] }))
    state().undo()
    expect(toolIds()).toEqual(['t-2'])
  })
})

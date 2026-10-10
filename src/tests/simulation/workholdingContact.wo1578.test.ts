// @vitest-environment jsdom
//
// WO-1578: simulation names any contact with workholding, using the same
// contact rule WO-1565/1575's trim uses (cutter, neck, shank and holder kept
// the operation's allowance clear of a vise, jaw or clamp), without stopping
// or changing the played program.
//
// FIXTURE: a JAW block [-4..4, 11..30, 0..20] (same box WO-1575's own test
// uses), a 6 mm flat end mill (cutter 0..20mm radius 3, shank from 20mm
// radius 3, holder from 40mm radius 10) and its collet-chuck holder.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import type { ImportedGeometry, Tool, ToolHolder, ToolpathMove } from '../../types'
import { buildSolidColumns, trimToolpathToAssemblyReach, type ClearanceMesh } from '../../lib/cam/holderClearance'
import {
  checkWorkholdingContact,
  workholdingBoxMesh,
  workholdingContactConsoleLines,
  type WorkholdingContactMove,
} from '../../lib/simulation/workholdingContact'
import { SimulationPanel } from '../../components/simulation/SimulationPanel'
import { useCamStore } from '../../store'
import { makeOp, makeTool, makeWcs } from '../post/helpers'

type Box = readonly [number, number, number, number, number, number]

const JAW: Box = [-4, 11, 0, 4, 30, 20]
const ALLOWANCE = 0.25

function meshOf(boxes: readonly Box[]): ClearanceMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = positions.length / 3
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) positions.push(x, y, z)
    const faces = [
      [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
    ]
    for (const [a, b, c, d] of faces) indices.push(base + a, base + b, base + c, base + a, base + c, base + d)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

const HOLDER: ToolHolder = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

const FLAT_6 = {
  id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
  diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
  lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  holderId: 'holder-1', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool

function feed(x: number, y: number, z: number, line?: number): WorkholdingContactMove {
  return { type: 'feed', x, y, z, feed: 500, ...(line !== undefined ? { line } : {}) }
}

describe('WO-1578: checkWorkholdingContact', () => {
  it('names one console line at the program line where the cutter plunges into a marked jaw', () => {
    const moves: WorkholdingContactMove[] = [
      feed(0, 15, 30, 40),
      feed(0, 15, 30, 41),
      feed(0, 15, 5, 42), // plunges through the jaw's XY footprint and Z span
      feed(0, 15, 5, 43),
    ]
    const report = checkWorkholdingContact({
      moves, tool: FLAT_6, holder: HOLDER, workholding: [meshOf([JAW])], allowanceMm: ALLOWANCE,
    })
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0].components).toContain('cutter')
    const lines = workholdingContactConsoleLines('Contour', moves, report)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('line 42')
    expect(lines[0]).toContain('workholding')
    expect(lines[0]).toMatch(/X 0\.00 Y 15\.00 Z 5\.00/)
  })

  it('posts none for a program that clears the jaw', () => {
    const moves: WorkholdingContactMove[] = [
      feed(50, 50, 30, 10),
      feed(50, 50, 5, 11),
      feed(60, 50, 5, 12),
    ]
    const report = checkWorkholdingContact({
      moves, tool: FLAT_6, holder: HOLDER, workholding: [meshOf([JAW])], allowanceMm: ALLOWANCE,
    })
    expect(report.hits).toHaveLength(0)
    expect(workholdingContactConsoleLines('Contour', moves, report)).toHaveLength(0)
  })

  it('posts none for a generated contour already trimmed by WO-1575', () => {
    // A horizontal cut at Z 5 straight through the jaw's X range at Y 13, with
    // real retracts to Z 30 (above the 20 mm jaw) on either side - the same
    // geometry WO-1575's own test drives through the trim.
    const rawMoves: ToolpathMove[] = [
      { type: 'rapid', x: -15, y: 13, z: 30 },
      { type: 'feed', x: -15, y: 13, z: 5, feed: 500 },
      { type: 'feed', x: 15, y: 13, z: 5, feed: 500 },
      { type: 'rapid', x: 15, y: 13, z: 30 },
    ]
    const columns = buildSolidColumns(meshOf([JAW]))
    expect(columns).not.toBeNull()
    const trimmed = trimToolpathToAssemblyReach({
      moves: rawMoves, tool: FLAT_6, holder: HOLDER, workholding: [columns!], allowanceMm: ALLOWANCE,
    })
    expect(trimmed.trimmed).toBe(true) // sanity: the fixture really is blocked without the trim

    const report = checkWorkholdingContact({
      moves: trimmed.moves as WorkholdingContactMove[],
      tool: FLAT_6, holder: HOLDER, workholding: [meshOf([JAW])], allowanceMm: ALLOWANCE,
    })
    expect(report.hits).toHaveLength(0)
  })

  it('collapses consecutive contacting moves into one ranged line', () => {
    const moves: WorkholdingContactMove[] = [
      feed(0, 15, 30, 100),
      feed(0, 15, 15, 101),
      feed(0, 16, 15, 102),
      feed(0, 17, 15, 103),
      feed(50, 50, 15, 104), // clear again
    ]
    const report = checkWorkholdingContact({
      moves, tool: FLAT_6, holder: HOLDER, workholding: [meshOf([JAW])], allowanceMm: ALLOWANCE,
    })
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0].firstMoveIndex).toBeLessThan(report.hits[0].lastMoveIndex)
    const lines = workholdingContactConsoleLines('Contour', moves, report)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/line 10\d-10\d/)
  })

  it('falls back to operation + move index when the move carries no program line', () => {
    const moves: WorkholdingContactMove[] = [
      { type: 'feed', x: 0, y: 15, z: 30, feed: 500 },
      { type: 'feed', x: 0, y: 15, z: 5, feed: 500 },
    ]
    const report = checkWorkholdingContact({
      moves, tool: FLAT_6, holder: HOLDER, workholding: [meshOf([JAW])], allowanceMm: ALLOWANCE,
    })
    expect(report.hits).toHaveLength(1)
    const lines = workholdingContactConsoleLines('Pocket', moves, report)
    expect(lines[0]).toContain('Pocket, move 2')
  })

  it('reports no contact and no components when there is no workholding', () => {
    const moves: WorkholdingContactMove[] = [feed(0, 15, 30), feed(0, 15, 5)]
    const report = checkWorkholdingContact({
      moves, tool: FLAT_6, holder: HOLDER, workholding: [], allowanceMm: ALLOWANCE,
    })
    expect(report.hits).toHaveLength(0)
  })
})

describe('WO-1578: workholdingBoxMesh', () => {
  it('bakes a bounding box through position and rotation into a solid the contact check can see', () => {
    const mesh = workholdingBoxMesh(
      { min: { x: -4, y: 11, z: 0 }, max: { x: 4, y: 30, z: 20 }, size: { x: 8, y: 19, z: 20 }, center: { x: 0, y: 20.5, z: 10 } },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    )
    const columns = buildSolidColumns(mesh)
    expect(columns).not.toBeNull()

    const moves: WorkholdingContactMove[] = [feed(0, 15, 30, 1), feed(0, 15, 5, 2)]
    const report = checkWorkholdingContact({
      moves, tool: FLAT_6, holder: HOLDER, workholding: [mesh], allowanceMm: ALLOWANCE,
    })
    expect(report.hits).toHaveLength(1)
  })

  it('translates the box by the geometry position', () => {
    const mesh = workholdingBoxMesh(
      { min: { x: -4, y: -4, z: 0 }, max: { x: 4, y: 4, z: 20 }, size: { x: 8, y: 8, z: 20 }, center: { x: 0, y: 0, z: 10 } },
      { x: 100, y: 100, z: 0 },
      { x: 0, y: 0, z: 0 },
    )
    // At the ORIGIN (pre-translation location) there is nothing now.
    const clearOfOrigin = checkWorkholdingContact({
      moves: [feed(0, 0, 30, 1), feed(0, 0, 5, 2)],
      tool: FLAT_6, holder: HOLDER, workholding: [mesh], allowanceMm: ALLOWANCE,
    })
    expect(clearOfOrigin.hits).toHaveLength(0)
    // At the TRANSLATED location the box is there.
    const atTranslated = checkWorkholdingContact({
      moves: [feed(100, 100, 30, 1), feed(100, 100, 5, 2)],
      tool: FLAT_6, holder: HOLDER, workholding: [mesh], allowanceMm: ALLOWANCE,
    })
    expect(atTranslated.hits).toHaveLength(1)
  })
})

describe('WO-1578 audit fix: SimulationPanel only posts contact lines in simulation, once per contact', () => {
  const JAW_GEO: ImportedGeometry = {
    id: 'jaw-1', name: 'Jaw', filename: 'jaw.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -4, y: 11, z: 0 }, max: { x: 4, y: 30, z: 20 },
      size: { x: 8, y: 19, z: 20 }, center: { x: 0, y: 20.5, z: 10 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, workholding: true,
  } as ImportedGeometry

  function seedPlungeIntoJaw(): void {
    const setup = {
      id: 'setup-wo1578', name: 'WO-1578 fixture', wcs: makeWcs(),
      stock: {
        type: 'rectangular' as const, width: 100, height: 80, depth: 20,
        offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' as const,
      },
      operations: [makeOp({
        id: 'op-wo1578',
        toolId: 't-wo1578',
        toolpathMoves: [
          { type: 'rapid', x: 0, y: 15, z: 30 },
          { type: 'feed', x: 0, y: 15, z: 5, feed: 500 }, // plunges into the jaw
        ] as ToolpathMove[],
      })],
      notes: '',
    }
    act(() => {
      useCamStore.setState(s => ({
        project: {
          ...s.project,
          machine: { ...s.project.machine, rapidRate: 5000 },
          geometry: [JAW_GEO],
          setups: [setup as unknown as (typeof s.project.setups)[number]],
          activeSetupId: setup.id,
          activeOperationId: 'op-wo1578',
        },
        toolLibrary: [makeTool({ id: 't-wo1578', diameter: 6, shankDiameter: 6, fluteLength: 20, overallLength: 60 })],
        viewer: { ...s.viewer, mode: 'toolpath' },
      }))
    })
  }

  const contactMessages = () =>
    useCamStore.getState().consoleEvents.filter(e => e.source === 'simulation' && e.message.includes('workholding'))

  beforeEach(() => {
    act(() => { useCamStore.getState().newProject() })
  })

  afterEach(() => {
    cleanup()
  })

  it('does not post while on the Toolpath tab, posts exactly one line on entering Simulate, and never duplicates on re-entry', () => {
    seedPlungeIntoJaw()
    render(createElement(SimulationPanel))

    // Mounted but still on the Toolpath tab: outcome 1 says "Simulating any program",
    // so no line yet even though the frame-rebuild effect has already run once.
    expect(contactMessages()).toHaveLength(0)

    act(() => { useCamStore.setState(s => ({ viewer: { ...s.viewer, mode: 'simulation' } })) })
    expect(contactMessages()).toHaveLength(1)

    // Leaving simulation must not add another line, and must not clear the one posted.
    act(() => { useCamStore.setState(s => ({ viewer: { ...s.viewer, mode: 'toolpath' } })) })
    expect(contactMessages()).toHaveLength(1)

    // Re-entering simulation re-runs the same frame-rebuild effect; the same
    // contact must not stack a second identical line.
    act(() => { useCamStore.setState(s => ({ viewer: { ...s.viewer, mode: 'simulation' } })) })
    expect(contactMessages()).toHaveLength(1)
  })
})

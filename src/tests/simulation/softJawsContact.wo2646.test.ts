// @vitest-environment jsdom
//
// WO-2646. The shipped soft-jaws example (examples/03-soft-jaws) reported
// "Drill 3, move 3: cutter contacts workholding at X 20.00 Y 41.00 Z 0.00"
// (WO-2641). The drill really does stop at the jaw blank's bottom, but under
// it is the open gap between the vise's two ledges, 10 mm above the base: the
// contact was against the fixed vise's BOUNDING BOX, whose top fills that gap.
// The contact check now runs against the vise's exact imported shape.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { Project, Tool, ToolpathMove } from '../../types'

const root = path.resolve(__dirname, '../../..')
const project = JSON.parse(readFileSync(path.join(root, 'examples/03-soft-jaws/soft-jaws.camproject'), 'utf8')) as
  Project & { toolLibrary: Tool[]; binaries: Record<string, { stl: string }> }

// The STL cache the app fills from the project's binaries when it opens it.
const cache = vi.hoisted(() => ({ stl: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async (id: string) => cache.stl.get(id) ?? null),
  removeCachedSTL: vi.fn(async () => {}),
}))
function fillStlCache(): void {
  for (const [id, { stl }] of Object.entries(project.binaries)) {
    const bytes = Buffer.from(stl, 'base64')
    cache.stl.set(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  }
}

const {
  checkWorkholdingContact, primeWorkholdingContactShapes, workholdingContactConsoleLines, workholdingContactShapes,
} = await import('../../lib/simulation/workholdingContact')
const { workholdingContactBodies } = await import('../../lib/workholding/contactBodies')
const { clearanceAllowanceMmOf } = await import('../../lib/cam/holderClearanceGate')
const { SimulationPanel } = await import('../../components/simulation/SimulationPanel')
const { useCamStore } = await import('../../store')

const jaw2 = project.setups[1]
const drill2 = jaw2.operations.find(op => op.name === 'Drill 3')!
const drillTool = project.toolLibrary.find(t => t.id === drill2.toolId)!
const REPORTED = [
  'Drill 3, move 3: cutter contacts workholding at X 20.00 Y 41.00 Z 0.00.',
  'Drill 3, move 7: cutter contacts workholding at X 60.00 Y 41.00 Z 0.00.',
]

function contactLines(op: (typeof jaw2.operations)[number], workholding: Parameters<typeof checkWorkholdingContact>[0]['workholding'], moves = op.toolpathMoves!) {
  const tool = project.toolLibrary.find(t => t.id === op.toolId)!
  const report = checkWorkholdingContact({ moves, tool, workholding, allowanceMm: clearanceAllowanceMmOf(op.params) })
  return workholdingContactConsoleLines(op.name, moves, report)
}

/** The project as it opens: the shapes in the STL cache, fresh row objects. */
async function primedProject() {
  fillStlCache()
  const fresh = structuredClone(project)
  await primeWorkholdingContactShapes(fresh)
  return fresh
}

describe('WO-2646: soft-jaws drill contact is the vise box, not the vise', () => {
  afterEach(() => { cleanup(); cache.stl.clear() })

  it('the saved Drill 3 plunges to the blank bottom over the gap between the ledges', () => {
    const plunges = drill2.toolpathMoves!.filter(m => m.role === 'plunge').map(m => [Math.round(m.x), Math.round(m.y), m.z])
    expect(plunges).toEqual([[20, 41, 0], [60, 41, 0]])
    expect(drillTool.diameter).toBe(3)
  })

  it('reproduces the reported contact against the bounding boxes, and while no shape can be read', async () => {
    expect(contactLines(drill2, workholdingContactBodies(project, jaw2.id))).toEqual(REPORTED)
    const unread = structuredClone(project)
    await primeWorkholdingContactShapes(unread) // empty cache: the boxes stand in
    expect(contactLines(drill2, workholdingContactShapes(unread, jaw2.id))).toEqual(REPORTED)
  })

  it('reports no contact for any saved operation of either jaw against the exact vise', async () => {
    const fresh = await primedProject()
    for (const setup of fresh.setups) {
      const exact = workholdingContactShapes(fresh, setup.id)
      expect(exact).toHaveLength(2)
      for (const op of setup.operations) {
        expect(op.toolpathMoves!.length).toBeGreaterThan(0)
        expect(contactLines(op, exact), `${setup.name} ${op.name}`).toEqual([])
      }
    }
  })

  it('still reports a drill that really reaches the vise base or a ledge (control)', async () => {
    const fresh = await primedProject()
    const exact = workholdingContactShapes(fresh, jaw2.id)
    const deeper: ToolpathMove[] = drill2.toolpathMoves!.map(m => m.role === 'plunge' ? { ...m, z: -11 } : m)
    // Into the base at Z -10: the plunge and the retract out of it both touch it.
    expect(contactLines(drill2, exact, deeper)).toEqual([
      'Drill 3, moves 3-4: cutter contacts workholding at X 20.00 Y 41.00 Z -11.00.',
      'Drill 3, moves 7-8: cutter contacts workholding at X 60.00 Y 41.00 Z -11.00.',
    ])
    // Over the moving jaw's ledge (Y 43..51, top Z 0) a drill to Z 0 touches it.
    const overLedge: ToolpathMove[] = drill2.toolpathMoves!.map(m => ({ ...m, y: 47 }))
    expect(contactLines(drill2, exact, overLedge)).toHaveLength(2)
  })

  it('the mounted SimulationPanel posts no contact for jaw 2 once it has read the vise shapes', async () => {
    fillStlCache()
    const { binaries: _binaries, ...opened } = structuredClone(project)
    const contactMessages = () => useCamStore.getState().consoleEvents
      .filter(e => e.source === 'simulation' && e.message.includes('contacts workholding'))
    act(() => {
      useCamStore.setState(s => ({
        project: { ...s.project, ...opened, activeSetupId: jaw2.id, activeOperationId: null } as typeof s.project,
        toolLibrary: project.toolLibrary,
        consoleEvents: [],
        viewer: { ...s.viewer, mode: 'toolpath' },
      }))
    })
    render(createElement(SimulationPanel))
    // The panel primed the shapes on the Toolpath tab; let that read finish.
    await act(async () => { await primeWorkholdingContactShapes(useCamStore.getState().project) })
    act(() => { useCamStore.setState(s => ({ viewer: { ...s.viewer, mode: 'simulation' } })) })
    expect(contactMessages()).toEqual([])
  })
})

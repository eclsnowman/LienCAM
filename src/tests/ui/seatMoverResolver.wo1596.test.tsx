// @vitest-environment jsdom
//
// WO-1596 (mating S2): the mover is chosen by lock, then pick order.
//
// Drives the LIVE `SeatInViseStrip` against the real store, fed face picks
// through the same `enterSeatFacePickMode` callback the viewport hands it:
//   - neither locked: pick order moves the workholding, and "Move Part 1
//     instead" swaps it - the part's cost is stated before Apply;
//   - the vise locked: the PART moves into the vise, cost stated first, and
//     the console line after names the SAME operations the sentence did;
//   - the part locked: the vise moves, at once, exactly as WO-1587 shipped;
//   - both locked: nothing moves until "Unlock Bench Vise and move it", which
//     unlocks it and seats it with the pair already picked.

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, Setup, Vec3 } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => new ArrayBuffer(84)),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { SeatInViseStrip, useSeatInViseUi, resolveSeatMover, moveImpactText } =
  await import('../../components/viewport/SeatInViseStrip')
const { useCamStore } = await import('../../store')
type SeatFacePick = import('../../lib/viewport/CNCViewport').SeatFacePick

afterEach(cleanup)

const TOL = 0.001

function box(id: string, name: string, max: Vec3, position: Vec3): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { ...max }, size: { ...max },
      center: { x: max.x / 2, y: max.y / 2, z: max.z / 2 },
    },
    position, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  } as ImportedGeometry
}

// The vise sits at the origin: floor (top face) at z = 50, +X face at x = 100.
// The part is a 40 x 30 x 12 block floating off to the side at z = 100.
const VISE_POS: Vec3 = { x: 0, y: 0, z: 0 }
const PART_POS: Vec3 = { x: 200, y: 10, z: 100 }
const VISE = box('vise', 'Bench Vise', { x: 100, y: 80, z: 50 }, VISE_POS)
const PART = box('part', 'Part 1', { x: 40, y: 30, z: 12 }, PART_POS)

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
function op(id: string, geometryId: string): Operation {
  return {
    id, name: id, type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking, params: { geometryId },
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 }],
  }
}

const geoOf = (id: string) => useCamStore.getState().project.geometry.find((g) => g.id === id)!
const text = (testId: string) => screen.queryByTestId(testId)?.textContent ?? null

// World picks. The vise never moves in the part-mover cases; the part's picks
// are read through its CURRENT pose, the way the real face picker reports them.
const viseFloor = (): SeatFacePick => ({ geoId: 'vise', point: { x: 50, y: 40, z: 50 }, normal: { x: 0, y: 0, z: 1 } })
const viseRight = (): SeatFacePick => ({ geoId: 'vise', point: { x: 100, y: 40, z: 25 }, normal: { x: 1, y: 0, z: 0 } })
const partBottom = (): SeatFacePick => {
  const p = geoOf('part').position
  return { geoId: 'part', point: { x: p.x + 20, y: p.y + 15, z: p.z }, normal: { x: 0, y: 0, z: -1 } }
}
const partLeft = (): SeatFacePick => {
  const p = geoOf('part').position
  return { geoId: 'part', point: { x: p.x, y: p.y + 15, z: p.z + 6 }, normal: { x: -1, y: 0, z: 0 } }
}

let onPick: ((p: SeatFacePick) => void) | null = null
const fire = (p: SeatFacePick) => act(() => { onPick?.(p) })

function openStrip(): void {
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    setPartTransform: vi.fn(),
    canPickFacesFor: (id: string) => id === 'vise' || id === 'part',
    enterSeatFacePickMode: (_ids: readonly string[], cb: (p: SeatFacePick) => void) => { onPick = cb },
    exitSeatFacePickMode: vi.fn(),
  }
  act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
  render(<SeatInViseStrip />)
  act(() => { fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'part' } }) })
}

beforeEach(() => {
  act(() => {
    const st = useCamStore.getState()
    st.newProject()
    st.addGeometry(PART)
    st.addGeometry(VISE)
    st.setGeometryWorkholding('vise', true)
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        setups: s.project.setups.length > 0
          ? s.project.setups.map((su, i) => (i === 0 ? { ...su, operations: [op('Face 1', 'part'), op('Contour 1', 'part'), op('Adaptive 1', '__all__')] } : su))
          : [{
            id: 's1', name: 'Setup 1', notes: '',
            wcs: {
              id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
              xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
            },
            stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
            operations: [op('Face 1', 'part'), op('Contour 1', 'part'), op('Adaptive 1', '__all__')],
          } as Setup],
      },
      consoleEvents: [],
    }))
  })
  act(() => { useSeatInViseUi.getState().closeSeatInVise() })
})

afterEach(() => { delete (window as unknown as Record<string, unknown>).__cncViewport; onPick = null })

describe('WO-1596: resolveSeatMover reads the lock first, then pick order', () => {
  it('one locked -> the other moves; both -> nothing; neither -> the first pick', () => {
    expect(resolveSeatMover('workholding', true, false)).toEqual({ mover: 'other', decidedBy: 'lock' })
    expect(resolveSeatMover('workholding', false, true)).toEqual({ mover: 'workholding', decidedBy: 'lock' })
    expect(resolveSeatMover('other', true, false)).toEqual({ mover: 'other', decidedBy: 'lock' })
    expect(resolveSeatMover('workholding', true, true)).toEqual({ mover: null, decidedBy: 'both-locked' })
    expect(resolveSeatMover('workholding', false, false)).toEqual({ mover: 'workholding', decidedBy: 'pick-order' })
    expect(resolveSeatMover('other', false, false)).toEqual({ mover: 'other', decidedBy: 'pick-order' })
  })
})

describe('WO-1596: the strip names the mover first in every state', () => {
  it('neither locked: the vise moves by pick order, and one click swaps the part in with its cost stated', () => {
    openStrip()
    expect(text('seat-in-vise-mover')).toBe('Bench Vise moves to Part 1.')
    expect(text('seat-in-vise-impact')).toBeNull()
    expect(text('seat-in-vise-instruction')).toMatch(/^Pick a face on Bench Vise \(it moves\)/)

    act(() => { fireEvent.click(screen.getByTestId('seat-in-vise-swap')) })
    expect(text('seat-in-vise-mover')).toBe('Part 1 moves to Bench Vise.')
    expect(text('seat-in-vise-impact')).toBe('Moving Part 1 marks 3 operations outdated: Face 1, Contour 1, Adaptive 1.')
    expect(screen.getByTestId('seat-in-vise-swap').textContent).toBe('Move Bench Vise instead')
  })

  it('the vise locked: the PART moves into it, only on Apply, and the console names what the strip named', () => {
    act(() => { useCamStore.getState().setGeometryLocked('vise', true) })
    openStrip()
    expect(text('seat-in-vise-mover')).toBe('Part 1 moves to Bench Vise.')
    // A lock decided it, so there is nothing to swap.
    expect(screen.queryByTestId('seat-in-vise-swap')).toBeNull()

    fire(viseFloor())
    fire(partBottom())
    // The pair is held: nothing has moved, the cost is on the strip, Apply is offered.
    expect(geoOf('part').position).toEqual(PART_POS)
    const before = text('seat-in-vise-impact')
    expect(before).toBe('Moving Part 1 marks 3 operations outdated: Face 1, Contour 1, Adaptive 1.')

    act(() => { fireEvent.click(screen.getByTestId('seat-in-vise-apply')) })
    expect(Math.abs(geoOf('part').position.z - 50)).toBeLessThan(TOL)
    expect(geoOf('vise').position).toEqual(VISE_POS)
    // The viewport heard the part at the pose the store holds, and the locked
    // vise at its held pose LAST (WO-1590's contract) - never anywhere else.
    const setPartTransform = ((window as unknown as Record<string, unknown>).__cncViewport as {
      setPartTransform: ReturnType<typeof vi.fn>
    }).setPartTransform
    expect(setPartTransform).toHaveBeenCalledWith('part', geoOf('part').position, geoOf('part').rotation)
    expect(setPartTransform).toHaveBeenLastCalledWith('vise', VISE_POS, geoOf('vise').rotation)
    for (const [id, pos] of setPartTransform.mock.calls) if (id === 'vise') expect(pos).toEqual(VISE_POS)

    // The console line after reads the same selector: same names, same order.
    const events = useCamStore.getState().consoleEvents
    const line = events[events.length - 1]
    expect(line.message).toBe(moveImpactText('Part 1', ['Face 1', 'Contour 1', 'Adaptive 1'], 'after'))
    const outdated = useCamStore.getState().project.setups.flatMap((s) => s.operations)
      .filter((o) => o.status === 'outdated').map((o) => o.name)
    expect(outdated).toEqual(['Face 1', 'Contour 1', 'Adaptive 1'])

    // Second seat: the part slides along the floor until its left face meets
    // the vise's right face - and stays on the floor.
    expect(text('seat-in-vise-instruction')).toMatch(/first contact holds/)
    expect(text('seat-in-vise-impact')).toBe('Moving Part 1 marks no operations outdated.')
    fire(viseRight())
    fire(partLeft())
    act(() => { fireEvent.click(screen.getByTestId('seat-in-vise-apply')) })
    expect(Math.abs(geoOf('part').position.x - 100)).toBeLessThan(TOL)
    expect(Math.abs(geoOf('part').position.z - 50)).toBeLessThan(TOL)
    expect(geoOf('vise').position).toEqual(VISE_POS)
  })

  it('the part locked: the vise moves to it at once, as WO-1587 shipped, and states no part cost', () => {
    act(() => { useCamStore.getState().setGeometryLocked('part', true) })
    openStrip()
    expect(text('seat-in-vise-mover')).toBe('Bench Vise moves to Part 1.')
    expect(text('seat-in-vise-impact')).toBeNull()

    fire(viseFloor())
    fire(partBottom())
    // Vise floor (z = 50 in its frame) now meets the part bottom at z = 100.
    expect(Math.abs(geoOf('vise').position.z - 50)).toBeLessThan(TOL)
    expect(geoOf('part').position).toEqual(PART_POS)
  })

  it('both locked: nothing moves, the strip names both, and one click unlocks the vise and seats it', () => {
    act(() => {
      useCamStore.getState().setGeometryLocked('vise', true)
      useCamStore.getState().setGeometryLocked('part', true)
    })
    openStrip()
    expect(text('seat-in-vise-mover')).toBe('Bench Vise and Part 1 are both locked, so neither can move. Unlock one to seat them.')
    const unlock = screen.getByTestId('seat-in-vise-unlock-move')
    expect(unlock.textContent).toBe('Unlock Bench Vise and move it')

    fire(viseFloor())
    fire(partBottom())
    expect(geoOf('vise').position).toEqual(VISE_POS)
    expect(geoOf('part').position).toEqual(PART_POS)

    act(() => { fireEvent.click(screen.getByTestId('seat-in-vise-unlock-move')) })
    expect(geoOf('vise').locked).toBeUndefined()
    expect(geoOf('part').locked).toBe(true)
    expect(Math.abs(geoOf('vise').position.z - 50)).toBeLessThan(TOL)
    expect(geoOf('part').position).toEqual(PART_POS)
    expect(text('seat-in-vise-instruction')).toMatch(/first contact holds/)
  })
})

// @vitest-environment jsdom
// WO-3250 (WO-3177 Slot brief): a slot authored through Add operation ->
// Slot (centerline) generates and posts as the ordinary Engrave it is.
//
// Route: the REAL NewOperationModal (type card, Tool, Geometry, Passes,
// Heights, Create), the REAL store (addOperation, computeOperationToolpath,
// stageOperationsForEmission, save/reopen), the REAL toolpathWorker.ts
// in-process (tabRemovalPostDialog.wo3176's harness), the REAL post
// (postProject) and the G-code reader (parseGcode).
//
// The truth is the WO-3177 capsule oracle, worked out here from the line and
// the cutter, never from the app's own stock model: a 6 mm cutter riding the
// line (0,0)-(40,0) sweeps a capsule 6 wide, x[-3,43] y[-3,3], area
// 40 x 6 + pi x 3^2 = 268.2743339 mm^2; Trochoidal 9 wide sweeps x[-4.5,44.5]
// y[-4.5,4.5], area 40 x 9 + pi x 4.5^2 = 423.6172512 mm^2, on orbits of
// radius (9 - 6) / 2 = 1.5; around a closed R30 circle it sweeps the annulus
// 25.5..34.5 with no ridge at the seam. Top 0, bottom -6, stepdown 2: the
// cut levels -2, -4 and -6 reach the posted program.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, ImportedGeometry, Operation, PhysicalStock, Project, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'
import { makeMachine } from '../post/helpers'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
} })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore, snapshotCurrentProjectFile } = await import('../../store')
const post = await import('../../lib/post')
const { parseGcode } = await import('../../lib/gcode/parse')

const SETUP_1 = 'setup-1'
const STOCK_ID = 'stock-1'
const D = 6
const R = D / 2
/** WCS Z0 on the stock top (machine Z 12); the slot is cut 6 deep. */
const WCS: Vec3 = { x: 0, y: 0, z: 12 }
const RING = { x: 40, y: 60, r: 30 }

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const END_MILL = {
  id: 'end-mill', name: '6 mm flat end mill', type: 'flat_end_mill', toolNumber: 1, cutHand: 'right',
  diameter: D, fluteLength: 20, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 3 } },
} as unknown as Tool

function curves(id: string, name: string, loop: Record<string, unknown>, min: Vec3, max: Vec3): ImportedGeometry {
  return {
    id, name, filename: `${name}.dxf`, type: 'curves_2d', format: 'dxf', loaded: true, loopsVersion: 1,
    boundingBox: bbox(min, max), position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    stockId: STOCK_ID, stockIdLocked: true,
    loops: [{ layerId: 'L1', ...loop }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

function installProject(): void {
  const ringPoints = Array.from({ length: 180 }, (_, k) => ({
    x: RING.x + RING.r * Math.cos(2 * Math.PI * k / 180), y: RING.y + RING.r * Math.sin(2 * Math.PI * k / 180),
  }))
  const line = curves('line-geo', 'Slot line',
    { id: 'line', closed: false, type: 'open', area: 0, points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] },
    { x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 })
  const ring = curves('ring-geo', 'Slot ring',
    { id: 'ring', closed: true, type: 'contour', area: Math.PI * RING.r * RING.r, points: ringPoints },
    { x: 10, y: 30, z: 0 }, { x: 70, y: 90, z: 0 })
  const stock = {
    id: STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -20, y: -20, z: 0 }, { x: 90, y: 110, z: 12 }), position: { x: -20, y: -20, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: SETUP_1, name: 'Setup 1', notes: '', holdingMethod: 'screws',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { ...WCS },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId: STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [],
  } as unknown as Setup
  const project = {
    ...useCamStore.getState().project, id: 'project-wo3250', name: 'WO-3250', machine: makeMachine(),
    geometry: [line, ring], stocks: [stock], setups: [setup],
    activeSetupId: SETUP_1, activeOperationId: null, nests: [],
  } as unknown as Project
  act(() => {
    useCamStore.setState({
      project, toolLibrary: [END_MILL], toolpathBatch: null, consoleEvents: [],
      modelRefsVerifiedSinceLoad: true, activeModal: null,
    } as never)
  })
}

// ── The worker wire: real toolpathWorker.ts, in-process, one request at a time ──

let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerQueue: Promise<void> = Promise.resolve()
let realSelf: unknown

beforeAll(async () => {
  realSelf = (globalThis as { self?: unknown }).self
  Object.defineProperty(globalThis, 'self', {
    value: {
      postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
      onmessage: null,
      location: window.location,
    },
    configurable: true, writable: true,
  })
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  Object.defineProperty(globalThis, 'self', { value: realSelf, configurable: true, writable: true })
})

beforeEach(() => {
  workerQueue = Promise.resolve()
  activeShim = null
  mem.clear()
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerQueue = workerQueue.then(async () => {
        activeShim = this
        await workerSelf.onmessage!({ data })
      })
    }
    terminate(): void { /* no thread */ }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  installProject()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  act(() => { useCamStore.getState().closeModal(); useCamStore.setState({ toolpathBatch: null }) })
})

const ops = () => useCamStore.getState().project.setups.find(s => s.id === SETUP_1)!.operations
const opNamed = (name: string) => ops().find(o => o.name === name)!

async function settle(): Promise<void> {
  await vi.waitFor(() => expect(useCamStore.getState().toolpathBatch).toBeNull(), { timeout: 30_000 })
  await act(async () => { await workerQueue })
}

async function generate(opId: string): Promise<void> {
  await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_1, opId) })
  await settle()
}

function setNumber(label: string, value: string): void {
  const input = screen.getByText(label).closest('.op-field-row')!.querySelector('input')!
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

interface Authoring {
  route: 'slot' | 'engrave'
  name: string
  geometryId: string
  trochoidalWidth?: string
}

/** Add operation through the dialog, the way the operator does it. */
async function author(a: Authoring): Promise<Operation> {
  const before = ops().length
  act(() => useCamStore.getState().openModal('new-operation'))
  if (a.route === 'slot') {
    expect(screen.queryByTestId('op-type-slot')).not.toBeNull()
    fireEvent.click(screen.getByTestId('op-type-slot'))
  } else {
    fireEvent.click(screen.getByText('Engrave / Trace'))
  }
  const name = screen.getByText('Operation name').nextElementSibling as HTMLInputElement
  fireEvent.change(name, { target: { value: a.name } })
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(END_MILL.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: a.geometryId } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  fireEvent.click(screen.getByText('Passes'))
  if (a.route === 'engrave') fireEvent.click(screen.getByText('Trace'))
  if (a.trochoidalWidth !== undefined) {
    fireEvent.change(screen.getByTestId('engrave-style'), { target: { value: 'trochoidal' } })
    setNumber('Slot width', a.trochoidalWidth)
  }
  setNumber('Stepdown', '2')
  fireEvent.click(screen.getByText('Heights'))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Top Height height' }))
  await waitFor(() => expect(screen.getByTestId('engrave-height-policy')).not.toBeNull())
  setNumber('Engraving depth', '6')
  await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false), { timeout: 20_000 })
  fireEvent.click(screen.getByTestId('op-create'))
  expect(ops()).toHaveLength(before + 1)
  await settle()
  const op = opNamed(a.name)
  if (op.status !== 'ready') await generate(op.id)
  expect([opNamed(a.name).status, opNamed(a.name).errorMessage]).toEqual(['ready', undefined])
  return opNamed(a.name)
}

// ── Independent geometry: the cutter's swept disc along its own centre path ──

type P = { x: number; y: number }
/** The tool-centre segments the cutter feeds along at the floor. */
function floorSegments(moves: ToolpathMove[], floorZ: number): Array<[P, P]> {
  const segs: Array<[P, P]> = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type === 'rapid') continue
    if (Math.abs(a.z - floorZ) > 1e-6 || Math.abs(b.z - floorZ) > 1e-6) continue
    segs.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }])
  }
  return segs
}

/** Grid cells (side h) whose centre is within R of a floor segment. */
function sweptCells(segs: Array<[P, P]>, h: number, box: { x0: number; y0: number; x1: number; y1: number }) {
  const nx = Math.ceil((box.x1 - box.x0) / h), ny = Math.ceil((box.y1 - box.y0) / h)
  const cut = new Uint8Array(nx * ny)
  for (const [a, b] of segs) {
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - R - box.x0) / h))
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + R - box.x0) / h))
    const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - R - box.y0) / h))
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(a.y, b.y) + R - box.y0) / h))
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy
    for (let j = j0; j <= j1; j++) {
      const py = box.y0 + (j + 0.5) * h
      for (let i = i0; i <= i1; i++) {
        if (cut[j * nx + i]) continue
        const px = box.x0 + (i + 0.5) * h
        const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2))
        if (Math.hypot(a.x + u * dx - px, a.y + u * dy - py) <= R) cut[j * nx + i] = 1
      }
    }
  }
  return {
    area: cut.reduce((n, c) => n + c, 0) * h * h,
    isCut: (p: P) => {
      const i = Math.floor((p.x - box.x0) / h), j = Math.floor((p.y - box.y0) / h)
      return i >= 0 && j >= 0 && i < nx && j < ny && cut[j * nx + i] === 1
    },
  }
}

/** The swept outline of a centre path is its centre bounds grown by R. */
function sweptBounds(segs: Array<[P, P]>) {
  const pts = segs.flat()
  return {
    x0: Math.min(...pts.map(p => p.x)) - R, x1: Math.max(...pts.map(p => p.x)) + R,
    y0: Math.min(...pts.map(p => p.y)) - R, y1: Math.max(...pts.map(p => p.y)) + R,
  }
}

const FLOOR = WCS.z - 6
/** One orbit's chords stay within 0.0022 D of the circle (WO-2289's sampler bound). */
const SAGITTA = 0.0022 * D

/** Post Process Export for the named operations only (stage, post, restore). */
async function postOnly(names: string[]): Promise<string> {
  const ids = names.map(n => opNamed(n).id)
  await useCamStore.getState().verifyModelReferences()
  const staged = await useCamStore.getState().stageOperationsForEmission(SETUP_1, ids)
  try {
    const state = useCamStore.getState()
    const project = { ...state.project, toolLibrary: state.toolLibrary }
    const live = project.setups.find(s => s.id === SETUP_1)!
    const result = post.postProject(project, [live], post.GRBL_CONFIG, {
      mode: 'separate', pauseBetweenSetups: false, baseName: project.name, ext: 'nc',
      modelRefsVerifiedSinceLoad: state.modelRefsVerifiedSinceLoad, programContext: true,
    })
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    return result.files![0].result.gcode
  } finally {
    staged.restore()
  }
}

/** The Z levels the program cuts flat at below the stock top (WCS), read back by
 *  parseGcode: feeds and arcs that hold one Z, so a helix entry is not a level. */
function postedCutZs(gcode: string): number[] {
  const zs = new Set<number>()
  for (const segment of parseGcode(gcode).segments) {
    if (segment.kind === 'rapid' || segment.to.z >= 0 || Math.abs(segment.from.z - segment.to.z) > 1e-9) continue
    zs.add(Math.round(segment.to.z * 1000) / 1000)
  }
  return [...zs].sort((a, b) => b - a)
}

describe('WO-3250 Slot (centerline): Create, Generate, Post', () => {
  it('a Plain slot on the line cuts the 6 mm capsule to -6 in levels -2/-4/-6, and moves and posted bytes equal the hand-authored Engrave', async () => {
    render(<NewOperationModal />)
    const slot = await author({ route: 'slot', name: 'Slot', geometryId: 'line-geo' })
    const hand = await author({ route: 'engrave', name: 'Hand trace', geometryId: 'line-geo' })
    expect(slot.type).toBe('engrave')
    expect(slot.params).toEqual(hand.params)
    expect(slot.toolpathMoves).toEqual(hand.toolpathMoves)

    const moves = slot.toolpathMoves!
    expect(Math.min(...moves.map(m => m.z))).toBeCloseTo(FLOOR, 9)
    const levels = [...new Set(moves.filter(m => m.type !== 'rapid' && m.z < WCS.z - 1e-6).map(m => Math.round((m.z - WCS.z) * 1e6) / 1e6))]
    expect(levels.sort((a, b) => b - a)).toEqual([-2, -4, -6])

    const segs = floorSegments(moves, FLOOR)
    expect(segs.length).toBeGreaterThan(0)
    const b = sweptBounds(segs)
    expect([b.x0, b.x1, b.y0, b.y1].map(v => Math.round(v * 1e6) / 1e6)).toEqual([-3, 43, -3, 3])
    const swept = sweptCells(segs, 0.05, { x0: -5, y0: -5, x1: 45, y1: 5 })
    expect(Math.abs(swept.area - 268.2743339) / 268.2743339).toBeLessThan(0.005)
    // 0.15 mm inside the walls and the round ends is cut; 0.15 mm outside is not.
    for (const p of [{ x: 20, y: 2.85 }, { x: 20, y: -2.85 }, { x: -2.85, y: 0 }, { x: 42.85, y: 0 }]) expect(swept.isCut(p)).toBe(true)
    for (const p of [{ x: 20, y: 3.15 }, { x: 20, y: -3.15 }, { x: -3.15, y: 0 }, { x: 43.15, y: 0 }]) expect(swept.isCut(p)).toBe(false)

    const slotProgram = await postOnly(['Slot'])
    const handProgram = await postOnly(['Hand trace'])
    expect(postedCutZs(slotProgram)).toEqual([-2, -4, -6])
    // Byte for byte the same program, apart from the operation-name comment and
    // the LCX1 provenance trailer (it carries each operation's own id, name and
    // generation time), compared separately.
    const motion = (gcode: string, name: string) => gcode.split('\n')
      .filter(line => !line.includes(name) && !line.startsWith('( LCX1 ')).join('\n')
    expect(slotProgram).toMatch(/\(.*Slot.*\)/)
    expect(handProgram).toMatch(/\(.*Hand trace.*\)/)
    expect(motion(slotProgram, 'Slot')).toEqual(motion(handProgram, 'Hand trace'))
    expect(slotProgram.split('\n').filter(line => line.includes('Slot') && !line.startsWith('( LCX1 ')).map(line => line.replace('Slot', 'Hand trace')))
      .toEqual(handProgram.split('\n').filter(line => line.includes('Hand trace') && !line.startsWith('( LCX1 ')))
  }, 120_000)

  it('a Trochoidal 9 mm slot cuts the 9 mm capsule on 1.5 mm orbits; around a closed R30 circle the annulus 25.5..34.5 with no seam ridge', async () => {
    render(<NewOperationModal />)
    const wide = await author({ route: 'slot', name: 'Wide slot', geometryId: 'line-geo', trochoidalWidth: '9' })
    // 9 is 1.5 D, the width an unset Slot width follows, so the field keeps it unset.
    expect(wide.params).toMatchObject({ mode: 'trace', side: 'center', engraveStyle: 'trochoidal' })
    const segs = floorSegments(wide.toolpathMoves!, FLOOR)
    const centres = segs.flat()
    // Orbit radius (W - D) / 2 = 1.5: the centre never leaves the band |y| <= 1.5.
    expect(Math.max(...centres.map(p => Math.abs(p.y)))).toBeGreaterThan(1.5 - SAGITTA)
    expect(Math.max(...centres.map(p => Math.abs(p.y)))).toBeLessThanOrEqual(1.5 + 1e-6)
    const b = sweptBounds(segs)
    const tol = 0.05
    expect(Math.abs(b.x0 - -4.5)).toBeLessThan(tol)
    expect(Math.abs(b.x1 - 44.5)).toBeLessThan(tol)
    expect(Math.abs(b.y0 - -4.5)).toBeLessThan(tol)
    expect(Math.abs(b.y1 - 4.5)).toBeLessThan(tol)
    const swept = sweptCells(segs, 0.05, { x0: -6, y0: -6, x1: 46, y1: 6 })
    expect(Math.abs(swept.area - 423.6172512) / 423.6172512).toBeLessThan(0.005)
    for (const p of [{ x: 20, y: 4.35 }, { x: 20, y: -4.35 }, { x: -4.35, y: 0 }, { x: 44.35, y: 0 }]) expect(swept.isCut(p)).toBe(true)
    for (const p of [{ x: 20, y: 4.65 }, { x: 20, y: -4.65 }, { x: -4.65, y: 0 }, { x: 44.65, y: 0 }]) expect(swept.isCut(p)).toBe(false)
    expect(postedCutZs(await postOnly(['Wide slot']))).toEqual([-2, -4, -6])

    const ring = await author({ route: 'slot', name: 'Ring slot', geometryId: 'ring-geo', trochoidalWidth: '9' })
    const ringSegs = floorSegments(ring.toolpathMoves!, FLOOR)
    const radii = ringSegs.flat().map(p => Math.hypot(p.x - RING.x, p.y - RING.y))
    expect(Math.abs(Math.min(...radii) - R - 25.5)).toBeLessThan(tol)
    expect(Math.abs(Math.max(...radii) + R - 34.5)).toBeLessThan(tol)
    const ringSwept = sweptCells(ringSegs, 0.1, { x0: 0, y0: 20, x1: 80, y1: 100 })
    // Every 1 degree round the ring, through the seam: the whole band 25.65..34.35
    // is cut, and nothing at 25.35 or 34.65; the disc inside the ring stays.
    for (let deg = 0; deg < 360; deg++) {
      const a = deg * Math.PI / 180
      const at = (r: number) => ({ x: RING.x + r * Math.cos(a), y: RING.y + r * Math.sin(a) })
      for (let r = 25.65; r <= 34.35 + 1e-9; r += 0.3) expect(ringSwept.isCut(at(r)), `${deg} deg r ${r.toFixed(2)}`).toBe(true)
      expect(ringSwept.isCut(at(25.35))).toBe(false)
      expect(ringSwept.isCut(at(34.65))).toBe(false)
    }
    expect(ringSwept.isCut({ x: RING.x, y: RING.y })).toBe(false)
  }, 180_000)

  it('undo and redo remove and restore it; it saves and reopens as an ordinary Engrave and regenerates the same moves', async () => {
    render(<NewOperationModal />)
    const history = () => useCamStore.getState().projectHistory.length
    const h0 = history()
    const slot = await author({ route: 'slot', name: 'Slot', geometryId: 'line-geo' })
    const moves = structuredClone(slot.toolpathMoves)
    // The shortcut's Create is the ordinary add (plus the generation that
    // follows it): the same history steps as a hand-authored Engrave.
    const steps = history() - h0
    expect(steps).toBeGreaterThan(0)
    const h1 = history()
    await author({ route: 'engrave', name: 'Hand trace', geometryId: 'line-geo' })
    expect(history() - h1).toBe(steps)

    for (let i = 0; i < steps * 2; i++) act(() => useCamStore.getState().undo())
    expect(ops()).toEqual([])
    for (let i = 0; i < steps; i++) act(() => useCamStore.getState().redo())
    expect(ops().map(o => o.name)).toEqual(['Slot'])
    expect(opNamed('Slot').type).toBe('engrave')
    expect(opNamed('Slot').params).toEqual(slot.params)

    const saved = await snapshotCurrentProjectFile()
    expect(saved).not.toBeNull()
    await act(async () => { await useCamStore.getState().loadProjectFromFile(saved!) })
    useCamStore.setState(s => s.toolLibrary.some(t => t.id === END_MILL.id) ? {} : { toolLibrary: [...s.toolLibrary, END_MILL] })
    const reopened = opNamed('Slot')
    expect(reopened.type).toBe('engrave')
    expect(reopened.params).toEqual(slot.params)
    expect(reopened.smartHeight).toEqual(slot.smartHeight)
    await generate(reopened.id)
    expect(opNamed('Slot').toolpathMoves).toEqual(moves)
  }, 120_000)
})

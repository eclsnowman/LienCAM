// @vitest-environment jsdom
//
// WO-2253: Form - Pipe along edges picked on a body. A click off the cage goes on to the session
// (FormInteraction host.bodyEdgeClick); the page says which body edge is under it (bodyEdgeAt) and hands
// Form the picked edges' polylines (bodyEdgePolylines). Pipe chains them end to end and builds its tube
// cage along the longest connected chain, saying so in one console line when the picks do not all
// connect. Pipe along a sketch is unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { act, cleanup, renderHook } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { useFormSession, type FormSessionDeps } from '../../components/model3d/form/useFormSession'
import { FormInteraction, type FormInteractionHost } from '../../components/model3d/form/formInteraction'
import type { FormOverlay } from '../../form/formOverlay'
import { hiddenBySkin, type CagePick } from '../../form/pick'
import type { TransformControlsAdapter } from '../../components/model3d/gizmos/TransformControlsAdapter'
import { useFormStore } from '../../form/formStore'
import { validateCage } from '../../form/halfEdge'
import { longestEdgeChain } from '../../form/edgePath'
import { pathLength, type SketchPath } from '../../form/pipe'
import type { Vec3 } from '../../form/cage'

// three edges of a 40 x 24 x 16 block from (-20, -12, 0): along the front, up the corner, back along the top
// (given out of order and each any way round, as picks come)
const front: Vec3[] = [[-20, -12, 0], [0, -12, 0], [20, -12, 0]]
const corner: Vec3[] = [[20, -12, 16], [20, -12, 0]]
const topSide: Vec3[] = [[20, -12, 16], [20, 12, 16]]
const farEdge: Vec3[] = [[-20, 12, 0], [-20, 12, 16]]

function distToPolyline(p: Vec3, path: readonly Vec3[]): number {
  let best = Infinity
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)))
    best = Math.min(best, Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t))
  }
  return best
}

/** Each ring's centre (8 cage points round the path per ring). */
function ringCentres(): Vec3[] {
  const P = useFormStore.getState().cage.positions
  const out: Vec3[] = []
  for (let i = 0; i + 8 <= P.length; i += 8) {
    const ring = P.slice(i, i + 8)
    out.push([0, 1, 2].map((c) => ring.reduce((s, q) => s + q[c], 0) / 8) as Vec3)
  }
  return out
}

/** A stand-in view: body edge i of Block lies under page x = 100 + 10 i; anywhere else is off the body. */
function mount(edges: Vec3[][], extra: Partial<FormSessionDeps> = {}) {
  const dag = new FeatureDag()
  const shown = vi.fn()
  const deps: FormSessionDeps = {
    runtime: null, canvasRef: { current: null }, dag, history: new CommandHistory(dag), onApplied: vi.fn(), showBody: vi.fn(),
    bodyEdgeAt: (x) => { const i = (x - 100) / 10; return Number.isInteger(i) && i >= 0 && i < edges.length ? { bodyId: 'BLK', edgeId: `e${i}`, point: edges[i][0] } : null },
    bodyEdgePolylines: (picks) => picks.length === 0 ? null : { name: `${picks.length} edge${picks.length === 1 ? '' : 's'} of Block`, polylines: picks.map((p) => edges[Number(p.edgeId.slice(1))]) },
    showBodyEdgePicks: shown,
    ...extra,
  }
  const { result } = renderHook(() => useFormSession(deps))
  act(() => result.current.open())
  const pipe = () => act(() => result.current.railSections.flatMap((s) => s.tools).find((t) => t.testId === 'form-starter-pipe')!.onClick())
  const click = (x: number, shift = false) => act(() => result.current.bodyEdgeClick!(x, 50, shift))
  /** plain click the first edge, Shift+click the rest */
  const pickAll = () => edges.forEach((_, i) => click(100 + 10 * i, i > 0))
  return { pipe, click, pickAll, shown, cancel: () => act(() => result.current.cancel()), session: () => result.current }
}

afterEach(() => {
  act(() => useFormStore.getState().closeSession())
  act(() => useFormStore.getState().setPipeRadius(0))
  cleanup()
})

describe('longestEdgeChain - picked edges joined end to end', () => {
  it('three connected edges, out of order and either way round, make one open path', () => {
    const c = longestEdgeChain([topSide, front, corner])!
    expect(c).not.toBeNull()
    expect(c.edges).toBe(3)
    expect(c.total).toBe(3)
    expect(c.path.closed).toBe(false)
    expect(pathLength(c.path)).toBeCloseTo(40 + 16 + 24, 9)
    const ends = [c.path.points[0], c.path.points[c.path.points.length - 1]].map((p) => p.join(','))
    expect(ends.sort()).toEqual(['-20,-12,0', '20,12,16'])
  })

  it('the four edges round a face close into a loop; a loop edge by itself is a closed path', () => {
    const top: Vec3[][] = [[[-20, -12, 16], [20, -12, 16]], [[20, 12, 16], [20, -12, 16]], [[20, 12, 16], [-20, 12, 16]], [[-20, -12, 16], [-20, 12, 16]]]
    const loop = longestEdgeChain(top)!
    expect(loop.path.closed).toBe(true)
    expect(loop.path.points).toHaveLength(4)
    expect(pathLength(loop.path)).toBeCloseTo(128, 9)
    const circle: Vec3[] = Array.from({ length: 25 }, (_, i) => [10 * Math.cos((i * Math.PI) / 12), 10 * Math.sin((i * Math.PI) / 12), 5] as Vec3)
    const ring = longestEdgeChain([circle])!
    expect(ring.path.closed).toBe(true)
    expect(ring.path.points).toHaveLength(24)
  })

  it('edges that do not all connect: the longest connected chain, with the counts', () => {
    const c = longestEdgeChain([front, farEdge, corner])!
    expect(c.edges).toBe(2)
    expect(c.total).toBe(3)
    expect(pathLength(c.path)).toBeCloseTo(56, 9)
    expect(longestEdgeChain([[[1, 2, 3], [1, 2, 3]]])).toBeNull()
  })
})

describe('Form - Pipe along picked body edges', () => {
  it('builds one tube cage along the picked edges, radius from the Pipe row', () => {
    const log = vi.fn()
    const { pipe, pickAll, shown } = mount([corner, topSide, front], { log })
    act(() => useFormStore.getState().setPipeRadius(3))
    const starter = useFormStore.getState().cage
    pickAll()
    expect(useFormStore.getState().notice).toMatch(/^3 body edges picked: Pipe runs along them/)
    expect(shown).toHaveBeenLastCalledWith([{ bodyId: 'BLK', edgeId: 'e0' }, { bodyId: 'BLK', edgeId: 'e1' }, { bodyId: 'BLK', edgeId: 'e2' }])
    // picking changes nothing of the cage
    expect(useFormStore.getState().cage).toBe(starter)
    pipe()
    const st = useFormStore.getState()
    expect(validateCage(st.cage, true).problems).toEqual([])
    expect(st.startedFrom).toBe('pipe')
    expect(st.notice).toMatch(/^Pipe along 3 edges of Block: 80\.0 mm, radius 3 mm$/)
    // every ring sits on the edges (its centre within a radius of them), and the rings reach both ends
    const path = longestEdgeChain([corner, topSide, front])!.path.points
    const centres = ringCentres()
    expect(centres.length).toBeGreaterThan(10)
    for (const c of centres) expect(distToPolyline(c, path)).toBeLessThan(3)
    expect(Math.min(...centres.map((c) => Math.hypot(c[0] + 20, c[1] + 12, c[2])))).toBeLessThan(1e-6)
    expect(Math.min(...centres.map((c) => Math.hypot(c[0] - 20, c[1] - 12, c[2] - 16)))).toBeLessThan(1e-6)
    // the cage spans the three edges' box, padded by about the radius
    const P = st.cage.positions
    const span = (k: number) => Math.max(...P.map((p) => p[k])) - Math.min(...P.map((p) => p[k]))
    expect(span(0)).toBeGreaterThan(40)
    expect(span(1)).toBeGreaterThan(24)
    expect(span(2)).toBeGreaterThan(16)
    expect(log).not.toHaveBeenCalled()
    // one undo step
    act(() => useFormStore.getState().undo())
    expect(useFormStore.getState().cage).toEqual(starter)
  })

  it('edges that do not connect: the longest chain, said in one console line', () => {
    const log = vi.fn()
    const { pipe, pickAll } = mount([front, farEdge, corner], { log })
    pickAll()
    pipe()
    const st = useFormStore.getState()
    expect(validateCage(st.cage, true).problems).toEqual([])
    expect(st.notice).toMatch(/^Pipe along 2 of 3 edges of Block: 56\.0 mm, radius \d+(\.\d+)? mm \(automatic/)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/^Pipe: the 3 picked edges do not all connect - built along the longest connected chain, 2 of them \(56\.0 mm\)$/)
    for (const c of ringCentres()) expect(distToPolyline(c, [...front, [20, -12, 16]])).toBeLessThan(5)
  })

  it('with no body edges picked, Pipe along a sketch builds exactly what it did before', () => {
    const sketch: SketchPath = { points: Array.from({ length: 13 }, (_, i) => [20 * Math.cos((i * Math.PI) / 12), 20 * Math.sin((i * Math.PI) / 12), 0] as Vec3), closed: false }
    const selectedSketchPath = () => ({ name: 'Arc', path: sketch })
    const before = mount([], { bodyEdgeAt: undefined, bodyEdgePolylines: undefined, showBodyEdgePicks: undefined, selectedSketchPath })
    before.pipe()
    const plain = useFormStore.getState()
    const cage = plain.cage, notice = plain.notice
    act(() => useFormStore.getState().closeSession())
    cleanup()
    const log = vi.fn()
    const after = mount([front], { selectedSketchPath, log })
    // a click off the body with nothing picked: no change at all
    after.click(0)
    expect(after.shown).not.toHaveBeenCalled()
    after.pipe()
    expect(useFormStore.getState().cage).toEqual(cage)
    expect(useFormStore.getState().notice).toBe(notice)
    expect(notice).toMatch(/^Pipe along Arc: /)
    expect(log).not.toHaveBeenCalled()
  })

  it('picked body edges come before the sketch selected in the tree', () => {
    const sketch: SketchPath = { points: [[0, 0, 50], [10, 0, 50]], closed: false }
    const { pipe, click, shown } = mount([front, corner], { selectedSketchPath: () => ({ name: 'Line', path: sketch }) })
    click(100)
    pipe()
    expect(useFormStore.getState().notice).toMatch(/^Pipe along 1 edge of Block: 40\.0 mm/)
    expect(Math.max(...useFormStore.getState().cage.positions.map((p) => p[2]))).toBeLessThan(10)
    // a click off the body clears the picks; Pipe follows the sketch again
    click(0)
    expect(shown).toHaveBeenLastCalledWith([])
    pipe()
    expect(useFormStore.getState().notice).toMatch(/^Pipe along Line: 10\.0 mm/)
  })

  it('Shift+click adds an edge or takes a picked one off; a plain click replaces; leaving form mode clears', () => {
    const { click, shown, cancel } = mount([front, corner, topSide])
    click(100)
    click(110, true)
    expect(shown).toHaveBeenLastCalledWith([{ bodyId: 'BLK', edgeId: 'e0' }, { bodyId: 'BLK', edgeId: 'e1' }])
    click(100, true)
    expect(shown).toHaveBeenLastCalledWith([{ bodyId: 'BLK', edgeId: 'e1' }])
    click(0, true)
    expect(shown).toHaveBeenCalledTimes(3)
    click(120)
    expect(shown).toHaveBeenLastCalledWith([{ bodyId: 'BLK', edgeId: 'e2' }])
    expect(useFormStore.getState().notice).toMatch(/^1 body edge picked: Pipe runs along it/)
    cancel()
    expect(shown).toHaveBeenLastCalledWith([])
  })

  it('a hit the skin hides is not taken; a miss over a cage face (clearOnMiss off) keeps the picks', () => {
    const { shown, session: current } = mount([front, corner])
    const session = (x: number, add: boolean, opts?: { clearOnMiss?: boolean; visible?: (w: Vec3) => boolean }) => {
      let took = false
      act(() => { took = current().bodyEdgeClick!(x, 50, add, opts) })
      return took
    }
    expect(session(100, false)).toBe(true)
    expect(session(110, true, { visible: () => false })).toBe(false)
    expect(shown).toHaveBeenLastCalledWith([{ bodyId: 'BLK', edgeId: 'e0' }])
    expect(session(0, false, { clearOnMiss: false })).toBe(false)
    expect(shown).toHaveBeenCalledTimes(1)
    expect(session(0, false)).toBe(false)
    expect(shown).toHaveBeenLastCalledWith([])
  })
})

describe('FormInteraction - a click on no cage point or edge goes on to the page (body edge pick)', () => {
  let cageUnder: CagePick | null = null
  let skinHides = false
  const overlay = { pickAt: () => cageUnder, hidesPoint: () => skinHides, mirrorHitAt: () => null, rayAt: () => ({ origin: [0, 0, 0], dir: [0, 1, 0] }), setHighlight: () => {} } as unknown as FormOverlay
  const adapter = () => ({
    object: undefined, enabled: true, axis: null,
    addEventListener: () => {}, removeEventListener: () => {}, attach: () => {}, detach: () => {},
    setMode: () => {}, setSpace: () => {}, getHelper: () => new THREE.Object3D(), dispose: () => {},
  }) as unknown as TransformControlsAdapter

  /** the page stand-in: a body edge lies under every click; it is taken when the skin does not hide it */
  function setup() {
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320, x: 10, y: 20 } as DOMRect)
    document.body.appendChild(canvas)
    const clicks: Array<[number, number, boolean, boolean]> = []
    const host: FormInteractionHost = {
      canvas, camera: () => new THREE.PerspectiveCamera(), addObject: () => {}, removeObject: () => {}, requestRender: () => {}, setOrbitEnabled: () => {},
      bodyEdgeClick: (x, y, add, opts) => { clicks.push([x, y, add, opts.clearOnMiss]); return opts.visible([0, 0, 0]) },
    }
    useFormStore.getState().openSession({ featureId: null, name: 'F' })
    const interaction = new FormInteraction(host, overlay, adapter)
    const click = (x: number, y: number, shift = false) => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0, buttons: 1, shiftKey: shift, bubbles: true }))
      canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y, button: 0, buttons: 0, shiftKey: shift, bubbles: true }))
    }
    return { clicks, click, done: () => { interaction.dispose(); canvas.remove(); cageUnder = null; skinHides = false } }
  }

  it('off the cage: the page gets the click (page coordinates, Shift additive, a miss clears); the cage selection clears as before', () => {
    const { clicks, click, done } = setup()
    act(() => useFormStore.getState().select({ kind: 'point', index: 0 }, false))
    click(110, 120)
    click(130, 140, true)
    expect(clicks).toEqual([[110, 120, false, true], [130, 140, true, true]])
    expect(useFormStore.getState().selection.points).toEqual([])
    done()
  })

  it('over a cage face: a body edge the skin does not hide wins; a hidden one leaves the click to the face', () => {
    const { clicks, click, done } = setup()
    cageUnder = { kind: 'face', index: 0 }
    click(150, 160)
    expect(clicks).toEqual([[150, 160, false, false]])
    expect(useFormStore.getState().selection.faces).toEqual([])
    skinHides = true
    click(150, 160)
    expect(useFormStore.getState().selection.faces).toEqual([0])
    done()
  })

  it('on a cage point or cage edge the click stays with the cage (the page is not asked)', () => {
    const { clicks, click, done } = setup()
    cageUnder = { kind: 'point', index: 2 }
    click(150, 160)
    cageUnder = { kind: 'edge', key: '0:1' }
    click(150, 160, true)
    expect(clicks).toEqual([])
    expect(useFormStore.getState().selection.points).toEqual([2])
    expect(useFormStore.getState().selection.edges).toEqual(['0:1'])
    done()
  })
})

describe('hiddenBySkin - the smooth skin hides what is behind it from the pointer', () => {
  it('a point behind a shown surface is hidden; in front of it, or with the surface hidden, it is not', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000)
    camera.position.set(0, 0, 100)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    sheet.updateMatrixWorld(true)
    expect(hiddenBySkin(camera, 200, 200, 100, 100, sheet, [0, 0, -10], 0.5)).toBe(true)
    expect(hiddenBySkin(camera, 200, 200, 100, 100, sheet, [0, 0, 10], 0.5)).toBe(false)
    expect(hiddenBySkin(camera, 200, 200, 100, 100, sheet, [0, 0, -0.2], 0.5)).toBe(false)
    sheet.visible = false
    expect(hiddenBySkin(camera, 200, 200, 100, 100, sheet, [0, 0, -10], 0.5)).toBe(false)
    expect(hiddenBySkin(camera, 200, 200, 100, 100, null, [0, 0, -10], 0.5)).toBe(false)
  })
})

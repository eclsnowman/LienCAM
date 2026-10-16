// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { SketchDimensionOverlay } from '../../lib/sketch/sketcher/overlays/SketchDimensionOverlay'
import type { SketcherOverlaysPort } from '../../lib/sketch/sketcher/overlays/port'
import { sketcherToolStore } from '../../lib/sketch/sketcher/toolStore'
import type { Sketch, Vec2 } from '../../lib/sketch/types'
import * as THREE from 'three'
import { createCamOverlaysPort } from '../../components/viewport/camOverlaysPort'
import { createWorkbenchOverlaySurface } from '../../components/model3d/workbench/workbenchOverlaysPort'
import { useCamStore } from '../../store'
import type { ImportedGeometry } from '../../types'
import { SketchOverlayPainter } from '../../lib/sketch/sketcher/overlayPainter'
import { toolOverlay } from '../../lib/sketch/tools/toolOverlay'

const fixture = (): Sketch => ({ id: 's', layerId: 'l', constraints: [], solveStatus: null,
  entities: [
    { id: 'v', kind: 'line', construction: false, start: { x: 10, y: 10 }, end: { x: 10, y: 60 } },
    { id: 'h', kind: 'line', construction: false, start: { x: 10, y: 10 }, end: { x: 60, y: 10 } },
    { id: 'c', kind: 'circle', construction: false, center: { x: 15.63, y: 30 }, radius: 2.125 },
  ], dimensions: [],
})
let sketch: Sketch | null, active: boolean, editor: { dimId: string; isNew: boolean } | null
let cursor: Vec2 | null, scale: number, width: number, height: number
let frames: Map<number, FrameRequestCallback>, nextFrame: number
const port = {
  useSketch: () => sketch, useIsSketchActive: () => active, useSelectedIds: () => [],
  useDimEditor: () => editor, useDisplayUnits: () => 'mm', getSketch: () => sketch,
  getDisplayUnits: () => 'mm', getSurface: () => ({
    worldToScreen: (x: number, y: number) => ({ x: x * scale, y: y * scale }),
    getLastSketchCursor: () => cursor,
  }), closeDimensionEditor: vi.fn(), commitDimensionValue: vi.fn(), toggleDimensionDriving: vi.fn(),
} as unknown as SketcherOverlaysPort
const rect = (x: number, y: number, w: number, h: number) => ({
  x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h,
  toJSON: () => ({}),
}) as DOMRect
function frame() {
  act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(f => f(0)) })
}
function operands(ids: unknown[], forceMode?: string) {
  act(() => sketcherToolStore.setState({ tool: 'smart-dimension',
    chain: { kind: 'dim', operandIds: ids, forceMode } as never }))
}
function mount(at = { x: 18, y: 40 }, host = port) {
  cursor = at
  const result = render(<SketchDimensionOverlay port={host} />)
  const move = () => { fireEvent.pointerMove(window, { clientX: 100 + at.x * scale, clientY: 50 + at.y * scale }); frame() }
  move()
  return { ...result, move, refresh: () => { result.rerender(<SketchDimensionOverlay port={host} />); frame() } }
}
function line(container: HTMLElement) {
  const el = container.querySelector('.sketch-dim-preview-connector line') as SVGElement | null
  expect(el, 'valid resolved preview needs the approved passive connector').not.toBeNull()
  expect(el!.style.display).not.toBe('none')
  return el!
}
const n = (el: SVGElement, attr: string) => Number(el.getAttribute(attr))

beforeEach(() => {
  sketch = fixture(); active = true; editor = null; cursor = null; scale = 10; width = 100; height = 20
  frames = new Map(); nextFrame = 0
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++nextFrame, cb); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  // jsdom has no layout. Model only the existing badge's CSS translation and measured size;
  // production resolver, overlay effects and tool store are real.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('sketch-dim-layer')) return rect(100, 50, 800, 600)
    if (this.classList.contains('sketch-dim-preview')) {
      const m = (this as HTMLElement).style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)!
      return rect(100 + Number(m[1]), 50 + Number(m[2]), width, height)
    }
    return rect(0, 0, 0, 0)
  })
  sketcherToolStore.setState({ tool: 'select', chain: null })
})

describe('WO-2748 connector host display projection', () => {
  let saved: ReturnType<typeof useCamStore.getState>
  beforeEach(() => { saved = useCamStore.getState() })
  afterEach(() => { useCamStore.setState(saved, true) })
  const owner = (nest = true): ImportedGeometry => ({ id: 'seed',
    ...(nest ? { ownerNestId: 'nest' } : {}), layers2d: [{ id: 'l' }],
    position: { x: 70, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 90 },
  }) as ImportedGeometry
  function cam(geometry: ImportedGeometry[]) {
    useCamStore.setState({ activeSketch: sketch, sketchSelectedIds: [], sketchDimEditor: null,
      viewer: { ...saved.viewer, mode: 'sketch' },
      appSettings: { ...saved.appSettings, displayUnits: 'mm' },
      project: { ...saved.project, geometry } })
    return createCamOverlaysPort(port.getSurface)
  }
  function carrierEndpoint(pose: { x: number; y: number; rotationDeg: number }) {
    const root = new THREE.Group(), painter = new SketchOverlayPainter(root, () => 0.1)
    painter.setOffset(pose)
    painter.setToolOverlayDisplay(toolOverlay({ tool: 'smart-dimension',
      chain: { kind: 'dim', operandIds: [{ entityId: 'c', site: 'center' }, 'v'] } },
      cursor!, 0.8, { entities: sketch!.entities }))
    root.updateMatrixWorld(true)
    const guides: THREE.Line[] = []
    root.traverse(o => { if (o instanceof THREE.Line) guides.push(o) })
    // Actual distancePL measurement bar buffer, posed by the production painter.
    const bar = guides[2], positions = bar.geometry.getAttribute('position')
    const ends = [0, 1].map(i => bar.localToWorld(new THREE.Vector3(positions.getX(i), positions.getY(i), positions.getZ(i))))
    // With this 90 deg fixture and the unchanged badge below it, the higher Y
    // endpoint is the nearest point on the displayed vertical measurement bar.
    const p = ends[0].y > ends[1].y ? ends[0] : ends[1]
    painter.dispose()
    return { x: p.x * scale, y: p.y * scale }
  }
  it('attaches to the actual translated AND rotated CAM preview carrier', () => {
    operands([{ entityId: 'c', site: 'center' }, 'v'])
    const h = mount(undefined, cam([owner()])), l = line(h.container)
    const p = carrierEndpoint({ x: 70, y: 0, rotationDeg: 90 })
    expect(n(l, 'x1')).toBeCloseTo(p.x, 4); expect(n(l, 'y1')).toBeCloseTo(p.y, 4)
    expect(h.container.querySelector('.sketch-dim-preview')?.getAttribute('style')).toContain('translate(194.0px, 414.0px)')
    expect(h.container.querySelector('.sketch-dim-preview-value')?.textContent).toBe('5.63')
    // Same pointer/chain, live host pose changes: no pointer event or remount.
    const seed = owner(); seed.position.x = 74
    act(() => useCamStore.setState({ project: { ...saved.project, geometry: [seed] } }))
    frame()
    const next = carrierEndpoint({ x: 74, y: 0, rotationDeg: 90 })
    expect(n(l, 'x1')).toBeCloseTo(next.x, 4); expect(n(l, 'y1')).toBeCloseTo(next.y, 4)
  })
  // WO-2854 (237b9369bb): every CAM owner draws its open sketch at the part's
  // own pose, not only nest seeds; only a layer no part holds stays at identity.
  it.each(['ordinary', 'ad-hoc'])('attaches to the owning part\'s pose for %s CAM sketches', route => {
    operands([{ entityId: 'c', site: 'center' }, 'v'])
    const geometry = [owner(false)]
    if (route === 'ad-hoc') geometry[0].id = '__sketch_container__'
    const h = mount(undefined, cam(geometry)), l = line(h.container)
    const p = carrierEndpoint({ x: 70, y: 0, rotationDeg: 90 })
    expect(n(l, 'x1')).toBeCloseTo(p.x, 4); expect(n(l, 'y1')).toBeCloseTo(p.y, 4)
  })
  it('retains identity projection for missing-owner CAM sketches', () => {
    operands([{ entityId: 'c', site: 'center' }, 'v'])
    const h = mount(undefined, cam([])), l = line(h.container)
    expect(n(l, 'x1')).toBeCloseTo(156.3); expect(n(l, 'y1')).toBe(400)
    expect(n(l, 'x2')).toBe(194); expect(n(l, 'y2')).toBe(424)
  })
  it('uses the workbench plane projection once, including its host gutter', () => {
    operands([{ entityId: 'c', site: 'center' }, 'v'])
    const canvas = document.createElement('canvas'), container = document.createElement('div')
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect(105, 55, 800, 600))
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(100, 50, 800, 600))
    const surface = createWorkbenchOverlaySurface({ canvas, container,
      getFrame: () => ({ origin: { x: 30, y: 0, z: 9 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } }),
      getLastCursor: () => cursor,
      runtime: { projectToCanvas: (p: THREE.Vector3) => ({ x: p.x * scale, y: p.z * scale }) } as never })
    const h = mount(undefined, { ...port, getSurface: () => surface }), l = line(h.container)
    // Nearest bar end: (10, 40) -> (40, 0, 49); canvas gutter adds (5, 5).
    expect(n(l, 'x1')).toBe(405); expect(n(l, 'y1')).toBe(495)
    expect(h.container.querySelector('.sketch-dim-preview')?.getAttribute('style')).toContain('translate(194.0px, 414.0px)')
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('WO-2748 active dimension readout connector through the mounted overlay', () => {
  it('joins the short perpendicular bar endpoint to the nearest badge boundary and preserves +14 px', () => {
    operands([{ entityId: 'c', site: 'center' }, 'v'])
    const { container } = mount()
    const l = line(container)
    expect(n(l, 'x1')).toBeCloseTo(156.3); expect(n(l, 'y1')).toBeCloseTo(400)
    expect(n(l, 'x2')).toBeCloseTo(194); expect(n(l, 'y2')).toBeCloseTo(424)
    expect(container.querySelector('.sketch-dim-preview')?.getAttribute('style')).toContain('translate(194.0px, 414.0px)')
    expect(container.querySelector('.sketch-dim-preview-value')?.textContent).toBe('5.63')
    expect(container.querySelector('.sketch-dim-preview-mode')?.textContent).toBe('Perpendicular')
    const svg = container.querySelector('.sketch-dim-preview-connector') as SVGElement
    expect(svg.style.pointerEvents).toBe('none'); expect(svg.style.overflow).toBe('hidden')
    expect(l.getAttribute('stroke-width')).toBe('1')
    expect(l.hasAttribute('marker-end')).toBe(false)
    expect(container.querySelectorAll('.sketch-dim-preview-connector line')).toHaveLength(1)
    expect(sketch!.dimensions).toEqual([])
  })
  it('connects the diameter leader, retains D4.25 and its clamped placement', () => {
    operands(['c'])
    const { container } = mount({ x: 25, y: 36 })
    const l = line(container)
    // Radial attachment + the existing 0.35 x diameter placement band.
    const span = 2.125 + 0.35 * 4.25, len = Math.hypot(25 - 15.63, 6)
    expect(n(l, 'x1')).toBeCloseTo((15.63 + span * (25 - 15.63) / len) * 10)
    expect(n(l, 'y1')).toBeCloseTo((30 + span * 6 / len) * 10)
    expect(n(l, 'x2')).toBe(264); expect(n(l, 'y2')).toBe(384)
    expect(container.querySelector('.sketch-dim-preview-value')?.textContent).toContain('4.25')
    expect(container.querySelector('.sketch-dim-preview-mode')?.textContent).toBe('Diameter')
  })
  it('keeps the linear control value/orientation and connects its own horizontal bar', () => {
    operands(['h'])
    const { container } = mount({ x: 35, y: 5 })
    const l = line(container)
    expect(n(l, 'x1')).toBe(414); expect(n(l, 'y1')).toBe(50)
    expect(n(l, 'x2')).toBe(414); expect(n(l, 'y2')).toBe(64)
    expect(container.querySelector('.sketch-dim-preview-value')?.textContent).toBe('50.00')
  })
  it('refreshes on camera-only zoom, pointer motion and measured badge size changes', () => {
    operands([{ entityId: 'c', site: 'center' }, 'v'])
    const h = mount(), l = line(h.container)
    scale = 8; frame()
    expect(n(l, 'x1')).toBeCloseTo(125.04); expect(n(l, 'y1')).toBe(320)
    cursor = { x: 18, y: 45 }
    fireEvent.pointerMove(window, { clientX: 244, clientY: 410 }); frame()
    expect(n(l, 'y1')).toBe(360); expect(n(l, 'x2')).toBe(158)
    // Put the cursor left of the bar so the connector uses the badge's right edge.
    cursor = { x: 0, y: 40 }; fireEvent.pointerMove(window, { clientX: 100, clientY: 370 }); frame()
    width = 40; frame()
    expect(n(l, 'x2')).toBe(54)
    width = 60; frame(); expect(n(l, 'x2')).toBe(74)
  })
  it.each([{ ids: [] }, { ids: [{ entityId: 'c', site: 'center' }] }, { ids: ['missing'] }])('suppresses incomplete/invalid operands $ids', ({ ids }) => {
    operands(ids)
    const { container } = mount()
    const l = container.querySelector('.sketch-dim-preview-connector line') as SVGElement | null
    expect(!l || l.style.display === 'none').toBe(true)
  })
  it('hides with no cursor, no visible guide or a badge overlapping the bar', () => {
    operands(['h']); const h = mount({ x: 35, y: 5 }), l = line(h.container)
    cursor = null; frame(); expect(l.style.display).toBe('none')
    cursor = { x: 35, y: 5 }; scale = 1000; frame(); expect(l.style.display).toBe('none')
    scale = 10; width = 100; height = 20
    const badge = h.container.querySelector('.sketch-dim-preview') as HTMLElement
    badge.style.transform = 'translate(300px, 45px)'; frame()
    expect(l.style.display).toBe('none')
  })
  it.each(['placement', 'cancel', 'tool-switch', 'lost-selection', 'sketch-exit'])('removes on %s', route => {
    operands(['c']); const h = mount({ x: 25, y: 36 }); line(h.container)
    if (route === 'placement') {
      sketch!.dimensions = [{ id: 'd', kind: 'diameter', entityId: 'c', value: 4.25, driving: true, labelAnchor: { x: 20, y: 32 } }]
      editor = { dimId: 'd', isNew: true }
    } else if (route === 'cancel' || route === 'lost-selection') act(() => sketcherToolStore.setState({ chain: null }))
    else if (route === 'tool-switch') act(() => sketcherToolStore.setState({ tool: 'line', chain: null }))
    else active = false
    h.refresh()
    expect(h.container.querySelector('.sketch-dim-preview-connector')).toBeNull()
    if (route === 'placement') {
      const input = h.container.querySelector('.sketch-dim-editor') as HTMLElement
      expect(input.dataset.wx).toBe('20'); expect(input.dataset.wy).toBe('32')
      expect(input.style.transform).toBe('translate(200.0px, 320.0px) translate(-50%, -50%)')
      expect(h.container.querySelector('[data-dim-id="d"]')?.getAttribute('data-wx')).toBe('20')
    }
  })
  it('cancels animation work and pointer listener on unmount', () => {
    operands(['c']); const h = mount({ x: 25, y: 36 }); line(h.container)
    h.unmount(); expect(frames.size).toBe(0)
    fireEvent.pointerMove(window, { clientX: 1, clientY: 1 })
    expect(frames.size).toBe(0)
  })
})

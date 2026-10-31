// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { Sketcher, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import { SketchDrawValueInput } from '../../lib/sketch/sketcher/overlays/SketchDrawValueInput'
import type { SketcherHost } from '../../lib/sketch/sketcher/ports'
vi.stubGlobal('Worker', class { postMessage() {} terminate() {} })
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
const { camSketchDocumentPort, useCamStore } = await import('../../store')
const { createCamOverlaysPort } = await import('../../components/viewport/camOverlaysPort')
let sketcher: Sketcher, canvas: HTMLCanvasElement, root: HTMLDivElement, overlay: THREE.Group
const sk = () => useCamStore.getState().activeSketch!
const input = (name: string) => root.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)
function key(key: string, target: EventTarget = document.activeElement ?? window, extra: KeyboardEventInit = {}) {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })) })
}
function move(x = 20, y = 10) {
  act(() => { canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true })) })
}
function anchor(tool: 'rect-corner' | 'rect-center' = 'rect-corner') {
  act(() => { sketcherTools.armTool(tool); sketcherTools.click({ x: 0, y: 0 }, .1, null, false) })
  move()
}
function edit(name: string, value: string) {
  const el = input(name)!
  act(() => el.focus())
  fireEvent.input(el, { target: { value } })
}
function click(x: number, y: number, end = 'pointerup') {
  act(() => {
    canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent(end, { clientX: x, clientY: y, button: 0, bubbles: true }))
  })
}
beforeEach(() => {
  sketcherToolStore.__reset()
  useCamStore.setState(s => ({
    activeSketch: { id: 'wo3116', layerId: 'layer', entities: [], constraints: [], dimensions: [], solveStatus: null },
    sketchSelectedIds: [], sketchDimEditor: null, sketchHistory: [], sketchFuture: [],
    viewer: { ...s.viewer, mode: 'sketch' }, appSettings: { ...s.appSettings, displayUnits: 'mm' },
  }))
  root = document.createElement('div'); canvas = document.createElement('canvas')
  root.appendChild(canvas); document.body.appendChild(root)
  const host: SketcherHost = {
    domElement: canvas, container: root, overlayHost: root, overlayRoot: (overlay = new THREE.Group()),
    camera: new THREE.OrthographicCamera(), controls: { enableRotate: false },
    clientToPlaneWorld: (x, y) => ({ x, y }), worldPerPixel: () => .01,
    saveCameraPose: () => ({}), restoreCameraPose() {}, frameNormalToPlane() {},
  }
  sketcher = new Sketcher(host); sketcher.setDocumentPort(camSketchDocumentPort)
  sketcher.setUndoSink({ beginGesture: () => useCamStore.getState().pushHistory() }); sketcher.enter()
  render(<SketchDrawValueInput port={createCamOverlaysPort(() => ({
    worldToScreen: (x, y) => ({ x, y }), getLastSketchCursor: () => sketcher.getLastCursor(),
  }))} />, { container: root.appendChild(document.createElement('div')) })
})
afterEach(() => { act(() => sketcher.dispose()); cleanup(); root.remove() })
describe('WO-3116 rectangle creation entry', () => {
  it('captures 50 Tab 30 Enter as one rectangle and one history step', () => {
    anchor(); key('5', canvas)
    expect(input('Width'), 'anchored rectangle offers width entry').not.toBeNull()
    expect(document.activeElement).toBe(input('Width'))
    expect(input('Width')!.value).toBe('5')
    fireEvent.input(input('Width')!, { target: { value: '50' } }); key('Tab')
    expect(document.activeElement).toBe(input('Height'))
    expect(sk().entities).toHaveLength(0)
    fireEvent.input(input('Height')!, { target: { value: '30' } }); key('Enter')
    expect(sk().entities).toHaveLength(6)
    expect(sk().dimensions.map(d => d.value)).toEqual([50, 30])
    expect(useCamStore.getState().sketchHistory).toHaveLength(1)
    expect(sketcherToolStore.getState().chain).toBeNull()
    expect(sketcherToolStore.getState().tool).toBe('rect-corner')
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
  })
})

describe('creation entry boundaries', () => {
  it('W-only follows live H, field focus alone adds no H lock, and external blur commits once', () => {
    anchor(); edit('Width', '50'); key('Tab'); key('Tab', undefined, { shiftKey: true })
    expect(sk().entities).toHaveLength(0)
    act(() => input('Width')!.blur())
    expect(sk().dimensions.map(d => d.value)).toEqual([50])
    expect(useCamStore.getState().sketchHistory).toHaveLength(1)
  })
  it('H-only and mouse-only creation remain available', () => {
    anchor(); edit('Height', '30'); key('Enter')
    expect(sk().dimensions.map(d => d.value)).toEqual([30])
    click(80, 80); click(100, 100)
    expect(sk().entities).toHaveLength(12)
    expect(sk().dimensions).toHaveLength(1)
  })
  it('canvas placement defers blur and commits one shape, then the next click anchors', () => {
    anchor(); edit('Width', '50'); edit('Height', '30'); click(-40, -20)
    expect(sk().dimensions.map(d => d.value)).toEqual([50, 30])
    expect(sk().entities).toHaveLength(6)
    expect(sk().entities[0]).toMatchObject({ start: { x: 0, y: 0 }, end: { x: -50, y: 0 } })
    expect(sketcherToolStore.getState().chain).toBeNull()
    expect(useCamStore.getState().sketchHistory).toHaveLength(1)
    click(90, 90)
    expect(sketcherToolStore.getState().chain).toMatchObject({ anchor: { x: 90, y: 90 } })
    expect(sk().entities).toHaveLength(6)
  })
  it.each(['pointercancel', 'lostpointercapture'])('%s retains held sizes without committing', event => {
    anchor(); edit('Width', '50'); click(40, 20, event)
    expect(sk().entities).toHaveLength(0)
    click(40, 20)
    expect(sk().dimensions.map(d => d.value)).toEqual([50])
    expect(useCamStore.getState().sketchHistory).toHaveLength(1)
  })
  it.each(['', '-', '.', '0', '-2', 'garbage', 'Infinity', 'NaN'])('invalid %s cannot fall back to pointer placement', value => {
    anchor(); edit('Width', value); key('Tab')
    expect(document.activeElement).toBe(input('Width'))
    key('Enter'); click(40, 20)
    expect(sk().entities).toHaveLength(0)
    expect(useCamStore.getState().sketchHistory).toHaveLength(0)
    edit('Width', '12'); key('Enter')
    expect(sk().dimensions.map(d => d.value)).toEqual([12])
  })
  it('Escape drops both locks, retains anchor and does not poison the next blur', () => {
    anchor(); edit('Width', '50'); edit('Height', '30'); key('Escape')
    expect(sk().entities).toHaveLength(0)
    expect(sketcherToolStore.getState().chain).toMatchObject({ anchor: { x: 0, y: 0 } })
    edit('Width', '25'); act(() => input('Width')!.blur())
    expect(sk().dimensions.map(d => d.value)).toEqual([25])
  })
  it('uses full center extents and allows both typed at the anchor below pick tolerance', () => {
    anchor('rect-center'); move(0, 0); edit('Width', '.001'); edit('Height', '.002'); key('Enter')
    expect(sk().entities[0]).toMatchObject({ start: { x: -.0005, y: -.001 }, end: { x: .0005, y: -.001 } })
    expect(sk().dimensions.map(d => d.value)).toEqual([.001, .002])
  })
  it('converts active inches once and resets a group on unit change', () => {
    act(() => useCamStore.setState(s => ({ appSettings: { ...s.appSettings, displayUnits: 'inch' } })))
    anchor(); edit('Width', '2'); edit('Height', '1'); key('Enter')
    expect(sk().dimensions.map(d => d.value)).toEqual([50.8, 25.4])
    anchor(); edit('Width', '1')
    act(() => useCamStore.setState(s => ({ appSettings: { ...s.appSettings, displayUnits: 'mm' } })))
    click(20, 10)
    expect(sk().dimensions).toHaveLength(2)
  })
  it('resets on mode/tool switch and suspension, and hidden host cannot capture typing', () => {
    anchor(); edit('Width', '50'); act(() => sketcherTools.toggleRectRotated())
    expect(input('Width')).toBeNull()
    expect(sk().entities).toHaveLength(0)
    anchor(); edit('Width', '50'); act(() => sketcher.suspend())
    expect(input('Width')).toBeNull()
    key('2', canvas); expect(sk().entities).toHaveLength(0)
    act(() => sketcher.resume()); click(40, 20)
    expect(sk().dimensions).toHaveLength(0)
  })
  it('leaves foreign fields, modifier chords, unanchored and angled shortcuts alone', () => {
    anchor()
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      const el = document.createElement(tag); el.tabIndex = 0
      if (tag === 'div') el.setAttribute('contenteditable', 'true')
      root.appendChild(el); act(() => el.focus()); key('3', el)
      expect(sk().entities).toHaveLength(0)
      expect(document.activeElement).toBe(el)
    }
    act(() => (document.activeElement as HTMLElement).blur())
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) key('3', canvas, { [mod]: true })
    expect(sk().entities).toHaveLength(0)
    key('Tab', canvas)
    expect(sketcherToolStore.getState().chain).toMatchObject({ rotated: true })
    expect(input('Width')).toBeNull()
    act(() => sketcherTools.armTool('rect-corner')); key('2', canvas)
    expect(sketcherToolStore.getState().tool).toBe('pattern-circular')
  })
})

describe('shared preview and transient ownership', () => {
  it('repaints the actual rubber band immediately, holds typed W and follows H', () => {
    anchor(); edit('Width', '50')
    const points = () => {
      const line = overlay.children.find((o): o is THREE.Line => o instanceof THREE.Line && o.geometry.getAttribute('position')?.count === 5)!
      const positions = line.geometry.getAttribute('position')
      return Array.from({ length: positions.count }, (_, i) => [positions.getX(i), positions.getY(i)])
    }
    expect(points().slice(1, 3)).toEqual([[50, 0], [50, 10]])
    move(-20, -30)
    expect(points().slice(1, 3)).toEqual([[-50, 0], [-50, -30]])
    move(0, 0)
    expect(sketcherTools.creationCursor({ x: 0, y: 0 }).x).toBe(-50)
  })
  it('tool button blur discards sizes, while an unrelated field blur applies them', () => {
    anchor(); edit('Width', '50')
    const tool = document.createElement('button'); tool.className = 'sketch-tool-btn'; root.appendChild(tool)
    act(() => tool.focus())
    expect(sk().entities).toHaveLength(0)
    act(() => sketcherTools.armTool('line'))
    expect(sk().entities).toHaveLength(0)
    anchor(); edit('Height', '30')
    const foreign = document.createElement('input'); root.appendChild(foreign); act(() => foreign.focus())
    expect(sk().dimensions.map(d => d.value)).toEqual([30])
  })
  it('Enter after a cancelled placement still applies the retained draft', () => {
    anchor(); edit('Width', '50'); click(30, 20, 'pointercancel'); key('Enter', canvas)
    expect(sk().dimensions.map(d => d.value)).toEqual([50])
    expect(useCamStore.getState().sketchHistory).toHaveLength(1)
  })
  it('external geometry restore and document switch drop draft without blur commit', () => {
    anchor(); sketcher.updateSketch(sk()); edit('Width', '50')
    act(() => sketcher.updateSketch({ ...sk(), entities: [...sk().entities] }))
    act(() => input('Width')!.blur())
    expect(sk().entities).toHaveLength(0)
    edit('Width', '50')
    act(() => sketcher.setDocumentPort({ ...camSketchDocumentPort }))
    act(() => input('Width')!.blur())
    expect(sk().entities).toHaveLength(0)
  })
  it('retains only true anchor inferences and drains them before the next shape', () => {
    useCamStore.setState(s => ({ activeSketch: { ...s.activeSketch!, entities: [
      { id: 'anchor-ref', kind: 'point', at: { x: 0, y: 0 }, construction: true },
      { id: 'end-ref', kind: 'point', at: { x: 20, y: 10 }, construction: true },
    ] } }))
    const snap = (id: string, x: number, y: number) => ({ point: { x, y }, kind: 'endpoint' as const,
      sourceEntityIds: [id], inferences: [{ kind: 'coincident' as const, to: { entityId: id, site: 'self' as const } }] })
    act(() => { sketcherTools.armTool('rect-corner'); sketcherTools.click({ x: 0, y: 0 }, .1, snap('anchor-ref', 0, 0), false) })
    move(); edit('Width', '50'); edit('Height', '30')
    act(() => sketcherTools.click({ x: 20, y: 10 }, .1, snap('end-ref', 20, 10), false))
    const refs = sk().constraints.filter(c => c.kind === 'coincident').map(c => JSON.stringify(c))
    expect(refs.some(r => r.includes('anchor-ref'))).toBe(true)
    expect(refs.some(r => r.includes('end-ref'))).toBe(false)
    const count = refs.filter(r => r.includes('anchor-ref')).length
    click(80, 80); click(100, 100)
    expect(sk().constraints.filter(c => JSON.stringify(c).includes('anchor-ref'))).toHaveLength(count)
  })
})

it('retained overlay for another document cannot capture the active host digits', () => {
  anchor()
  const other = { ...sk(), id: 'retained-hidden-document' }
  const port = createCamOverlaysPort(() => ({ worldToScreen: (x, y) => ({ x, y }), getLastSketchCursor: () => ({ x: 70, y: 40 }) }))
  render(<SketchDrawValueInput port={{ ...port, useSketch: () => other }} />, { container: root.appendChild(document.createElement('div')) })
  expect(root.querySelectorAll('input[aria-label="Width"]')).toHaveLength(1)
  key('5', canvas)
  expect(document.activeElement).toBe(input('Width'))
  key('Enter'); expect(sk().dimensions.map(d => d.value)).toEqual([5])
})


describe('Shift creation commit parity', () => {
  for (const tool of ['rect-corner', 'rect-center'] as const) {
    it.each(['field-enter', 'cancel-enter', 'double-click', 'blur', 'released-blur', 'shift-click'] as const)(
      `${tool} %s preserves the commit modifier and one history step`, route => {
        anchor(tool)
        act(() => canvas.dispatchEvent(new MouseEvent('pointermove', {
          clientX: 20, clientY: 20, bubbles: true, shiftKey: true,
        })))
        edit('Width', tool === 'rect-center' ? '40' : '20')
        if (route === 'field-enter') key('Enter', undefined, { shiftKey: true })
        else if (route === 'cancel-enter') {
          click(20, 20, 'pointercancel'); key('Enter', canvas, { shiftKey: true })
        } else if (route === 'double-click') {
          click(20, 20, 'pointercancel')
          act(() => canvas.dispatchEvent(new MouseEvent('dblclick', { button: 0, bubbles: true, shiftKey: true })))
        } else if (route === 'shift-click') {
          act(() => {
            for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new MouseEvent(type, {
              clientX: 20, clientY: 20, button: 0, bubbles: true, shiftKey: true,
            }))
          })
        } else {
          key('Shift', undefined, { shiftKey: true })
          if (route === 'released-blur') fireEvent.keyUp(input('Width')!, { key: 'Shift', shiftKey: false })
          act(() => input('Width')!.blur())
        }
        expect(sk().entities).toHaveLength(6)
        expect(sk().constraints.filter(c => c.kind === 'equal'), 'square relation follows the commit modifier')
          .toHaveLength(route === 'released-blur' ? 0 : 1)
        expect(sk().dimensions.map(d => d.value)).toEqual([tool === 'rect-center' ? 40 : 20])
        expect(useCamStore.getState().sketchHistory).toHaveLength(1)
        expect(sketcherToolStore.getState().chain).toBeNull()
      },
    )
  }
  it.each(['both-held', 'unequal', 'plain-enter'] as const)('%s adds no contradictory square relation', route => {
    anchor(); move(20, 20); edit('Width', route === 'unequal' ? '30' : '20')
    if (route === 'both-held') edit('Height', '20')
    key('Enter', undefined, { shiftKey: route !== 'plain-enter' })
    expect(sk().entities).toHaveLength(6)
    expect(sk().constraints.filter(c => c.kind === 'equal')).toHaveLength(0)
    expect(sk().dimensions).toHaveLength(route === 'both-held' ? 2 : 1)
    expect(useCamStore.getState().sketchHistory).toHaveLength(1)
  })
})


describe('Shift blur boundaries', () => {
  it.each([true, false])('click-away blur reads the current pointer Shift=%s', shiftKey => {
    anchor(); move(20, 20); edit('Width', '20')
    key('Shift', undefined, { shiftKey: !shiftKey })
    const outside = document.createElement('input'); document.body.appendChild(outside)
    act(() => {
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, shiftKey }))
      outside.focus()
    })
    expect(sk().constraints.filter(c => c.kind === 'equal')).toHaveLength(shiftKey ? 1 : 0)
    expect(useCamStore.getState().sketchHistory).toHaveLength(1)
    outside.remove()
  })
  it('window focus loss forgets Shift before a later blur commit', () => {
    anchor(); move(20, 20); edit('Width', '20'); key('Shift', undefined, { shiftKey: true })
    fireEvent(window, new Event('blur'))
    act(() => input('Width')!.blur())
    expect(sk().constraints.filter(c => c.kind === 'equal')).toHaveLength(0)
    expect(sk().dimensions.map(d => d.value)).toEqual([20])
  })
  it('H-only Shift+Enter preserves the same square relation', () => {
    anchor(); move(20, 20); edit('Height', '20'); key('Enter', undefined, { shiftKey: true })
    expect(sk().constraints.filter(c => c.kind === 'equal')).toHaveLength(1)
    expect(sk().dimensions.map(d => d.value)).toEqual([20])
    expect(useCamStore.getState().sketchHistory).toHaveLength(1)
  })
})

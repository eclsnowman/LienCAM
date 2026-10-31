// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { Sketcher, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import { SketchDimensionOverlay } from '../../lib/sketch/sketcher/overlays/SketchDimensionOverlay'
import type { SketcherHost } from '../../lib/sketch/sketcher/ports'

// Exercise the actual CAM interaction and editor ports. Browser evidence runs
// the real worker/solver; here the worker only records asynchronous requests.
vi.stubGlobal('Worker', class { postMessage() {} terminate() {} })
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
const { camSketchDocumentPort, useCamStore } = await import('../../store')
const { createCamOverlaysPort } = await import('../../components/viewport/camOverlaysPort')
let sketcher: Sketcher
let canvas: HTMLCanvasElement
let root: HTMLDivElement
const state = () => sketcherToolStore.getState()
const dims = () => useCamStore.getState().activeSketch!.dimensions
function key(key: string, target: EventTarget = document.activeElement ?? window, extra: KeyboardEventInit = {}) {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })) })
}
function pickEdge() {
  act(() => {
    sketcherTools.armTool('smart-dimension')
    sketcherTools.click({ x: 30, y: 0 }, 0.1, null, false)
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 0, bubbles: true }))
  })
  expect(state().chain?.kind).toBe('dim')
}
function input() { return root.querySelector<HTMLInputElement>('input.sketch-dim-input') }
function typeRest(text: string) {
  const editor = input()!
  // jsdom has no native typing default action. First digit is always a real
  // key event; subsequent text uses the browser input event on the real editor.
  fireEvent.change(editor, { target: { value: editor.value + text } })
}

beforeEach(() => {
  sketcherToolStore.__reset()
  useCamStore.setState(s => ({
    activeSketch: { id: 'wo3110', layerId: 'layer', entities: [], constraints: [], dimensions: [], solveStatus: null },
    sketchSelectedIds: [], sketchDimEditor: null, sketchHistory: [],
    viewer: { ...s.viewer, mode: 'sketch' },
    appSettings: { ...s.appSettings, displayUnits: 'mm' },
  }))
  root = document.createElement('div'); canvas = document.createElement('canvas')
  root.appendChild(canvas); document.body.appendChild(root)
  const host: SketcherHost = {
    domElement: canvas, container: root, overlayHost: root,
    overlayRoot: new THREE.Group(), camera: new THREE.OrthographicCamera(),
    controls: { enableRotate: false }, clientToPlaneWorld: (x, y) => ({ x, y }), worldPerPixel: () => 0.01,
    saveCameraPose: () => ({}), restoreCameraPose() {}, frameNormalToPlane() {},
  }
  sketcher = new Sketcher(host)
  sketcher.setDocumentPort(camSketchDocumentPort)
  sketcher.setUndoSink({ beginGesture: () => useCamStore.getState().pushHistory() })
  sketcher.enter()
  act(() => {
    sketcherTools.armTool('rect-corner')
    sketcherTools.click({ x: 0, y: 0 }, 0.1, null, false)
    sketcherTools.click({ x: 60, y: 40 }, 0.1, null, false)
    sketcherTools.escape()
  })
  render(<SketchDimensionOverlay port={createCamOverlaysPort(() => ({
    worldToScreen: (x, y) => ({ x, y }), getLastSketchCursor: () => ({ x: 30, y: 0 }),
  }))} />, { container: root.appendChild(document.createElement('div')) })
})
afterEach(() => { act(() => sketcher.dispose()); cleanup(); root.remove() })

describe('WO-3110 dimension typing through the production interaction', () => {
  it.each(['50', '32', '21', '12', '.5'])('types %s before placement without changing tools', value => {
    pickEdge()
    key(value[0], canvas)
    expect(state().tool).toBe('smart-dimension')
    expect(input(), 'first digit opens the existing dimension editor').not.toBeNull()
    expect(input()!.value).toBe(value[0])
    expect(document.activeElement).toBe(input())
    typeRest(value.slice(1)); key('Enter')
    expect(state().tool).toBe('smart-dimension')
    expect(dims()).toHaveLength(1)
    expect(dims()[0].value).toBe(Number(value))
    expect(dims()[0].driving).toBe(true)
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
  })
  it('Escape in typed entry keeps the measured dimension and does not commit the draft', () => {
    pickEdge(); key('3', canvas)
    expect(input()).not.toBeNull()
    key('Escape')
    expect(dims()).toHaveLength(1)
    expect(dims()[0].value).toBeCloseTo(60)
    expect(state().tool).toBe('smart-dimension')
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
  })
  it('Escape before typing cancels the operand set without placing a dimension', () => {
    pickEdge(); key('Escape', canvas)
    expect(dims()).toHaveLength(0)
    expect(state().chain).toBeNull()
  })
  it('retains ordinary placement, Tab orientation, editor Enter and click-away commit', () => {
    pickEdge(); key('Tab', canvas)
    act(() => sketcherTools.click({ x: 30, y: -20 }, 0.1, null, false))
    expect(input()).not.toBeNull()
    fireEvent.change(input()!, { target: { value: '25' } })
    key('Enter')
    expect(dims()[0].value).toBe(25)
    act(() => useCamStore.getState().openDimensionEditor(dims()[0].id))
    fireEvent.change(input()!, { target: { value: '24' } })
    act(() => input()!.blur())
    expect(dims()[0].value).toBe(24)
  })
  it.each(['input', 'textarea', 'select', 'editable'])('leaves a focused %s alone', tag => {
    pickEdge()
    const el = document.createElement(tag === 'editable' ? 'div' : tag)
    if (tag === 'editable') { el.setAttribute('contenteditable', 'true'); el.tabIndex = 0 }
    root.appendChild(el); el.focus()
    key('3', el); key('Enter', el)
    expect(state().tool).toBe('smart-dimension')
    expect(state().chain?.kind).toBe('dim')
    expect(dims()).toHaveLength(0)
  })
  it('keeps modifier chords and normal tool shortcuts outside dimension entry', () => {
    pickEdge()
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) key('3', canvas, { [modifier]: true })
    expect(dims()).toHaveLength(0)
    key('Escape', canvas)
    for (const [digit, tool] of [['1', 'pattern-linear'], ['2', 'pattern-circular'], ['3', 'pattern-path'], ['l', 'line']]) {
      key(digit, canvas); expect(state().tool).toBe(tool)
    }
  })
})

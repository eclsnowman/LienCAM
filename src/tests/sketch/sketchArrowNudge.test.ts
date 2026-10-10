// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import * as THREE from 'three'
import { Sketcher, sketcherToolStore } from '../../lib/sketch/sketcher'
import type { SketchDocumentPort, SketcherHost } from '../../lib/sketch/sketcher/ports'
import type { Sketch } from '../../lib/sketch/types'
import { camSketchDocumentPort, useCamStore } from '../../store'
import { SketchToolbox } from '../../components/panels/sketch/SketchToolbox'

function sketch(): Sketch {
  return {
    id: 's', layerId: 'l',
    entities: [
      { id: 'line', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
      { id: 'circle', kind: 'circle', construction: false, center: { x: 8, y: 2 }, radius: 2 },
      { id: 'fixed', kind: 'point', construction: false, at: { x: 10, y: 10 } },
    ],
    constraints: [{ id: 'fix-c', kind: 'fix', entityId: 'fixed' }],
    dimensions: [],
    solveStatus: { dof: 4, conflicting: [], redundant: [] },
  }
}

function fakePort(nudgeSelection: SketchDocumentPort['nudgeSelection']): SketchDocumentPort {
  const value = sketch()
  return {
    getSketch: () => value, ensureSketch: () => value, getDisplayUnits: () => 'mm',
    getGridSpacing: () => 1, getProjectCandidates: () => [],
    getSelection: () => ['line'], setSelection: () => {},
    getLastStagedSize: () => null, setLastStagedSize: () => {}, notice: () => {},
    beginStep: () => {}, append: () => {}, replace: () => {},
    toggleSelectionConstruction: () => false, deleteSelection: () => {},
    nudgeSelection,
    dragBegin: () => false, dragMove: () => {}, dragEnd: () => {},
    moveDimLabel: () => {}, openDimEditor: () => {},
    getTextEditId: () => null, getPickPathForTextId: () => null,
    editText: () => {}, commitTextEdit: () => {}, cancelTextEdit: () => {},
    cancelPickTextPath: () => {}, placeText: () => {}, bindTextPath: () => {},
  }
}

function keyboardMount(nudgeSelection: NonNullable<SketchDocumentPort['nudgeSelection']>) {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const host: SketcherHost = {
    domElement: canvas, container: canvas, overlayHost: canvas,
    overlayRoot: new THREE.Group(), camera: new THREE.OrthographicCamera(),
    controls: { enableRotate: false },
    clientToPlaneWorld: () => ({ x: 0, y: 0 }), worldPerPixel: () => 1,
    saveCameraPose: () => ({}), restoreCameraPose: () => {}, frameNormalToPlane: () => {},
  }
  const beginGesture = vi.fn()
  const sketcher = new Sketcher(host)
  sketcher.setDocumentPort(fakePort(nudgeSelection))
  sketcher.setUndoSink({ beginGesture })
  sketcher.enter()
  return { sketcher, beginGesture }
}

beforeEach(() => {
  document.body.innerHTML = ''
  sketcherToolStore.__reset()
  useCamStore.setState({
    activeSketch: null, sketchSelectedIds: [], sketchSolveStatus: null,
    projectHistory: [], sketchHistory: [],
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('CAM sketch Arrow-key nudge', () => {
  it('routes I through the real CAM SketchInteraction, guards repeat/typing/modifiers, and closes on exit', () => {
    const { sketcher } = keyboardMount(vi.fn(() => false))
    useCamStore.setState({
      activeSketch: sketch(),
      sketchSelectedIds: ['line'],
    })
    render(createElement(SketchToolbox))

    const measure = screen.getByTestId('cam-sketch-measure')
    expect(measure.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('sketch-measure-readout')).toBeNull()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', bubbles: true, cancelable: true,
      }))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('sketch-measure-readout').textContent).toContain('Line')

    // Held-key repeat must not oscillate the utility.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', repeat: true, bubbles: true, cancelable: true,
      }))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('true')

    const input = document.createElement('input')
    document.body.appendChild(input)
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', bubbles: true, cancelable: true,
      }))
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', ctrlKey: true, bubbles: true, cancelable: true,
      }))
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', altKey: true, bubbles: true, cancelable: true,
      }))
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', metaKey: true, bubbles: true, cancelable: true,
      }))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('true')

    act(() => {
      sketcher.setDocumentPort(fakePort(vi.fn(() => false)))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('sketch-measure-readout')).toBeNull()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', bubbles: true, cancelable: true,
      }))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('true')

    act(() => { sketcher.suspend() })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'i', bubbles: true, cancelable: true,
      }))
    })
    expect(measure.getAttribute('aria-pressed')).toBe('true')
    act(() => { sketcher.resume() })

    act(() => { sketcher.exit() })
    expect(measure.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('sketch-measure-readout')).toBeNull()
    sketcher.dispose()
  })

  it('dispatches 0.1/1 mm, guards typing focus, and opens one undo step per accepted key', () => {
    const nudge = vi.fn((_delta, beforeMutate: () => void) => {
      beforeMutate()
      return true
    })
    const { sketcher, beginGesture } = keyboardMount(nudge)

    const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    window.dispatchEvent(right)
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true,
    }))
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowLeft', bubbles: true, cancelable: true,
    }))

    expect(nudge.mock.calls.map(([delta]) => delta)).toEqual([
      { x: 0.1, y: 0 },
      { x: 0, y: 1 },
    ])
    expect(beginGesture).toHaveBeenCalledTimes(2)
    expect(right.defaultPrevented).toBe(true)
    sketcher.dispose()
  })

  it('moves each selected movable entity once, ignores non-entities/fixed geometry, then solves', () => {
    const solveSketch = vi.fn()
    const original = sketch()
    useCamStore.setState({
      activeSketch: original,
      sketchSelectedIds: ['line', 'line', 'circle', 'fixed', 'fix-c', 'missing'],
      sketchSolveStatus: original.solveStatus,
      solveSketch,
    })

    expect(camSketchDocumentPort.nudgeSelection?.(
      { x: -0.1, y: 0 },
      () => useCamStore.getState().pushHistory(),
    )).toBe(true)

    const state = useCamStore.getState()
    expect(state.activeSketch?.entities).toEqual([
      { id: 'line', kind: 'line', construction: false, start: { x: -0.1, y: 0 }, end: { x: 3.9, y: 0 } },
      { id: 'circle', kind: 'circle', construction: false, center: { x: 7.9, y: 2 }, radius: 2 },
      { id: 'fixed', kind: 'point', construction: false, at: { x: 10, y: 10 } },
    ])
    expect(state.sketchHistory).toEqual([original])
    expect(solveSketch).toHaveBeenCalledTimes(1)

    useCamStore.setState({ sketchSelectedIds: ['fix-c', 'missing'] })
    expect(camSketchDocumentPort.nudgeSelection?.({ x: 1, y: 0 }, vi.fn())).toBe(false)
    expect(solveSketch).toHaveBeenCalledTimes(1)
  })
})

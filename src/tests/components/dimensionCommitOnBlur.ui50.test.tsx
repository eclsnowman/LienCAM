// @vitest-environment jsdom
//
// UI-50 regression lock: all three dimension/value input families commit a
// valid draft on click-away, while Escape remains an explicit cancellation.
// These tests render the production components and drive the real DOM events;
// the callbacks are the component boundaries that production calls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { NumericInput } from '../../components/ui/NumericInput'
import { DimValueInput } from '../../lib/sketch/sketcher/overlays/SketchDimensionOverlay'
import { SketchDrawValueInput } from '../../lib/sketch/sketcher/overlays/SketchDrawValueInput'
import type {
  SketcherOverlaySurface,
  SketcherOverlaysPort,
} from '../../lib/sketch/sketcher/overlays/port'
import { sketcherTools } from '../../lib/sketch/sketcher/toolController'
import { sketcherToolStore } from '../../lib/sketch/sketcher/toolStore'
import type { Sketch, SketchDimension } from '../../lib/sketch/types'

const radiusDimension: SketchDimension = {
  id: 'radius-dim',
  kind: 'radius',
  driving: true,
  value: 5,
  entityId: 'circle-1',
}

const drawSketch: Sketch = {
  id: 'draw-sketch',
  layerId: 'layer-1',
  entities: [],
  constraints: [],
  dimensions: [],
  solveStatus: null,
}

const liveCursor = { x: 3, y: 4 }
const drawSurface: SketcherOverlaySurface = {
  getLastSketchCursor: () => ({ ...liveCursor }),
  worldToScreen: (x, y) => ({ x, y }),
}

function inputFrom(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input.sketch-dim-input')
  expect(input).toBeInstanceOf(HTMLInputElement)
  return input as HTMLInputElement
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  sketcherToolStore.__reset()
})

afterEach(() => {
  cleanup()
  sketcherToolStore.__reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('NumericInput commit-on-blur contract', () => {
  it('commits a valid typed canonical value on blur', () => {
    const onChange = vi.fn()
    const { container } = render(
      <NumericInput value={5} onChange={onChange} units="mm" />,
    )
    const input = container.querySelector('input') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '12.5' } })
    fireEvent.blur(input)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(12.5)
  })

  it('reverts the draft and does not commit on Escape', () => {
    const onChange = vi.fn()
    const { container } = render(
      <NumericInput value={5} onChange={onChange} units="mm" />,
    )
    const input = container.querySelector('input') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '12.5' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('5')
  })
})

describe('DimValueInput commit-on-blur contract', () => {
  function renderDimensionInput() {
    const commitDimensionValue = vi.fn()
    const closeDimensionEditor = vi.fn()
    const port = {
      commitDimensionValue,
      closeDimensionEditor,
      toggleDimensionDriving: vi.fn(),
    } as unknown as SketcherOverlaysPort
    const { container } = render(
      <DimValueInput port={port} dim={radiusDimension} units="mm" />,
    )
    return {
      input: inputFrom(container),
      commitDimensionValue,
      closeDimensionEditor,
    }
  }

  it('commits the parsed millimeter value on blur', () => {
    const { input, commitDimensionValue } = renderDimensionInput()

    fireEvent.change(input, { target: { value: '8.25' } })
    fireEvent.blur(input)

    expect(commitDimensionValue).toHaveBeenCalledTimes(1)
    // "sketch-dim equations wiring": a plain (non-"=") commit passes `expression: undefined` --
    // dimExpr.ts's DimInputResult only sets it for an equation.
    expect(commitDimensionValue).toHaveBeenCalledWith('radius-dim', 8.25, undefined)
  })

  it('closes the editor and does not commit on Escape', () => {
    const { input, commitDimensionValue, closeDimensionEditor } = renderDimensionInput()

    fireEvent.change(input, { target: { value: '8.25' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(closeDimensionEditor).toHaveBeenCalledTimes(1)
    expect(commitDimensionValue).not.toHaveBeenCalled()
  })
})

describe('SketchDrawValueInput commit-on-blur contract', () => {
  const drawPort = {
    useIsSketchActive: () => true,
    useSketch: () => drawSketch,
    useDisplayUnits: () => 'mm',
    getSurface: () => drawSurface,
  } as unknown as SketcherOverlaysPort

  function renderDrawInput() {
    sketcherToolStore.setState({ tool: 'fillet', chain: null, filletRadius: 2 })
    const commitDrawValueAt = vi
      .spyOn(sketcherTools, 'commitDrawValueAt')
      .mockImplementation(() => {})
    const { container } = render(<SketchDrawValueInput port={drawPort} />)
    return { input: inputFrom(container), commitDrawValueAt }
  }

  it('commits the parsed value at the live cursor on blur', () => {
    const { input, commitDrawValueAt } = renderDrawInput()

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '7.5' } })
    fireEvent.blur(input)

    expect(commitDrawValueAt).toHaveBeenCalledTimes(1)
    expect(commitDrawValueAt).toHaveBeenCalledWith(7.5, liveCursor)
  })

  it('does not commit the typed value on Escape', () => {
    const { input, commitDrawValueAt } = renderDrawInput()

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '7.5' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(commitDrawValueAt).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
//
// WO-1437 (BUG-496): the SketchConfirmOverlay OK button used to call
// sketcherTools.overlayApply directly, with none of the invalid-expression
// refusal the per-field Enter handler already had. An erroring draft is never
// dispatched into the store, so clicking OK silently committed the last
// successfully-resolved value. These tests prove the button now refuses exactly
// like Enter: no apply() call, the invalid draft and its error stay visible, and
// a VALID draft still applies through the button.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { Sketch } from '../../lib/sketch/types'
import type { SketcherOverlaysPort } from '../../lib/sketch/sketcher'

let SketchConfirmOverlay: typeof import('../../lib/sketch/sketcher/overlays/SketchConfirmOverlay').SketchConfirmOverlay
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore
let sketcherTools: typeof import('../../lib/sketch/sketcher/toolController').sketcherTools

beforeAll(async () => {
  ;({ SketchConfirmOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchConfirmOverlay'))
  ;({ sketcherToolStore } = await import('../../lib/sketch/sketcher'))
  ;({ sketcherTools } = await import('../../lib/sketch/sketcher/toolController'))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const blankSketch: Sketch = {
  id: 's', layerId: 'l', entities: [], constraints: [], dimensions: [],
  solveStatus: null,
}

const circleSketch: Sketch = {
  ...blankSketch,
  entities: [{
    id: 'c1', kind: 'circle', construction: false,
    center: { x: 0, y: 0 }, radius: 10,
  }],
}

function makePort(units: 'mm' | 'inch' = 'mm'): SketcherOverlaysPort {
  return {
    useIsSketchActive: () => true,
    useSketch: () => circleSketch,
    useDisplayUnits: () => units,
    useSelectedIds: () => [],
    useDimEditor: () => null,
    useTextEditId: () => null,
    useTextDraft: () => '',
    getSketch: () => circleSketch,
    getDisplayUnits: () => units,
    getSurface: () => null,
    toggleDimensionDriving: () => {},
    commitDimensionValue: () => {},
    closeDimensionEditor: () => {},
    setTextValue: () => {},
    setTextCaretIndex: () => {},
    commitTextEdit: () => {},
    cancelTextEdit: () => {},
    setTextPathAlignById: () => {},
    setTextPathFlipById: () => {},
    setTextMirrorById: () => {},
    applyConstraint: () => {},
    deleteSelection: () => {},
  } as unknown as SketcherOverlaysPort
}

function fieldByLabel(container: HTMLElement, label: string) {
  const labels = container.querySelectorAll('.sketch-confirm-field')
  for (const l of labels) {
    if (l.querySelector('span')?.textContent === label) {
      return {
        input: l.querySelector('input')!,
        preview: l.querySelector('.sketch-dim-eq-preview'),
      }
    }
  }
  throw new Error(`confirm field "${label}" not found`)
}

function okButton(container: HTMLElement) {
  return container.querySelector('.sketch-prompt-btn-confirm') as HTMLButtonElement
}

describe('WO-1437 SketchConfirmOverlay OK button respects expression validation', () => {
  beforeEach(() => {
    sketcherToolStore.__reset()
    sketcherToolStore.setState({
      tool: 'offset',
      chain: {
        kind: 'offset',
        source: { kind: 'circle', circle: circleSketch.entities[0] },
        lockedSide: 1,
      },
      offsetDistance: 2,
    } as never)
  })

  it('refuses the OK button while an erroring field is visible (no apply, draft + error stay)', () => {
    const applySpy = vi.spyOn(sketcherTools, 'overlayApply')
    const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
    const { input } = fieldByLabel(container, 'Distance')

    fireEvent.change(input, { target: { value: '=1/0' } })
    expect(fieldByLabel(container, 'Distance').preview?.textContent).toMatch(/division by zero/i)

    fireEvent.click(okButton(container))

    expect(applySpy).not.toHaveBeenCalled()
    expect(input.value).toBe('=1/0')
    expect(fieldByLabel(container, 'Distance').preview?.textContent).toMatch(/division by zero/i)
    expect(sketcherToolStore.getState().chain).not.toBeNull()
  })

  it('visually disables the OK button while an erroring field is visible', () => {
    const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
    const { input } = fieldByLabel(container, 'Distance')

    fireEvent.change(input, { target: { value: '=1/0' } })
    expect(okButton(container).disabled).toBe(true)
  })

  it("Enter's existing refusal behavior is unchanged (still no apply)", () => {
    const applySpy = vi.spyOn(sketcherTools, 'overlayApply')
    const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
    const { input } = fieldByLabel(container, 'Distance')

    fireEvent.change(input, { target: { value: '=1/0' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(applySpy).not.toHaveBeenCalled()
    expect(input.value).toBe('=1/0')
    expect(fieldByLabel(container, 'Distance').preview?.textContent).toMatch(/division by zero/i)
  })

  it('a valid draft still applies via the OK button (parity with Enter success case)', () => {
    const applySpy = vi.spyOn(sketcherTools, 'overlayApply')
    const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
    const { input } = fieldByLabel(container, 'Distance')

    fireEvent.change(input, { target: { value: '=25.4*2' } })
    expect(fieldByLabel(container, 'Distance').preview?.classList.contains('sketch-dim-eq-preview-error')).toBe(false)

    fireEvent.click(okButton(container))

    expect(applySpy).toHaveBeenCalledTimes(1)
  })
})

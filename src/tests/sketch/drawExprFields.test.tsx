// @vitest-environment jsdom
//
// SKC-DRAW-EXPR + SKC-COUNT-EXPR: SketchConfirmOverlay draw-time fields accept
// the same "=..." arithmetic equations as placed-dimension edits (src/lib/
// sketch/dimExpr.ts). Length, angle, and pattern count fields all use the same
// DOC-4 expression engine.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sketch } from '../../lib/sketch/types'
import type { SketcherOverlaysPort } from '../../lib/sketch/sketcher'

let SketchConfirmOverlay: typeof import('../../lib/sketch/sketcher/overlays/SketchConfirmOverlay').SketchConfirmOverlay
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

beforeAll(async () => {
  ;({ SketchConfirmOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchConfirmOverlay'))
  ;({ sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

afterEach(() => {
  cleanup()
})

const repoRoot = join(__dirname, '../../..')

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

describe('SketchConfirmOverlay draw-time equation fields', () => {
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

  it('accepts a length equation and commits the resolved mm value immediately', () => {
    const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
    const { input } = fieldByLabel(container, 'Distance')

    fireEvent.change(input, { target: { value: '=25.4*2' } })

    expect(sketcherToolStore.getState().offsetDistance).toBeCloseTo(50.8, 10)
    expect(input.value).toBe('=25.4*2')
    const preview = fieldByLabel(container, 'Distance').preview
    expect(preview?.textContent).toMatch(/= 50\.8\s*mm/)
    expect(preview?.classList.contains('sketch-dim-eq-preview-error')).toBe(false)
  })

  it('keeps plain-number length input byte-identical to the pre-existing path', () => {
    const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
    const { input, preview } = fieldByLabel(container, 'Distance')

    fireEvent.change(input, { target: { value: '25.4' } })

    expect(sketcherToolStore.getState().offsetDistance).toBeCloseTo(25.4, 10)
    expect(input.value).toBe('25.4')
    expect(preview).toBeNull()
  })

  it('interprets equations as mm-canonical, independent of the display-unit toggle', () => {
    const { container } = render(<SketchConfirmOverlay port={makePort('inch')} />)
    const { input } = fieldByLabel(container, 'Distance')

    fireEvent.change(input, { target: { value: '=25.4*2' } })

    // Equation literals are mm, same as placed-dimension edits; not inches.
    expect(sketcherToolStore.getState().offsetDistance).toBeCloseTo(50.8, 10)
  })

  it('rejects an invalid equation fail-loud and leaves the tool store untouched', () => {
    const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
    const { input } = fieldByLabel(container, 'Distance')

    fireEvent.change(input, { target: { value: '=1/0' } })

    expect(sketcherToolStore.getState().offsetDistance).toBe(2)
    const preview = fieldByLabel(container, 'Distance').preview
    expect(preview?.textContent).toMatch(/division by zero/i)
    expect(preview?.classList.contains('sketch-dim-eq-preview-error')).toBe(true)

    // ADR-0003: blur does NOT silently revert to the old value.
    fireEvent.blur(input)
    expect(input.value).toBe('=1/0')
    const previewAfterBlur = fieldByLabel(container, 'Distance').preview
    expect(previewAfterBlur?.classList.contains('sketch-dim-eq-preview-error')).toBe(true)
  })

  it('does not step-arrow an in-progress equation (does not destroy the = draft)', () => {
    const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
    const { input } = fieldByLabel(container, 'Distance')

    fireEvent.change(input, { target: { value: '=25.4*2' } })
    fireEvent.keyDown(input, { key: 'ArrowUp' })

    expect(input.value).toBe('=25.4*2')
    expect(sketcherToolStore.getState().offsetDistance).toBeCloseTo(50.8, 10)
  })
})

describe('SketchConfirmOverlay angle field equation support', () => {
  beforeEach(() => {
    sketcherToolStore.__reset()
    sketcherToolStore.setState({
      tool: 'pattern-circular',
      chain: { kind: 'circpat', center: { x: 0, y: 0 }, ids: ['c1'] },
      circularPatternCount: 4,
      circularPatternAngleDeg: 90,
    } as never)
  })

  it('accepts an angle equation in degrees and commits the resolved step angle', () => {
    const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
    const { input } = fieldByLabel(container, 'Step')

    fireEvent.change(input, { target: { value: '=90+45' } })

    expect(sketcherToolStore.getState().circularPatternAngleDeg).toBeCloseTo(135, 10)
    expect(input.value).toBe('=90+45')
    const preview = fieldByLabel(container, 'Step').preview
    expect(preview?.textContent).toMatch(/= 135\s*deg/)
  })

  it('keeps plain-number angle input byte-identical', () => {
    const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
    const { input, preview } = fieldByLabel(container, 'Step')

    fireEvent.change(input, { target: { value: '45' } })

    expect(sketcherToolStore.getState().circularPatternAngleDeg).toBeCloseTo(45, 10)
    expect(preview).toBeNull()
  })
})

describe('SketchConfirmOverlay count field equation support', () => {
  describe('linear pattern count', () => {
    beforeEach(() => {
      sketcherToolStore.__reset()
      sketcherToolStore.setState({
        tool: 'pattern-linear',
        chain: { kind: 'linpat', ids: ['c1'], vector: { x: 10, y: 0 } },
        linearPatternCount: 3,
      } as never)
    })

    it('accepts a count equation and commits the resolved integer immediately', () => {
      const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
      const { input } = fieldByLabel(container, 'Count')

      fireEvent.change(input, { target: { value: '=2+3' } })

      expect(sketcherToolStore.getState().linearPatternCount).toBe(5)
      expect(input.value).toBe('=2+3')
      const preview = fieldByLabel(container, 'Count').preview
      expect(preview?.textContent).toBe('= 5')
      expect(preview?.classList.contains('sketch-dim-eq-preview-error')).toBe(false)
    })

    it('truncates a non-integer equation the same way as a typed decimal', () => {
      const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
      const { input } = fieldByLabel(container, 'Count')

      // Plain typed decimal uses parseInt -> 2 today.
      fireEvent.change(input, { target: { value: '2.6' } })
      expect(sketcherToolStore.getState().linearPatternCount).toBe(2)

      // Equation resolving to 2.6 must truncate the same way.
      fireEvent.change(input, { target: { value: '=13/5' } })

      expect(sketcherToolStore.getState().linearPatternCount).toBe(2)
      expect(fieldByLabel(container, 'Count').preview?.textContent).toBe('= 2')
    })

    it('rejects a count equation below the field minimum fail-loud', () => {
      const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
      const { input } = fieldByLabel(container, 'Count')

      fireEvent.change(input, { target: { value: '=1+0' } })

      expect(sketcherToolStore.getState().linearPatternCount).toBe(3)
      const preview = fieldByLabel(container, 'Count').preview
      expect(preview?.textContent).toMatch(/must be at least 2/)
      expect(preview?.classList.contains('sketch-dim-eq-preview-error')).toBe(true)
    })

    it('rejects a zero/negative count equation fail-loud', () => {
      const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
      const { input } = fieldByLabel(container, 'Count')

      fireEvent.change(input, { target: { value: '=0' } })

      expect(sketcherToolStore.getState().linearPatternCount).toBe(3)
      expect(fieldByLabel(container, 'Count').preview?.textContent).toMatch(/must be positive/)
    })

    it('refuses Enter-apply while a count equation error is active', () => {
      const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
      const { input } = fieldByLabel(container, 'Count')

      fireEvent.change(input, { target: { value: '=1/0' } })
      expect(fieldByLabel(container, 'Count').preview?.textContent).toMatch(/division by zero/i)

      fireEvent.keyDown(input, { key: 'Enter' })

      // Error stays visible and the draft is not wiped by apply/cancel.
      expect(input.value).toBe('=1/0')
      expect(fieldByLabel(container, 'Count').preview?.textContent).toMatch(/division by zero/i)
    })
  })

  describe('circular pattern count', () => {
    beforeEach(() => {
      sketcherToolStore.__reset()
      sketcherToolStore.setState({
        tool: 'pattern-circular',
        chain: { kind: 'circpat', center: { x: 0, y: 0 }, ids: ['c1'] },
        circularPatternCount: 4,
        circularPatternAngleDeg: 90,
      } as never)
    })

    it('accepts a count equation and commits the resolved integer', () => {
      const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
      const { input } = fieldByLabel(container, 'Count')

      fireEvent.change(input, { target: { value: '=3*2' } })

      expect(sketcherToolStore.getState().circularPatternCount).toBe(6)
      expect(input.value).toBe('=3*2')
      expect(fieldByLabel(container, 'Count').preview?.textContent).toBe('= 6')
    })

    it('keeps plain-number count input byte-identical to the pre-existing path', () => {
      const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
      const { input, preview } = fieldByLabel(container, 'Count')

      fireEvent.change(input, { target: { value: '5' } })

      expect(sketcherToolStore.getState().circularPatternCount).toBe(5)
      expect(input.value).toBe('5')
      expect(preview).toBeNull()
    })

    it('rejects a circular count equation below the field minimum', () => {
      const { container } = render(<SketchConfirmOverlay port={makePort('mm')} />)
      const { input } = fieldByLabel(container, 'Count')

      fireEvent.change(input, { target: { value: '=1' } })

      expect(sketcherToolStore.getState().circularPatternCount).toBe(4)
      expect(fieldByLabel(container, 'Count').preview?.classList.contains('sketch-dim-eq-preview-error')).toBe(true)
    })
  })
})

describe('Sketcher parity: both hosts mount the same shared SketchConfirmOverlay', () => {
  it('CAM Viewport and Part-studio SolidsWorkbenchPage both render <SketcherOverlays>, which unconditionally includes <SketchConfirmOverlay>', () => {
    const camViewport = readFileSync(join(repoRoot, 'src/components/viewport/Viewport.tsx'), 'utf8')
    const workbenchPage = readFileSync(join(repoRoot, 'src/components/model3d/SolidsWorkbenchPage.tsx'), 'utf8')
    const overlaysShell = readFileSync(join(repoRoot, 'src/lib/sketch/sketcher/overlays/SketcherOverlays.tsx'), 'utf8')

    expect(camViewport).toMatch(/<SketcherOverlays\s+port=\{camOverlaysPort\}/)
    expect(workbenchPage).toMatch(/<SketcherOverlays\s+port=\{workbenchOverlaysPort\}/)
    expect(overlaysShell).toMatch(/<SketchConfirmOverlay\s+port=\{port\}/)
  })
})

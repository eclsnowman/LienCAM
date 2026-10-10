// @vitest-environment jsdom
//
// WO-1484 (Codex audit BUG-544, family K9): a two-entity Measure spacing picks
// a "natural" reference point per entity privately and reports the result under
// the flat title "Selection spacing", so nothing in the result or the readout
// says which two points were actually measured. Selecting a tangent arc and the
// line it is tangent to reports a correct center-to-midpoint number that reads
// as if it contradicts the visibly-zero endpoint gap.
//
// This test pins the new, additive reference-point identity (and proves the
// numeric Distance/dX/dY/Angle values did not change).

import { describe, expect, it, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { SketchMeasureReadout } from '../../components/panels/sketch/SketchMeasureReadout'
import { measureSketchSelection } from '../../lib/sketch/measureSelection'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

afterEach(cleanup)

// A line whose endpoint sits exactly on the tangent arc's start point: the
// visible endpoint gap is zero, but the natural reference points (line
// midpoint and arc center) are 7.071 mm apart.
const tangentLine: SketchEntity = {
  id: 'line-1',
  kind: 'line',
  construction: false,
  start: { x: 0, y: 0 },
  end: { x: 10, y: 0 },
}
const tangentArc: SketchEntity = {
  id: 'arc-1',
  kind: 'arc',
  construction: false,
  center: { x: 10, y: 5 },
  radius: 5,
  startAngle: -Math.PI / 2,
  endAngle: 0,
}

describe('WO-1484: two-entity Measure names its reference points', () => {
  it('names the arc center and line midpoint a tangent pair was spaced by', () => {
    const measurement = measureSketchSelection(
      [tangentLine, tangentArc],
      ['line-1', 'arc-1'],
    )

    expect(measurement?.title).toBe('Selection spacing')
    expect(measurement?.references).toEqual([
      { entityId: 'line-1', label: 'line midpoint' },
      { entityId: 'arc-1', label: 'arc center' },
    ])
    // The identity names the measured points; the visible endpoint gap is zero.
    expect(measurement?.references?.[0].label).not.toBe(measurement?.references?.[1].label)

    // Acceptance 3: the numeric values are byte-identical to the old behavior.
    expect(measurement?.values).toEqual([
      { label: 'Distance', value: Math.hypot(5, 5), kind: 'length' },
      { label: 'dX', value: 5, kind: 'length' },
      { label: 'dY', value: 5, kind: 'length' },
      { label: 'Angle', value: 45, kind: 'angle' },
    ])
  })

  it('derives the identity per kind rather than hardcoding one pair', () => {
    const lineA: SketchEntity = {
      id: 'line-a',
      kind: 'line',
      construction: false,
      start: { x: 0, y: 0 },
      end: { x: 2, y: 0 },
    }
    const lineB: SketchEntity = {
      id: 'line-b',
      kind: 'line',
      construction: false,
      start: { x: 5, y: 0 },
      end: { x: 9, y: 0 },
    }
    const circle: SketchEntity = {
      id: 'circle-1',
      kind: 'circle',
      construction: false,
      center: { x: 0, y: 4 },
      radius: 1,
    }

    expect(measureSketchSelection([lineA, lineB], ['line-a', 'line-b'])?.references).toEqual([
      { entityId: 'line-a', label: 'line midpoint' },
      { entityId: 'line-b', label: 'line midpoint' },
    ])
    expect(measureSketchSelection([lineA, circle], ['line-a', 'circle-1'])?.references).toEqual([
      { entityId: 'line-a', label: 'line midpoint' },
      { entityId: 'circle-1', label: 'circle center' },
    ])
  })

  it('leaves a single-entity measurement without a reference identity', () => {
    expect(measureSketchSelection([tangentLine], ['line-1'])?.references).toBeUndefined()
  })

  it('renders the reference identity alongside the Distance readout', () => {
    const sketch: Sketch = {
      id: 'sketch-1',
      layerId: 'layer-1',
      entities: [tangentLine, tangentArc],
      constraints: [],
      dimensions: [],
      solveStatus: null,
    }

    render(
      createElement(SketchMeasureReadout, {
        sketch,
        selectedIds: ['line-1', 'arc-1'],
        displayUnits: 'mm',
      }),
    )

    const text = screen.getByTestId('sketch-measure-readout').textContent ?? ''
    expect(text).toContain('Selection spacing')
    expect(text).toContain('line midpoint')
    expect(text).toContain('arc center')
    expect(text).toContain('7.071')
  })

  it('does not render a reference row for a single entity', () => {
    const sketch: Sketch = {
      id: 'sketch-1',
      layerId: 'layer-1',
      entities: [tangentLine],
      constraints: [],
      dimensions: [],
      solveStatus: null,
    }

    render(createElement(SketchMeasureReadout, { sketch, selectedIds: ['line-1'], displayUnits: 'mm' }))

    expect(screen.getByTestId('sketch-measure-readout').textContent).not.toContain('Reference')
  })
})

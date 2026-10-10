// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolDiagram, type ToolDiagramProps } from '../../components/modals/ToolDiagram'

const standard: ToolDiagramProps = {
  type: 'drill', diameter: 3, shankDiameter: 3, overallLength: 100,
  fluteLength: 70, shoulderLength: 78, lengthBelowHolder: 85,
  angleFromAxisDeg: 59, coating: 'none',
}

const wide: ToolDiagramProps = {
  type: 'slitting_saw', diameter: 80, shankDiameter: 12, overallLength: 60,
  fluteLength: 2, shoulderLength: 20, lengthBelowHolder: 35,
  neckDiameter: 6, coating: 'none',
}

afterEach(cleanup)

describe('WO-1170 ToolDiagram fill contract retained by WO-1173', () => {
  it.each([
    ['standard', standard, 'standard'],
    ['wide', wide, 'wide'],
  ] as const)('%s layout keeps its large profile area while the viewBox grows around dimensions', (_name, props, layout) => {
    const { container } = render(<ToolDiagram {...props} />)
    const svg = container.querySelector('svg')
    expect(svg?.dataset.layout).toBe(layout)
    const drawingWidth = Number(svg?.dataset.drawingRight) - Number(svg?.dataset.drawingLeft)
    const drawingHeight = Number(svg?.dataset.drawingBottom) - Number(svg?.dataset.drawingTop)
    expect(drawingWidth > 200 || drawingHeight >= 300).toBe(true)
    const [, , viewWidth, viewHeight] = (svg?.getAttribute('viewBox') ?? '').split(/\s+/).map(Number)
    expect(viewWidth).toBeGreaterThanOrEqual(Number(svg?.dataset.drawingRight))
    expect(viewHeight).toBeGreaterThan(Number(svg?.dataset.drawingBottom))
    expect(svg?.querySelectorAll('.tool-diagram-dimension').length).toBeGreaterThanOrEqual(4)
  })
})

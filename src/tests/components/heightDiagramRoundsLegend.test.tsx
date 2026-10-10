// @vitest-environment jsdom
// The Heights tab diagram printed a resolved drill floor as
// "-15.20172133805512 mm". Its legend shows at most three decimals, and a whole
// number stays whole ("+15 mm", not "+15.000 mm").
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { HeightDiagram } from '../../components/modals/newOperationModalParts'

describe('Heights tab diagram legend', () => {
  it('rounds a resolved height to three decimals and leaves whole numbers whole', () => {
    const heights = { clearanceHeight: 15, retractHeight: 5, feedHeight: 5, topHeight: -1, bottomHeight: -3 }
    const { container } = render(createElement(HeightDiagram, {
      heights: heights as never, bottomOverride: -15.20172133805512, units: 'mm',
    }))
    const text = container.textContent || ''
    expect(text).toContain('-15.202 mm')
    expect(text).not.toContain('15.2017')
    expect(text).toContain('+15 mm')
  })
})

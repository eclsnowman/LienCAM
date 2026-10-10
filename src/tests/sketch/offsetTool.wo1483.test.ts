// WO-1483: the circle-collapse refusal message interpolated `distance` and
// `c.radius` as raw JS floats (`Offset: ${distance} mm collapses this
// circle (R${c.radius})`), while the arc-collapse refusal two lines down
// already formats its radius with `.toFixed(2)`. A refused offset whose
// radius or distance carries float noise (a common shape once a value has
// round-tripped through another computation) showed a 15+ digit raw float
// in the notice. This locks the circle message to the SAME precision as
// the arc message.

import { describe, it, expect } from 'vitest'
import { computeOffset, type OffsetSource } from '../../lib/sketch/tools/offsetTool'
import type { SketchCircleEntity } from '../../lib/sketch/types'

function circle(radius: number): SketchCircleEntity {
  return { id: 'c1', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius }
}

describe('WO-1483: offsetTool circle-collapse refusal formatting', () => {
  it('formats a noisy radius and distance at 2 decimals, matching the arc-collapse message', () => {
    // Radius carries float noise (e.g. round-tripped through another calc);
    // side=1 (shrink) with distance > radius collapses the circle.
    const noisyRadius = 11.098779134295228
    const noisyDistance = 15.000000000000002
    const source: OffsetSource = { kind: 'circle', circle: circle(noisyRadius) }
    const result = computeOffset(source, 1, noisyDistance)
    expect(typeof result).toBe('string')
    expect(result).toBe('Offset: 15.00 mm collapses this circle (R11.10)')
  })

  it('never emits a raw float with more than 2 decimal digits', () => {
    const source: OffsetSource = { kind: 'circle', circle: circle(0.30000000000000004) }
    const result = computeOffset(source, 1, 0.5)
    expect(typeof result).toBe('string')
    expect(result as string).not.toMatch(/\.\d{3,}/)
  })

  it('a clean whole-number collapse still reads cleanly (no trailing zeros stripped needed vs arc precision)', () => {
    const source: OffsetSource = { kind: 'circle', circle: circle(5) }
    const result = computeOffset(source, 1, 10)
    expect(result).toBe('Offset: 10.00 mm collapses this circle (R5.00)')
  })
})

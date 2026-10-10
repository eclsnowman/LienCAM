import { describe, expect, it } from 'vitest'
import {
  arcPointAtAngle,
  arcSamplePoints,
  arcSweepCcw,
  type ArcDensity,
} from '../../lib/sketch/sketcher/geometry/arcTessellation'

describe('canonical arc point evaluation', () => {
  it('evaluates center plus radius times cosine and sine exactly', () => {
    const arc = { center: { x: -3.25, y: 4.5 }, radius: 7.75 }
    const angle = -1.234

    const point = arcPointAtAngle(arc, angle)

    expect(point.x).toBe(arc.center.x + arc.radius * Math.cos(angle))
    expect(point.y).toBe(arc.center.y + arc.radius * Math.sin(angle))
  })

  it('agrees exactly with both endpoints emitted by the canonical sampler', () => {
    const arc = {
      center: { x: 2.5, y: -6.75 },
      radius: 12.25,
      startAngle: -0.61,
      endAngle: 2.37,
    }
    const density: ArcDensity = { kind: 'fixed', segments: 7 }

    const points = arcSamplePoints(arc, density)
    const sampledEndAngle = arc.startAngle + arcSweepCcw(arc.startAngle, arc.endAngle)

    expect(points[0]).toEqual(arcPointAtAngle(arc, arc.startAngle))
    expect(points[points.length - 1]).toEqual(arcPointAtAngle(arc, sampledEndAngle))
  })
})

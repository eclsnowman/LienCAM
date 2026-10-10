import { describe, expect, it } from 'vitest'
import { buildToolpathLayerPreviewPlan, type LayerPreviewFrame } from '../../lib/simulation/toolpathLayerPreview'

function frame(fromZ: number, toZ: number, role = 'cut'): LayerPreviewFrame {
  return {
    fromX: 0,
    fromY: 0,
    fromZ,
    toX: 1,
    toY: 0,
    toZ,
    role,
  }
}

describe('toolpath layer preview', () => {
  it('shows the complete current layer and assigns descent to the upcoming layer', () => {
    const frames = [
      frame(5, 5),
      frame(5, 5),
      frame(5, 3, 'ramp'),
      frame(3, 3),
      frame(3, 3),
    ]
    const plan = buildToolpathLayerPreviewPlan(frames, [
      { startFrame: 0, endFrame: frames.length, operationType: 'adaptive_clearing_2d' },
    ])

    expect(Array.from(plan.frameToLayer)).toEqual([0, 0, 1, 1, 1])
    expect(plan.layers).toHaveLength(2)
    expect(plan.layers[0]).toHaveLength(3)
    expect(plan.layers[1]).toHaveLength(4)
    expect(plan.layers[1][0].z).toBe(5)
    expect(plan.layers[1].at(-1)?.z).toBe(3)
  })

  it('preserves the normal full path for non-layered operations', () => {
    const frames = [frame(5, 4), frame(4, 3)]
    const plan = buildToolpathLayerPreviewPlan(frames, [
      { startFrame: 0, endFrame: frames.length, operationType: 'parallel_3d' },
    ])

    expect(Array.from(plan.frameToLayer)).toEqual([-1, -1])
    expect(plan.layers).toEqual([])
  })

  it('does not invent a layer for a continuously descending path', () => {
    const frames = [frame(5, 4, 'ramp'), frame(4, 3, 'ramp')]
    const plan = buildToolpathLayerPreviewPlan(frames, [
      { startFrame: 0, endFrame: frames.length, operationType: 'contour_2d' },
    ])

    expect(Array.from(plan.frameToLayer)).toEqual([-1, -1])
    expect(plan.layers).toEqual([])
  })
})

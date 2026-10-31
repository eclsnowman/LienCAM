import { describe, expect, it } from 'vitest'
import { commitCreationSize, resolveCreationSize, type CreationSizeDraft } from '../../lib/sketch/tools/drawValue'
import { toolPreview, type ToolState } from '../../lib/sketch/tools/toolMachine'
import type { SketchLineEntity } from '../../lib/sketch/types'
function state(mode: 'corner' | 'center'): ToolState {
  return { tool: mode === 'corner' ? 'rect-corner' : 'rect-center', chain: { kind: 'rect', mode, anchor: { x: 10, y: 20 } } }
}
let n = 0
const id = () => `creation-${n++}`
const len = (e: SketchLineEntity) => Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y)
describe('rectangle size resolution', () => {
  for (const mode of ['corner', 'center'] as const) for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    it(`${mode} full extents in quadrant ${sx},${sy} agree with preview`, () => {
      const s = state(mode), cursor = { x: 10 + sx * 15, y: 20 + sy * 8 }
      const draft = { width: 50, height: 30, signX: sx, signY: sy }
      const size = resolveCreationSize(s, cursor, draft)!
      const result = commitCreationSize(s, cursor, draft, id)!
      const lines = result.commit.entities.slice(0, 4) as SketchLineEntity[]
      expect(lines.map(len)).toEqual([50, 30, 50, 30])
      expect(toolPreview(s, size.cursor)).toEqual([...lines.map(l => l.start), lines[0].start])
      expect(result.commit.entities).toHaveLength(6)
      expect(result.commit.dimensions?.map(d => [d.kind, d.value, d.driving])).toEqual([['distance', 50, true], ['distance', 30, true]])
      expect(result.commit.constraints.some(c => c.kind === 'midpoint')).toBe(true)
      if (mode === 'center') expect(lines[0].start).toEqual({ x: 10 - sx * 25, y: 20 - sy * 15 })
    })
  }
  it('uses last nonzero signs at axes and live untyped extent', () => {
    const s = state('center'), draft = { width: 50, signX: -1, signY: -1 }
    expect(resolveCreationSize(s, { x: 10, y: 17 }, draft)).toEqual({ width: 50, height: 6, cursor: { x: -15, y: 17 } })
    expect(commitCreationSize(s, { x: 10, y: 17 }, draft, id)!.commit.dimensions).toHaveLength(1)
  })
  it('preserves construction and rejects invalid or untyped entry before allocating IDs', () => {
    const s = state('corner'), cursor = { x: 15, y: 30 }
    const result = commitCreationSize(s, cursor, { width: 20, signX: 1, signY: 1 }, id, true)!
    expect(result.commit.entities.every(e => e.construction)).toBe(true)
    const start = n
    for (const value of [null, 0, -1, Infinity, NaN]) {
      expect(commitCreationSize(s, cursor, { width: value, signX: 1, signY: 1 }, id)).toBeNull()
    }
    expect(commitCreationSize(s, cursor, null, id)).toBeNull()
    expect(n).toBe(start)
  })
  it('Shift adds equal only for a resolved square with at most one driving side', () => {
    for (const [width, height, equal] of [[20, undefined, true], [20, 20, false], [30, undefined, false], [30, 20, false]] as const) {
      const draft: CreationSizeDraft = { width, height, signX: 1, signY: 1 }
      const r = commitCreationSize(state('corner'), { x: 30, y: 40 }, draft, id, false, true)!
      expect(r.commit.constraints.some(c => c.kind === 'equal')).toBe(equal)
    }
  })
})

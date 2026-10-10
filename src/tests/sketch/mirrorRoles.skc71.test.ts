import { describe, expect, it } from 'vitest'
import { confirmToolStep } from '../../lib/sketch/tools/toolMachine'
import { mirrorAxisCandidate, mirrorClick, type MirrorChainState } from '../../lib/sketch/tools/mirrorTool'
import type { SketchEntity, SketchLineEntity } from '../../lib/sketch/types'

function line(
  id: string, x1: number, y1: number, x2: number, y2: number, construction = false,
): SketchLineEntity {
  return { id, kind: 'line', construction, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

describe('SKC-71 mirror source and reference roles', () => {
  it('keeps a rectangle side as the source when its construction reference shares an endpoint', () => {
    const source = line('rectangle-side', 0, 0, 10, 0)
    const axis = line('mirror-axis', 10, 0, 10, 20, true)
    const entities: SketchEntity[] = [source, axis]
    const chain: MirrorChainState = { kind: 'mirror', ids: [source.id] }

    expect(mirrorAxisCandidate(chain, entities, [], { x: 10, y: 0 }, 0.5)).toEqual({
      axisId: axis.id,
      ids: [source.id],
    })
    const applied = mirrorClick(chain, entities, [], { x: 10, y: 0 }, 0.5, () => 'copy')
    expect(applied.chain).toBeNull()
    expect(applied.commit?.entities).toHaveLength(1)
    expect((applied.commit?.entities[0] as SketchLineEntity).start).toEqual({ x: 20, y: 0 })
  })

  it('uses the non-source regular reference after Confirm, even at a shared endpoint', () => {
    const source = line('rectangle-side', 0, 0, 10, 0)
    const axis = line('mirror-axis', 10, 0, 10, 20)
    const entities: SketchEntity[] = [source, axis]
    const closed = confirmToolStep({ tool: 'mirror', chain: { kind: 'mirror', ids: [source.id] } })!

    expect(mirrorAxisCandidate(closed.chain as MirrorChainState, entities, [], { x: 10, y: 0 }, 0.5)).toEqual({
      axisId: axis.id,
      ids: [source.id],
    })
    const applied = mirrorClick(closed.chain as MirrorChainState, entities, [], { x: 10, y: 0 }, 0.5, () => 'copy')
    expect(applied.chain).toBeNull()
    expect(applied.commit?.constraints.filter((constraint) => constraint.kind === 'symmetric')).toHaveLength(2)
    expect(applied.commit?.entities).toHaveLength(1)
  })
})

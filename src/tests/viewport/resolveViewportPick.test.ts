// Pure unit test for resolveViewportPick (CNCViewport.ts) — the geometry-wins
// hit-resolution helper behind clicking a FIXED stock box in the 3D viewport.
//
// Contract (Commit C, fixed-stock-pickable):
//  - GEOMETRY WINS: the first hit that resolves to a part is selected even when
//    a stock face sits nearer in the ordered raycast list.
//  - If no part is hit, the first MOVABLE (fixed) stock hit is selected.
//  - A non-movable (auto) stock hit alone resolves to nothing (auto stocks are
//    never selectable/movable).
//  - No hits -> nothing (caller treats this as empty-click deselect of both).
//
// This is a PURE test: resolveViewportPick takes pre-resolved hit descriptors,
// so no jsdom / WebGL / raycaster is needed. The real raycast + gizmo attach is
// exercised in the live viewport (Operator's visual gate), not here.
import { describe, it, expect } from 'vitest'
import { resolveViewportPick, type ViewportPickHit } from '../../lib/viewport/CNCViewport'

const part = (id: string): ViewportPickHit => ({ partId: id, stock: null })
const fixedStock = (id: string): ViewportPickHit => ({ partId: null, stock: { stockId: id, movable: true } })
const autoStock = (id: string): ViewportPickHit => ({ partId: null, stock: { stockId: id, movable: false } })

describe('resolveViewportPick', () => {
  it('(a) geometry wins: a part hit beats a NEARER stock hit', () => {
    // Ordered nearest-first: stock face is nearer, part is behind it.
    const hits = [fixedStock('stock-1'), part('geo-7')]
    expect(resolveViewportPick(hits)).toEqual({ kind: 'part', id: 'geo-7' })
  })

  it('(b) only a movable (fixed) stock hit -> selects that stock', () => {
    expect(resolveViewportPick([fixedStock('stock-1')])).toEqual({ kind: 'stock', id: 'stock-1' })
  })

  it('(c) only a non-movable (auto) stock hit -> selects nothing', () => {
    expect(resolveViewportPick([autoStock('auto-1')])).toEqual({ kind: null, id: null })
  })

  it('a selected part admits a rendered auto stock as an assignment target', () => {
    expect(resolveViewportPick([autoStock('auto-1')], true)).toEqual({ kind: 'stock', id: 'auto-1' })
  })

  it('(d) no hits -> selects nothing', () => {
    expect(resolveViewportPick([])).toEqual({ kind: null, id: null })
  })

  it('picks the FIRST movable stock in order when several are hit (no part)', () => {
    const hits = [autoStock('auto-1'), fixedStock('stock-near'), fixedStock('stock-far')]
    expect(resolveViewportPick(hits)).toEqual({ kind: 'stock', id: 'stock-near' })
  })

  it('geometry wins even when the part is the LAST hit behind auto+fixed stock', () => {
    const hits = [autoStock('auto-1'), fixedStock('stock-1'), part('geo-3')]
    expect(resolveViewportPick(hits)).toEqual({ kind: 'part', id: 'geo-3' })
  })
})

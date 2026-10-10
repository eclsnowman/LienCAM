// Delete-selection transform (pulled forward from Stage 6 by user
// request): selected entities go, and every constraint/dimension that
// references a deleted entity cascades away — the document must never
// hold a dangling solver id (gcs mapping fails loud on unknown ids).

import { describe, it, expect } from 'vitest'
import { deleteFromSketch } from '../../lib/sketch/deleteSelection'
import { constraintRefIds, dimensionRefIds } from '../../lib/sketch/refIds'
import { buildDemoSketch } from '../../lib/sketch/demoSeed'

describe('deleteFromSketch', () => {
  it('deleting an entity cascades its constraints and dimensions', () => {
    const sk = buildDemoSketch()
    const r = deleteFromSketch(sk, ['demo-rect-bottom'])
    expect(r).not.toBeNull()
    expect(r!.removedEntityIds).toEqual(['demo-rect-bottom'])
    expect(r!.entities.map((e) => e.id)).not.toContain('demo-rect-bottom')
    // Constraints touching rect-bottom: c-bl, c-br, h-bottom, fix-bl.
    const cIds = r!.constraints.map((c) => c.id)
    for (const gone of ['demo-c-bl', 'demo-c-br', 'demo-h-bottom', 'demo-fix-bl']) {
      expect(cIds).not.toContain(gone)
    }
    // Unrelated constraints stay.
    expect(cIds).toContain('demo-c-tr')
    expect(cIds).toContain('demo-tangent')
    // The width dim measured rect-bottom: gone. Height dim stays.
    const dIds = r!.dimensions.map((d) => d.id)
    expect(dIds).not.toContain('demo-dim-width')
    expect(dIds).toContain('demo-dim-height')
  })

  it('no dangling references survive any entity delete (whole demo sweep)', () => {
    const sk = buildDemoSketch()
    for (const target of sk.entities.map((e) => e.id)) {
      const r = deleteFromSketch(sk, [target])
      expect(r).not.toBeNull()
      const live = new Set(r!.entities.map((e) => e.id))
      for (const c of r!.constraints) {
        for (const ref of constraintRefIds(c)) {
          expect(live.has(ref), `constraint ${c.id} dangles on ${ref}`).toBe(true)
        }
      }
      for (const d of r!.dimensions) {
        for (const ref of dimensionRefIds(d)) {
          expect(live.has(ref), `dimension ${d.id} dangles on ${ref}`).toBe(true)
        }
      }
    }
  })

  it('deleting a selected constraint removes only the constraint', () => {
    const sk = buildDemoSketch()
    const r = deleteFromSketch(sk, ['demo-tangent'])
    expect(r).not.toBeNull()
    expect(r!.entities).toHaveLength(sk.entities.length)
    expect(r!.constraints.map((c) => c.id)).not.toContain('demo-tangent')
    expect(r!.dimensions).toHaveLength(sk.dimensions.length)
  })

  it('deleting a selected dimension removes only the dimension', () => {
    const sk = buildDemoSketch()
    const r = deleteFromSketch(sk, ['demo-dim-arc-r'])
    expect(r).not.toBeNull()
    expect(r!.entities).toHaveLength(sk.entities.length)
    expect(r!.constraints).toHaveLength(sk.constraints.length)
    expect(r!.dimensions.map((d) => d.id)).not.toContain('demo-dim-arc-r')
  })

  it('multi-delete removes all selected entities in one pass', () => {
    const sk = buildDemoSketch()
    const r = deleteFromSketch(sk, ['demo-circle', 'demo-tangent-line'])
    expect(r).not.toBeNull()
    const live = r!.entities.map((e) => e.id)
    expect(live).not.toContain('demo-circle')
    expect(live).not.toContain('demo-tangent-line')
    // The tangent constraint referenced both: gone once, not crashed twice.
    expect(r!.constraints.map((c) => c.id)).not.toContain('demo-tangent')
  })

  it('returns null when the selection matches nothing', () => {
    const sk = buildDemoSketch()
    expect(deleteFromSketch(sk, ['not-a-real-id'])).toBeNull()
    expect(deleteFromSketch(sk, [])).toBeNull()
  })
})

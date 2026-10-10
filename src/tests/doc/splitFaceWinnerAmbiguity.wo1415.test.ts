import { describe, it, expect } from 'vitest'
import { ElementMap } from '../../doc/element-map'
import type { GeometrySnapshot } from '../../doc/element-map'
import type { ElementMapDelta } from '../../geom/geom-service'

// WO-1415 (BUG-491, family K2): a single-face reference to a face that a later
// op splits must bind by geometric evidence (area overlap with the parent's
// last-known snapshot), never by which fragment id sorts first. A genuinely
// symmetric split carries no evidence either way, so the resolver must report
// the unresolved outcome instead of silently picking one.

const delta = (p: Partial<ElementMapDelta> & { featureId: string }): ElementMapDelta => ({
  modified: {},
  generated: [],
  deleted: [],
  ...p,
})

const plane = (x: number, area: number): GeometrySnapshot => ({
  surfaceType: 'plane',
  centroid: { x, y: 0, z: 10 },
  area,
  normal: { x: 0, y: 0, z: 1 },
})

/** Parent 10x10 top face at x=0 split into two fragments, children listed in `order`. */
function split(children: Array<[string, GeometrySnapshot]>): ElementMap {
  const m = new ElementMap()
  m.applyDelta(delta({ featureId: 'F1', generated: ['top'] }), { top: plane(0, 100) })
  const snaps: Record<string, GeometrySnapshot> = {}
  for (const [id, snap] of children) snaps[id] = snap
  m.applyDelta(delta({ featureId: 'F2', modified: { top: children.map(([id]) => id) } }), snaps)
  return m
}

describe('WO-1415: single-face split winner is chosen by area overlap, never by id order', () => {
  it('unequal overlap: resolves to the fragment that kept most of the parent, silently', () => {
    // A 90/10 split: the big strip sits nearly on the parent centroid, the
    // sliver lies at the far edge.
    const big = plane(-0.5, 90)
    const sliver = plane(4.5, 10)
    for (const children of [
      [['a#0', big], ['a#1', sliver]],
      [['a#0', sliver], ['a#1', big]],
      [['a#1', sliver], ['a#0', big]],
    ] as Array<Array<[string, GeometrySnapshot]>>) {
      const bigId = children.find(([, s]) => s === big)![0]
      const r = split(children).resolve('top', 'single-face')
      expect(r).toEqual({ id: 'top', status: 'exact', via: 'lineage', boundTo: [bigId], diagnostics: [] })
    }
  })

  it('equal centroid distance but unequal area: the larger-overlap fragment wins regardless of id order', () => {
    // Both centroids 3mm from the parent's, so centroid distance alone ties;
    // area overlap is the evidence that breaks it.
    const wide = plane(3, 60)
    const narrow = plane(-3, 40)
    for (const [first, second] of [['p#0', 'p#1'], ['p#1', 'p#0']]) {
      const r = split([[first, narrow], [second, wide]]).resolve('top', 'single-face')
      expect(r.status).toBe('exact')
      expect(r.boundTo).toEqual([second])
      expect(r.diagnostics).toEqual([])
    }
  })

  it('symmetric split (equal distance AND equal area): reports unresolved, invariant to id names and order', () => {
    const east = plane(3, 50)
    const west = plane(-3, 50)
    const layouts: Array<Array<[string, GeometrySnapshot]>> = [
      [['top#0', east], ['top#1', west]],
      [['top#0', west], ['top#1', east]],
      [['top#1', west], ['top#0', east]],
      [['zz', east], ['aa', west]],
      [['aa', east], ['zz', west]],
    ]
    for (const children of layouts) {
      const r = split(children).resolve('top', 'single-face')
      expect(r.status).toBe('lost')
      expect(r.via).toBe('none')
      expect(r.boundTo).toEqual([])
      expect(r.diagnostics).toHaveLength(1)
      expect(r.diagnostics[0]).toMatchObject({
        code: 'REFERENCE_UNRESOLVED',
        severity: 'error',
        params: { id: 'top', reason: 'ambiguous-split', candidates: 2 },
      })
    }
  })

  it('face-set kind with the same symmetric split still binds both fragments', () => {
    const r = split([['top#0', plane(3, 50)], ['top#1', plane(-3, 50)]]).resolve('top', 'face-set')
    expect(r).toEqual({ id: 'top', status: 'exact', via: 'lineage', boundTo: ['top#0', 'top#1'], diagnostics: [] })
  })
})

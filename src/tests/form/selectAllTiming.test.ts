// Form: Select all with edges selected stays fast on a big cage (WO-2149 audit
// note: the edge list was de-duplicated with filter(indexOf), quadratic - 16 s
// with the UI frozen on a 64 x 64 x 64 box).

import { describe, expect, it } from 'vitest'
import { edgeKey } from '../../form/cage'
import { boxCage } from '../../form/starters'
import { selectAll } from '../../form/topoTools'

describe('Select all, edges, on a 64 x 64 x 64 box', () => {
  it('takes every edge once, in well under the 11 s the quadratic de-duplication took', () => {
    const cage = boxCage({ segments: { x: 64, y: 64, z: 64 } })
    const first = edgeKey(cage.faces[0][0], cage.faces[0][1])
    const t0 = performance.now()
    const all = selectAll(cage, { points: [], edges: [first], faces: [] })
    const ms = performance.now() - t0
    // a closed quad cage: every face has 4 edges, every edge 2 faces
    expect(all.edges).toHaveLength(cage.faces.length * 2)
    expect(new Set(all.edges).size).toBe(all.edges.length)
    expect(ms).toBeLessThan(3000)
  })
})

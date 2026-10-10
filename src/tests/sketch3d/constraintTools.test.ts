// Criterion 1: every constraint tool in the WO's required vocabulary, each applied to a small
// fixture via its tool action, then verified with a solve that HOLDS the invariant under a
// perturbing drag - not just "the solver accepted it once". Two layers of proof per kind:
//   1. the fixture seeds the geometry so the invariant is initially FALSE; the first solve must
//      actively move it into compliance (proves the constraint is real, not accidentally already
//      true at the seed coordinates);
//   2. a genuine Sketch3dDragSession drag (begin/move/end) on a totally decoupled "handle" line
//      forces a fresh whole-document resolve; the invariant is re-checked on that post-drag
//      solve (proves the constraint stays wired/enforced across repeated solves, not a one-shot
//      fluke of the first call).
import { afterEach, describe, expect, it } from 'vitest'
import {
  Sketch3dDragSession,
  addAngleConstraint,
  addCoincidentConstraint,
  addDiameterConstraint,
  addDistanceConstraint,
  addEqualConstraint,
  addFixedConstraint,
  addHorizontalConstraint,
  addMidpointConstraint,
  addParallelConstraint,
  addPerpendicularConstraint,
  addRadiusConstraint,
  addTangentConstraint,
  addVerticalConstraint,
  createSketch3dSolveService,
} from '../../sketch3d'
import type {
  Sketch3dCircleEntity,
  Sketch3dDocument,
  Sketch3dEntity,
  Sketch3dLineEntity,
  Sketch3dPointEntity,
  Sketch3dPointRef,
} from '../../sketch3d'

const openServices: { dispose: () => void }[] = []

afterEach(() => {
  while (openServices.length > 0) openServices.pop()?.dispose()
})

async function solver() {
  const service = await createSketch3dSolveService()
  openServices.push(service)
  return service
}

function ref(entityId: string, site: Sketch3dPointRef['site']): Sketch3dPointRef {
  return { entityId, site }
}

function withDragHandle(document: Sketch3dDocument): { document: Sketch3dDocument; dragPoint: Sketch3dPointRef } {
  return {
    document: {
      ...document,
      entities: [
        ...document.entities,
        { id: 'handle', kind: 'line', start: { x: 500, y: 500 }, end: { x: 520, y: 500 } },
      ],
      constraints: [
        ...document.constraints,
        { id: 'handleFix', kind: 'fixed', point: ref('handle', 'start') },
      ],
    },
    dragPoint: ref('handle', 'end'),
  }
}

async function verifyHoldsUnderPerturbingDrag(
  baseDocument: Sketch3dDocument,
  invariant: (entities: Sketch3dEntity[]) => void,
): Promise<void> {
  const { document, dragPoint } = withDragHandle(baseDocument)
  const service = await solver()

  const seed = service.solve(document)
  expect(['success', 'redundant']).toContain(seed.status)
  invariant(seed.entities)

  const session = new Sketch3dDragSession(service, document)
  session.begin(dragPoint, { x: 520, y: 500 })
  session.move({ x: 560, y: 540 })
  const end = session.end()
  expect(['success', 'redundant']).toContain(end.status)
  invariant(end.entities)
}

function findLine(entities: Sketch3dEntity[], id: string): Sketch3dLineEntity {
  const entity = entities.find((candidate) => candidate.id === id)
  if (!entity || entity.kind !== 'line') throw new Error(`missing line '${id}'`)
  return entity
}

function findPoint(entities: Sketch3dEntity[], id: string): Sketch3dPointEntity {
  const entity = entities.find((candidate) => candidate.id === id)
  if (!entity || entity.kind !== 'point') throw new Error(`missing point '${id}'`)
  return entity
}

function findCircle(entities: Sketch3dEntity[], id: string): Sketch3dCircleEntity {
  const entity = entities.find((candidate) => candidate.id === id)
  if (!entity || entity.kind !== 'circle') throw new Error(`missing circle '${id}'`)
  return entity
}

function lengthOf(l: Sketch3dLineEntity): number {
  return Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y)
}

function directionOf(l: Sketch3dLineEntity): { x: number; y: number } {
  return { x: l.end.x - l.start.x, y: l.end.y - l.start.y }
}

// Perpendicular distance from `p` to the infinite line through l.start/l.end.
function pointToLineDistance(p: { x: number; y: number }, l: Sketch3dLineEntity): number {
  const dx = l.end.x - l.start.x
  const dy = l.end.y - l.start.y
  const cross = dx * (p.y - l.start.y) - dy * (p.x - l.start.x)
  return Math.abs(cross) / Math.hypot(dx, dy)
}

describe('sketch3d constraint tools (criterion 1)', () => {
  it('coincident: holds two line endpoints together', async () => {
    const doc: Sketch3dDocument = {
      id: 'tc',
      entities: [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', start: { x: 5, y: 5 }, end: { x: 5, y: 15 } },
      ],
      constraints: [{ id: 'fix1', kind: 'fixed', point: ref('l1', 'start') }],
    }
    const withTool = addCoincidentConstraint(doc, 'tco', ref('l1', 'end'), ref('l2', 'start'))
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const l1 = findLine(entities, 'l1')
      const l2 = findLine(entities, 'l2')
      expect(l1.end.x).toBeCloseTo(l2.start.x, 6)
      expect(l1.end.y).toBeCloseTo(l2.start.y, 6)
    })
  })

  it('horizontal: holds a line level', async () => {
    const doc: Sketch3dDocument = {
      id: 'th',
      entities: [{ id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 7 } }],
      constraints: [{ id: 'fix1', kind: 'fixed', point: ref('l1', 'start') }],
    }
    const withTool = addHorizontalConstraint(doc, 'thor', { line: 'l1' })
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const l1 = findLine(entities, 'l1')
      expect(l1.end.y).toBeCloseTo(l1.start.y, 6)
    })
  })

  it('vertical: holds a line plumb', async () => {
    const doc: Sketch3dDocument = {
      id: 'tv',
      entities: [{ id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 7, y: 10 } }],
      constraints: [{ id: 'fix1', kind: 'fixed', point: ref('l1', 'start') }],
    }
    const withTool = addVerticalConstraint(doc, 'tver', { line: 'l1' })
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const l1 = findLine(entities, 'l1')
      expect(l1.end.x).toBeCloseTo(l1.start.x, 6)
    })
  })

  it('parallel: holds two lines aligned', async () => {
    const doc: Sketch3dDocument = {
      id: 'tpar',
      entities: [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', start: { x: 0, y: 20 }, end: { x: 5, y: 25 } },
      ],
      constraints: [
        { id: 'fix1a', kind: 'fixed', point: ref('l1', 'start') },
        { id: 'fix1b', kind: 'fixed', point: ref('l1', 'end') },
        { id: 'fix2', kind: 'fixed', point: ref('l2', 'start') },
      ],
    }
    const withTool = addParallelConstraint(doc, 'tparc', 'l1', 'l2')
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const l1 = findLine(entities, 'l1')
      const l2 = findLine(entities, 'l2')
      const d1 = directionOf(l1)
      const d2 = directionOf(l2)
      const cross = d1.x * d2.y - d1.y * d2.x
      expect(cross / (Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y))).toBeCloseTo(0, 6)
    })
  })

  it('perpendicular: holds two lines at a right angle', async () => {
    const doc: Sketch3dDocument = {
      id: 'tperp',
      entities: [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', start: { x: 0, y: 20 }, end: { x: 5, y: 25 } },
      ],
      constraints: [
        { id: 'fix1a', kind: 'fixed', point: ref('l1', 'start') },
        { id: 'fix1b', kind: 'fixed', point: ref('l1', 'end') },
        { id: 'fix2', kind: 'fixed', point: ref('l2', 'start') },
      ],
    }
    const withTool = addPerpendicularConstraint(doc, 'tperpc', 'l1', 'l2')
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const l1 = findLine(entities, 'l1')
      const l2 = findLine(entities, 'l2')
      const d1 = directionOf(l1)
      const d2 = directionOf(l2)
      const dot = d1.x * d2.x + d1.y * d2.y
      expect(dot / (Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y))).toBeCloseTo(0, 6)
    })
  })

  it('tangent: holds a line tangent to a circle', async () => {
    const doc: Sketch3dDocument = {
      id: 'ttan',
      entities: [
        // radius is seeded directly at the intended value: no separate radius/diameter
        // constraint is needed to hold it (nothing else in this fixture touches the radius
        // parameter, so it stays put) - keeps this test isolated to the tangent tool alone.
        { id: 'c1', kind: 'circle', center: { x: 0, y: 0 }, radius: 5 },
        { id: 'l1', kind: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 10 } },
      ],
      constraints: [
        { id: 'fixc', kind: 'fixed', entityId: 'c1' },
        { id: 'fixl', kind: 'fixed', point: ref('l1', 'start') },
      ],
    }
    const withTool = addTangentConstraint(doc, 'ttanc', 'l1', 'c1')
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const c1 = findCircle(entities, 'c1')
      const l1 = findLine(entities, 'l1')
      expect(pointToLineDistance(c1.center, l1)).toBeCloseTo(c1.radius, 5)
    })
  })

  it('equal: holds two line lengths equal', async () => {
    const doc: Sketch3dDocument = {
      id: 'teq',
      entities: [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', start: { x: 0, y: 20 }, end: { x: 3, y: 20 } },
      ],
      constraints: [
        { id: 'fix1a', kind: 'fixed', point: ref('l1', 'start') },
        { id: 'fix1b', kind: 'fixed', point: ref('l1', 'end') },
        { id: 'fix2', kind: 'fixed', point: ref('l2', 'start') },
      ],
    }
    const withTool = addEqualConstraint(doc, 'teqc', 'l1', 'l2')
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const l1 = findLine(entities, 'l1')
      const l2 = findLine(entities, 'l2')
      expect(lengthOf(l2)).toBeCloseTo(lengthOf(l1), 6)
    })
  })

  it('midpoint: holds a point at a line midpoint', async () => {
    const doc: Sketch3dDocument = {
      id: 'tmid',
      entities: [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'p1', kind: 'point', at: { x: 5, y: 8 } },
      ],
      constraints: [
        { id: 'fix1a', kind: 'fixed', point: ref('l1', 'start') },
        { id: 'fix1b', kind: 'fixed', point: ref('l1', 'end') },
      ],
    }
    const withTool = addMidpointConstraint(doc, 'tmidc', ref('p1', 'self'), 'l1')
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const l1 = findLine(entities, 'l1')
      const p1 = findPoint(entities, 'p1')
      expect(p1.at.x).toBeCloseTo((l1.start.x + l1.end.x) / 2, 6)
      expect(p1.at.y).toBeCloseTo((l1.start.y + l1.end.y) / 2, 6)
    })
  })

  it('distance (point-point): holds two points a fixed distance apart', async () => {
    const doc: Sketch3dDocument = {
      id: 'tdist',
      entities: [
        { id: 'a', kind: 'point', at: { x: 0, y: 0 } },
        { id: 'b', kind: 'point', at: { x: 100, y: 100 } },
      ],
      constraints: [{ id: 'fixa', kind: 'fixed', point: ref('a', 'self') }],
    }
    const withTool = addDistanceConstraint(doc, 'tdistc', ref('a', 'self'), { b: ref('b', 'self') }, 15)
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const a = findPoint(entities, 'a')
      const b = findPoint(entities, 'b')
      expect(Math.hypot(b.at.x - a.at.x, b.at.y - a.at.y)).toBeCloseTo(15, 6)
    })
  })

  it('distance (point-line): holds a point a fixed distance from a line', async () => {
    const doc: Sketch3dDocument = {
      id: 'tdistl',
      entities: [
        { id: 'a', kind: 'point', at: { x: 0, y: 0 } },
        { id: 'l1', kind: 'line', start: { x: 10, y: -5 }, end: { x: 10, y: 5 } },
      ],
      constraints: [
        { id: 'fix1a', kind: 'fixed', point: ref('l1', 'start') },
        { id: 'fix1b', kind: 'fixed', point: ref('l1', 'end') },
      ],
    }
    const withTool = addDistanceConstraint(doc, 'tdistlc', ref('a', 'self'), { line: 'l1' }, 7)
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const a = findPoint(entities, 'a')
      const l1 = findLine(entities, 'l1')
      expect(pointToLineDistance(a.at, l1)).toBeCloseTo(7, 5)
    })
  })

  it('angle: holds a fixed angle between two lines', async () => {
    const doc: Sketch3dDocument = {
      id: 'tang',
      entities: [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', start: { x: 0, y: 20 }, end: { x: 5, y: 21 } },
      ],
      constraints: [
        { id: 'fix1a', kind: 'fixed', point: ref('l1', 'start') },
        { id: 'fix1b', kind: 'fixed', point: ref('l1', 'end') },
        { id: 'fix2', kind: 'fixed', point: ref('l2', 'start') },
      ],
    }
    const withTool = addAngleConstraint(doc, 'tangc', 'l1', 'l2', Math.PI / 3)
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const l1 = findLine(entities, 'l1')
      const l2 = findLine(entities, 'l2')
      const d1 = directionOf(l1)
      const d2 = directionOf(l2)
      const dot = d1.x * d2.x + d1.y * d2.y
      const angleBetween = Math.acos(dot / (Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)))
      expect(angleBetween).toBeCloseTo(Math.PI / 3, 5)
    })
  })

  it('radius: holds a circle radius', async () => {
    const doc: Sketch3dDocument = {
      id: 'trad',
      entities: [{ id: 'c1', kind: 'circle', center: { x: 0, y: 0 }, radius: 3 }],
      constraints: [{ id: 'fixc', kind: 'fixed', entityId: 'c1' }],
    }
    const withTool = addRadiusConstraint(doc, 'tradc', 'c1', 9)
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      expect(findCircle(entities, 'c1').radius).toBeCloseTo(9, 6)
    })
  })

  it('diameter: holds a circle diameter', async () => {
    const doc: Sketch3dDocument = {
      id: 'tdia',
      entities: [{ id: 'c1', kind: 'circle', center: { x: 0, y: 0 }, radius: 3 }],
      constraints: [{ id: 'fixc', kind: 'fixed', entityId: 'c1' }],
    }
    const withTool = addDiameterConstraint(doc, 'tdiac', 'c1', 20)
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      expect(findCircle(entities, 'c1').radius * 2).toBeCloseTo(20, 6)
    })
  })

  // Not in the WO's required kind list, but exercised heavily as scaffolding above (every
  // fixture anchors itself via addFixedConstraint) - one direct test closes the loop.
  it('fixed: holds a point in place', async () => {
    const doc: Sketch3dDocument = {
      id: 'tfix',
      entities: [{ id: 'p1', kind: 'point', at: { x: 3, y: 4 } }],
      constraints: [],
    }
    const withTool = addFixedConstraint(doc, 'tfixc', { point: ref('p1', 'self') })
    await verifyHoldsUnderPerturbingDrag(withTool, (entities) => {
      const p1 = findPoint(entities, 'p1')
      expect(p1.at.x).toBeCloseTo(3, 6)
      expect(p1.at.y).toBeCloseTo(4, 6)
    })
  })
})

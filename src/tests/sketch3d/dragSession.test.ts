import { afterEach, describe, expect, it } from 'vitest'
import {
  Sketch3dDragSession,
  createSketch3dSolveService,
  resetSketch3dGcsSystemConstructCountForTest,
  sketch3dGcsSystemConstructCountForTest,
} from '../../sketch3d'
import type { Sketch3dSolveService } from '../../sketch3d'
import { bracketDragFixture, chainDragFixture } from './dragFixtures'

const openServices: Sketch3dSolveService[] = []

afterEach(() => {
  while (openServices.length > 0) openServices.pop()?.dispose()
})

async function solver(): Promise<Sketch3dSolveService> {
  const service = await createSketch3dSolveService()
  openServices.push(service)
  return service
}

describe('sketch3d drag session lifecycle (criterion 1)', () => {
  it('leaves DOF and the constraint set identical after end() as they were before begin()', async () => {
    const service = await solver()
    const { document, dragPoint } = chainDragFixture(12)

    const before = service.solve(document)
    expect(before.status).toBe('success')
    expect(before.dof).toBe(2)

    const session = new Sketch3dDragSession(service, document)
    const begun = session.begin(dragPoint, { x: 100, y: 100 })
    expect(begun.status).toBe('success')

    session.move({ x: 50, y: 20 })
    session.move({ x: 10, y: 5 })

    const after = session.end()
    expect(after.status).toBe('success')
    expect(after.dof).toBe(before.dof)
    expect(after.conflicting).toEqual(before.conflicting)
    expect(after.redundant).toEqual(before.redundant)

    // the base document's constraint set was never mutated by the session (no leaked temporaries)
    expect(document.constraints.some((constraint) => constraint.id.startsWith('__sketch3d_drag'))).toBe(false)
    const reSolved = service.solve(document)
    expect(reSolved.dof).toBe(before.dof)
  })

  it('does not reduce the reported DOF while the temporary drag pin is active (fails-if)', async () => {
    const service = await solver()
    const { document, dragPoint } = chainDragFixture(12)

    const before = service.solve(document)
    expect(before.status).toBe('success')
    expect(before.dof).toBe(2)

    const session = new Sketch3dDragSession(service, document)
    // Every non-conflicting move must report the base sketch's DOF (2), never the pinned
    // working document's DOF (0) - a temporary drag constraint must not appear to consume
    // DOF from the caller's perspective, even though it is a real, driving constraint under
    // the hood (see dragSession.ts's dragConstraint() comment).
    const begun = session.begin(dragPoint, { x: 100, y: 100 })
    expect(begun.status).toBe('success')
    expect(begun.dof).toBe(before.dof)

    const moved1 = session.move({ x: 50, y: 20 })
    expect(moved1.dof).toBe(before.dof)
    const moved2 = session.move({ x: 10, y: 5 })
    expect(moved2.dof).toBe(before.dof)

    session.end()
  })

  it('commits the last dragged position on end(), not the pre-drag geometry', async () => {
    const service = await solver()
    const { document, dragPoint } = chainDragFixture(12)

    const before = service.solve(document)
    expect(before.status).toBe('success')
    const originalLine = before.entities.find((entity) => entity.id === 'cl11')
    if (originalLine?.kind !== 'line') throw new Error('expected line entity')

    const session = new Sketch3dDragSession(service, document)
    session.begin(dragPoint, { x: 100, y: 100 })
    const moved = session.move({ x: 42, y: 17 })
    expect(moved.status).toBe('success')
    const draggedLine = moved.entities.find((entity) => entity.id === 'cl11')
    if (draggedLine?.kind !== 'line') throw new Error('expected line entity')

    const ended = session.end()
    expect(ended.status).toBe('success')
    const endedLine = ended.entities.find((entity) => entity.id === 'cl11')
    if (endedLine?.kind !== 'line') throw new Error('expected line entity')

    // released geometry matches where the drag left it, within solver tolerance - NOT a
    // revert to the pre-drag original position.
    expect(endedLine.end.x).toBeCloseTo(draggedLine.end.x, 6)
    expect(endedLine.end.y).toBeCloseTo(draggedLine.end.y, 6)
    const movedFromOriginal =
      Math.abs(draggedLine.end.x - originalLine.end.x) > 1 || Math.abs(draggedLine.end.y - originalLine.end.y) > 1
    expect(movedFromOriginal).toBe(true)
  })

})

describe('sketch3d drag session system reuse (criterion 2)', () => {
  it('constructs the underlying planegcs system at most once across a whole drag session', async () => {
    resetSketch3dGcsSystemConstructCountForTest()
    const service = await solver()
    expect(sketch3dGcsSystemConstructCountForTest()).toBe(1)

    const { document, dragPoint } = chainDragFixture(20)
    const session = new Sketch3dDragSession(service, document)
    session.begin(dragPoint, { x: 1, y: 1 })
    for (let i = 0; i < 20; i++) {
      session.move({ x: i, y: i * 0.5 })
    }
    session.end()

    expect(sketch3dGcsSystemConstructCountForTest()).toBe(1)
  })
})

describe('sketch3d drag session solve correctness (criterion 3)', () => {
  it('follows the cursor to the exact fixed-point reference solution on each move', async () => {
    const dragService = await solver()
    const referenceService = await solver()
    const { document, dragPoint } = bracketDragFixture()

    const session = new Sketch3dDragSession(dragService, document)
    const cursors = [
      { x: 12, y: 30 },
      { x: -3, y: 22 },
      { x: 8, y: 18 },
    ]

    const moves = [session.begin(dragPoint, cursors[0]), ...cursors.slice(1).map((c) => session.move(c))]
    for (let i = 0; i < cursors.length; i++) {
      const cursor = cursors[i]
      const move = moves[i]
      expect(move.status).toBe('success')

      const referenceDoc: typeof document = {
        id: document.id,
        entities: document.entities,
        constraints: [
          ...document.constraints,
          { id: 'reference-fix', kind: 'fixed', point: dragPoint },
        ],
      }
      // pin the reference solve's seed so both solves start from the same neighborhood
      const seeded = {
        ...referenceDoc,
        entities: referenceDoc.entities.map((entity) =>
          entity.id === 'bl3' && entity.kind === 'line' ? { ...entity, end: cursor } : entity,
        ),
      }
      const reference = referenceService.solve(seeded)
      expect(reference.status).toBe('success')

      const draggedPoint = move.entities.find((entity) => entity.id === 'bl3')
      const referencePoint = reference.entities.find((entity) => entity.id === 'bl3')
      if (draggedPoint?.kind !== 'line' || referencePoint?.kind !== 'line') {
        throw new Error('expected line entities')
      }
      expect(draggedPoint.end.x).toBeCloseTo(referencePoint.end.x, 9)
      expect(draggedPoint.end.y).toBeCloseTo(referencePoint.end.y, 9)
    }

    session.end()
  })

  it('surfaces the conflict report on an over-constrained drag attempt without corrupting state, and end() restores cleanly', async () => {
    const service = await solver()
    const { document, dragPoint } = chainDragFixture(6)

    // Fully constrain the drag point too, so dragging it necessarily over-constrains the sketch.
    const overConstrained: typeof document = {
      ...document,
      constraints: [
        ...document.constraints,
        { id: 'lock-end', kind: 'fixed', point: dragPoint },
      ],
    }
    const baseline = service.solve(overConstrained)
    expect(baseline.status).toBe('success')
    expect(baseline.dof).toBe(0)

    const session = new Sketch3dDragSession(service, overConstrained)
    const begun = session.begin(dragPoint, { x: 999, y: 999 })
    expect(begun.status).toBe('conflicting')
    expect(begun.conflicting.length).toBeGreaterThan(0)

    const moved = session.move({ x: -50, y: -50 })
    expect(moved.status).toBe('conflicting')

    const ended = session.end()
    expect(ended.status).toBe('success')
    expect(ended.dof).toBe(0)

    // solving the untouched original document again gives the identical baseline result
    const reSolved = service.solve(overConstrained)
    expect(reSolved.status).toBe('success')
    expect(reSolved.dof).toBe(baseline.dof)
  })
})

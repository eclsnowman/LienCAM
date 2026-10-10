import { describe, expect, it } from 'vitest'
import type { GcsWrapper } from '@salusoft89/planegcs'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper, type SketchSolveOutcome } from '../../lib/sketch/solver/gcsMapping'
import { chamferLines, type ChamferResult } from '../../lib/sketch/tools/chamferTool'
import { buildRectCommit } from '../../lib/sketch/tools/rectTools'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import type {
  PointRef,
  Sketch,
  SketchArcEntity,
  SketchConstraint,
  SketchDimension,
  SketchEntity,
  SketchLineEntity,
  Vec2,
} from '../../lib/sketch/types'

let wrapperPromise: Promise<GcsWrapper> | null = null
const getWrapper = () => (wrapperPromise ??= createGcsWrapper())

function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}

function pointAt(entity: SketchLineEntity, site: 'start' | 'end'): Vec2 {
  return entity[site]
}

function asLine(entities: SketchEntity[], id: string): SketchLineEntity {
  const entity = entities.find((candidate) => candidate.id === id)
  expect(entity?.kind).toBe('line')
  return entity as SketchLineEntity
}

function asArc(entities: SketchEntity[], id: string): SketchArcEntity {
  const entity = entities.find((candidate) => candidate.id === id)
  expect(entity?.kind).toBe('arc')
  return entity as SketchArcEntity
}

function arcPoint(entity: SketchArcEntity, site: 'start' | 'end'): Vec2 {
  const angle = site === 'start' ? entity.startAngle : entity.endAngle
  return {
    x: entity.center.x + entity.radius * Math.cos(angle),
    y: entity.center.y + entity.radius * Math.sin(angle),
  }
}

function bbox(entities: SketchEntity[], sideIds: string[]) {
  const points = entities
    .filter((entity): entity is SketchLineEntity =>
      entity.kind === 'line' && sideIds.includes(entity.id))
    .flatMap((entity) => [entity.start, entity.end])
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

function lineIntersection(a: SketchLineEntity, b: SketchLineEntity): Vec2 {
  const dax = a.end.x - a.start.x
  const day = a.end.y - a.start.y
  const dbx = b.end.x - b.start.x
  const dby = b.end.y - b.start.y
  const denominator = dax * dby - day * dbx
  expect(Math.abs(denominator)).toBeGreaterThan(1e-9)
  const wx = b.start.x - a.start.x
  const wy = b.start.y - a.start.y
  const t = (wx * dby - wy * dbx) / denominator
  return { x: a.start.x + t * dax, y: a.start.y + t * day }
}

function acuteLineAngleDeg(line: SketchLineEntity): number {
  const raw = Math.abs(Math.atan2(
    line.end.y - line.start.y,
    line.end.x - line.start.x,
  ) * 180 / Math.PI) % 180
  return raw > 90 ? 180 - raw : raw
}

function expectClean(out: SketchSolveOutcome, expectedDof: number) {
  expect(out.ok).toBe(true)
  expect(out.status.dof).toBe(expectedDof)
  expect(out.status.conflicting).toEqual([])
  expect(out.status.redundant).toEqual([])
}

const CORNERS = [
  { a: 3, b: 0, hintA: { x: 0, y: 60 }, hintB: { x: 80, y: 0 }, at: { x: 0, y: 0 } },
  { a: 0, b: 1, hintA: { x: 0, y: 0 }, hintB: { x: 80, y: 60 }, at: { x: 80, y: 0 } },
  { a: 1, b: 2, hintA: { x: 80, y: 0 }, hintB: { x: 0, y: 60 }, at: { x: 80, y: 60 } },
  { a: 2, b: 3, hintA: { x: 80, y: 60 }, hintB: { x: 0, y: 0 }, at: { x: 0, y: 60 } },
] as const

interface RectChamferFixture {
  sketch: Sketch
  result: ChamferResult
  sideIds: string[]
  hostAId: string
  hostBId: string
  diagonalId: string
  diagonalSite: 'start' | 'end' | null
  widthDimId: string
  heightDimId: string
}

function rectangleChamfer(cornerIndex = 2): RectChamferFixture {
  let rectId = 0
  const commit = buildRectCommit(
    { x: 0, y: 0 }, { x: 80, y: 60 }, false, () => `rect-${rectId++}`,
  )
  const sideIds = commit.entities.slice(0, 4).map((entity) => entity.id)
  const diagonal = commit.entities.find(
    (entity): entity is SketchLineEntity => entity.kind === 'line' && entity.construction,
  )
  if (!diagonal) throw new Error('rectangle fixture is missing its defining diagonal')
  const widthDimId = 'fixture-width'
  const heightDimId = 'fixture-height'
  const sketch: Sketch = {
    id: `rect-corner-${cornerIndex}`,
    layerId: 'fixture-layer',
    entities: commit.entities,
    constraints: [
      ...commit.constraints,
      { id: 'fixture-origin', kind: 'fix', point: ref(diagonal.id, 'start') },
    ],
    dimensions: [
      {
        id: widthDimId, kind: 'distanceX', driving: true, value: 80,
        a: ref(diagonal.id, 'start'), b: ref(diagonal.id, 'end'),
      },
      {
        id: heightDimId, kind: 'distanceY', driving: true, value: 60,
        a: ref(diagonal.id, 'start'), b: ref(diagonal.id, 'end'),
      },
    ],
    solveStatus: null,
  }
  const corner = CORNERS[cornerIndex]
  let chamferId = 0
  const result = chamferLines(
    sketch as unknown as SketchDoc,
    sideIds[corner.a],
    sideIds[corner.b],
    corner.hintA,
    corner.hintB,
    5,
    () => `chamfer-${cornerIndex}-${chamferId++}`,
  )
  if (typeof result === 'string') throw new Error(result)
  return {
    sketch: {
      ...sketch,
      entities: result.transform.entities,
      constraints: result.transform.constraints,
      dimensions: result.transform.dimensions,
    },
    result,
    sideIds,
    hostAId: sideIds[corner.a],
    hostBId: sideIds[corner.b],
    diagonalId: diagonal.id,
    diagonalSite: cornerIndex === 0 ? 'start' : cornerIndex === 2 ? 'end' : null,
    widthDimId,
    heightDimId,
  }
}

function expectFiveMillimeterSetbacks(
  entities: SketchEntity[], fixture: RectChamferFixture,
) {
  const phantom = entities.find(
    (entity): entity is Extract<SketchEntity, { kind: 'point' }> =>
      entity.id === fixture.result.phantomPointId && entity.kind === 'point',
  )
  expect(phantom).toBeDefined()
  const hostA = asLine(entities, fixture.hostAId)
  const hostB = asLine(entities, fixture.hostBId)
  const dimA = fixture.sketch.dimensions.find(
    (dimension) => dimension.id === fixture.result.setbackDimAId,
  )
  const dimB = fixture.sketch.dimensions.find(
    (dimension) => dimension.id === fixture.result.setbackDimBId,
  )
  expect(dimA?.kind).toBe('distance')
  expect(dimB?.kind).toBe('distance')
  if (!phantom || dimA?.kind !== 'distance' || dimB?.kind !== 'distance') return
  expect(Math.hypot(
    pointAt(hostA, dimA.b.site as 'start' | 'end').x - phantom.at.x,
    pointAt(hostA, dimA.b.site as 'start' | 'end').y - phantom.at.y,
  )).toBeCloseTo(5, 5)
  expect(Math.hypot(
    pointAt(hostB, dimB.b.site as 'start' | 'end').x - phantom.at.x,
    pointAt(hostB, dimB.b.site as 'start' | 'end').y - phantom.at.y,
  )).toBeCloseTo(5, 5)
}

function expectTheoreticalCornerAtHostIntersection(
  entities: SketchEntity[], fixture: RectChamferFixture,
) {
  const phantom = entities.find(
    (entity): entity is Extract<SketchEntity, { kind: 'point' }> =>
      entity.id === fixture.result.phantomPointId && entity.kind === 'point',
  )
  expect(phantom).toBeDefined()
  if (!phantom) return
  const intersection = lineIntersection(
    asLine(entities, fixture.hostAId),
    asLine(entities, fixture.hostBId),
  )
  expect(phantom.at.x).toBeCloseTo(intersection.x, 5)
  expect(phantom.at.y).toBeCloseTo(intersection.y, 5)
  if (fixture.diagonalSite) {
    const diagonalAt = pointAt(asLine(entities, fixture.diagonalId), fixture.diagonalSite)
    expect(diagonalAt.x).toBeCloseTo(intersection.x, 5)
    expect(diagonalAt.y).toBeCloseTo(intersection.y, 5)
  }
}

interface DualAnchorFixture {
  base: Sketch
  sketch: Sketch
  result: ChamferResult
  anchorId: string
  hostAId: string
  hostBId: string
}

type TieOrientation = 'forward' | 'reversed' | 'mixed'

function dualHostAnchorChamfer(orientation: TieOrientation = 'forward'): DualAnchorFixture {
  const hostA: SketchLineEntity = {
    id: 'dual-a', kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
  }
  const hostB: SketchLineEntity = {
    id: 'dual-b', kind: 'line', construction: false,
    start: { x: 10, y: 0 }, end: { x: 10, y: 10 },
  }
  const anchorId = 'dual-anchor'
  const anchor: SketchEntity = {
    id: anchorId, kind: 'point', construction: true, at: { x: 10, y: 0 },
  }
  const tie = (id: string, host: PointRef): SketchConstraint => {
    const reversed = orientation === 'reversed' || (orientation === 'mixed' && id === 'tie-b')
    return {
      id,
      kind: 'coincident',
      a: reversed ? host : ref(anchorId, 'self'),
      b: reversed ? ref(anchorId, 'self') : host,
    }
  }
  const base: Sketch = {
    id: `dual-${orientation}`,
    layerId: 'fixture-layer',
    entities: [hostA, hostB, anchor],
    constraints: [
      { id: 'dual-fix-a-start', kind: 'fix', point: ref(hostA.id, 'start') },
      { id: 'dual-fix-a-end', kind: 'fix', point: ref(hostA.id, 'end') },
      { id: 'dual-fix-b-end', kind: 'fix', point: ref(hostB.id, 'end') },
      tie('tie-a', ref(hostA.id, 'end')),
      tie('tie-b', ref(hostB.id, 'start')),
    ],
    dimensions: [],
    solveStatus: null,
  }
  let id = 0
  const result = chamferLines(
    base as unknown as SketchDoc,
    hostA.id,
    hostB.id,
    hostA.start,
    hostB.end,
    2,
    () => `dual-chamfer-${id++}`,
  )
  if (typeof result === 'string') throw new Error(result)
  return {
    base,
    sketch: {
      ...base,
      entities: result.transform.entities,
      constraints: result.transform.constraints,
      dimensions: result.transform.dimensions,
    },
    result,
    anchorId,
    hostAId: hostA.id,
    hostBId: hostB.id,
  }
}

function anchorToPhantomTies(fixture: DualAnchorFixture): SketchConstraint[] {
  return fixture.sketch.constraints.filter((constraint) =>
    constraint.kind === 'coincident' &&
    ((constraint.a.entityId === fixture.anchorId && constraint.a.site === 'self' &&
      constraint.b.entityId === fixture.result.phantomPointId && constraint.b.site === 'self') ||
     (constraint.b.entityId === fixture.anchorId && constraint.b.site === 'self' &&
      constraint.a.entityId === fixture.result.phantomPointId && constraint.a.site === 'self')))
}

function expectDualAnchorStructure(fixture: DualAnchorFixture) {
  expect(anchorToPhantomTies(fixture).map((constraint) => constraint.id)).toEqual(['tie-a'])
  expect(fixture.sketch.constraints.filter(
    (constraint): constraint is Extract<SketchConstraint, { kind: 'point_on_object' }> =>
      constraint.kind === 'point_on_object' &&
      constraint.point.entityId === fixture.result.phantomPointId &&
      constraint.point.site === 'self',
  )
    .map((constraint) => constraint.object)).toEqual([fixture.hostAId, fixture.hostBId])
  const expectedSetbacks = [
    { id: fixture.result.setbackDimAId, hostId: fixture.hostAId, site: 'end' },
    { id: fixture.result.setbackDimBId, hostId: fixture.hostBId, site: 'start' },
  ] as const
  for (const expected of expectedSetbacks) {
    expect(fixture.sketch.dimensions.find((dimension) => dimension.id === expected.id))
      .toMatchObject({
        id: expected.id,
        kind: 'distance',
        driving: true,
        value: 2,
        a: { entityId: fixture.result.phantomPointId, site: 'self' },
        b: { entityId: expected.hostId, site: expected.site },
      })
  }
}

function expectTwoMillimeterSetbacks(entities: SketchEntity[], fixture: DualAnchorFixture) {
  const phantom = entities.find(
    (entity): entity is Extract<SketchEntity, { kind: 'point' }> =>
      entity.id === fixture.result.phantomPointId && entity.kind === 'point',
  )
  expect(phantom).toBeDefined()
  if (!phantom) return
  for (const dimensionId of [fixture.result.setbackDimAId, fixture.result.setbackDimBId]) {
    const dimension = fixture.sketch.dimensions.find((candidate) => candidate.id === dimensionId)
    expect(dimension?.kind).toBe('distance')
    if (!dimension || dimension.kind !== 'distance') continue
    const host = asLine(entities, dimension.b.entityId)
    const at = pointAt(host, dimension.b.site as 'start' | 'end')
    expect(Math.hypot(at.x - phantom.at.x, at.y - phantom.at.y)).toBeCloseTo(2, 6)
  }
}

interface ArcChamferFixture {
  sketch: Sketch
  result: ChamferResult
  arcId: string
  hostBId: string
  site: 'start' | 'end'
  originalArc: SketchArcEntity
}

function realArcChamfer(site: 'start' | 'end'): ArcChamferFixture {
  const hostA: SketchLineEntity = {
    id: `arc-${site}-a`, kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
  }
  const hostB: SketchLineEntity = {
    id: `arc-${site}-b`, kind: 'line', construction: false,
    start: { x: 10, y: 0 }, end: { x: 10, y: 10 },
  }
  const arcId = `real-arc-${site}`
  const originalArc: SketchArcEntity = {
    id: arcId,
    kind: 'arc',
    construction: false,
    center: { x: 15, y: 0 },
    radius: 5,
    startAngle: site === 'start' ? Math.PI : Math.PI / 2,
    endAngle: site === 'end' ? Math.PI : Math.PI * 1.5,
  }
  const base: Sketch = {
    id: `arc-${site}-fixture`,
    layerId: 'fixture-layer',
    entities: [hostA, hostB, originalArc],
    constraints: [
      {
        id: `arc-${site}-corner`, kind: 'coincident',
        a: ref(hostA.id, 'end'), b: ref(hostB.id, 'start'),
      },
      {
        id: `arc-${site}-tie`, kind: 'coincident',
        a: ref(arcId, site), b: ref(hostB.id, 'start'),
      },
    ],
    dimensions: [],
    solveStatus: null,
  }
  let id = 0
  const result = chamferLines(
    base as unknown as SketchDoc,
    hostA.id,
    hostB.id,
    hostA.start,
    hostB.end,
    2,
    () => `arc-${site}-chamfer-${id++}`,
  )
  if (typeof result === 'string') throw new Error(result)
  return {
    sketch: {
      ...base,
      entities: result.transform.entities,
      constraints: result.transform.constraints,
      dimensions: result.transform.dimensions,
    },
    result,
    arcId,
    hostBId: hostB.id,
    site,
    originalArc,
  }
}

function expectRigidArcSeed(entities: SketchEntity[], fixture: ArcChamferFixture) {
  const arc = asArc(entities, fixture.arcId)
  const target = asLine(entities, fixture.hostBId).start
  expect(target.x).toBeCloseTo(10, 8)
  expect(target.y).toBeCloseTo(2, 8)
  expect(arcPoint(arc, fixture.site).x).toBeCloseTo(target.x, 8)
  expect(arcPoint(arc, fixture.site).y).toBeCloseTo(target.y, 8)
  expect(arc.center.x).toBeCloseTo(15, 8)
  expect(arc.center.y).toBeCloseTo(2, 8)
  expect(arc.radius).toBe(fixture.originalArc.radius)
  expect(arc.startAngle).toBe(fixture.originalArc.startAngle)
  expect(arc.endAngle).toBe(fixture.originalArc.endAngle)
}

function expectSurvivingArcTie(
  constraints: SketchConstraint[],
  fixture: ArcChamferFixture,
) {
  expect(constraints.find((constraint) => constraint.id === `arc-${fixture.site}-tie`))
    .toEqual({
      id: `arc-${fixture.site}-tie`,
      kind: 'coincident',
      a: ref(fixture.arcId, fixture.site),
      b: ref(fixture.hostBId, 'start'),
    })
}

describe('SKC-41A-R1 retarget canonicalization and arc materialization', () => {
  it('M10 canonicalizes a dual-host construction anchor and round-trips cleanly', async () => {
    const fixture = dualHostAnchorChamfer()
    expectClean(solveSketchOnWrapper(await getWrapper(), fixture.base), 0)

    const solved = solveSketchOnWrapper(await getWrapper(), fixture.sketch)
    expectClean(solved, 0)
    if (!solved.ok) return
    expectDualAnchorStructure(fixture)
    expectTwoMillimeterSetbacks(solved.entities, fixture)

    const roundTripped = JSON.parse(JSON.stringify({
      ...fixture.sketch,
      entities: solved.entities,
      solveStatus: solved.status,
    })) as Sketch
    expect(roundTripped.entities.map((entity) => entity.id))
      .toEqual(fixture.sketch.entities.map((entity) => entity.id))
    expect(roundTripped.constraints.map((constraint) => constraint.id))
      .toEqual(fixture.sketch.constraints.map((constraint) => constraint.id))
    expect(roundTripped.dimensions.map((dimension) => dimension.id))
      .toEqual(fixture.sketch.dimensions.map((dimension) => dimension.id))
    const reopened = solveSketchOnWrapper(await getWrapper(), roundTripped)
    expectClean(reopened, 0)
    if (reopened.ok) expectTwoMillimeterSetbacks(reopened.entities, fixture)
  })

  it('M11 treats opposite coincidence endpoint orders as the same signature', async () => {
    const fixture = dualHostAnchorChamfer('mixed')
    expectClean(solveSketchOnWrapper(await getWrapper(), fixture.base), 0)
    const solved = solveSketchOnWrapper(await getWrapper(), fixture.sketch)
    expectClean(solved, 0)
    expectDualAnchorStructure(fixture)
  })

  it('keeps the same canonical result when both endpoint orders are reversed', async () => {
    const fixture = dualHostAnchorChamfer('reversed')
    expectClean(solveSketchOnWrapper(await getWrapper(), fixture.base), 0)
    const solved = solveSketchOnWrapper(await getWrapper(), fixture.sketch)
    expectClean(solved, 0)
    expectDualAnchorStructure(fixture)
  })

  it('preserves two distinct construction anchors retargeted to the phantom', () => {
    // These IDs collide under delimiter-joined signatures. Exact PointRef
    // comparison must still preserve both distinct anchors.
    const anchorAId = 'a|self~z'
    const anchorBId = 'z|self~a'
    const phantomId = 'a|self~z|self~a'
    const hostA: SketchLineEntity = {
      id: 'distinct-a', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    }
    const hostB: SketchLineEntity = {
      id: 'distinct-b', kind: 'line', construction: false,
      start: { x: 10, y: 0 }, end: { x: 10, y: 10 },
    }
    const base: Sketch = {
      id: 'distinct-anchors', layerId: 'fixture-layer',
      entities: [
        hostA,
        hostB,
        { id: anchorAId, kind: 'point', construction: true, at: { x: 10, y: 0 } },
        { id: anchorBId, kind: 'point', construction: true, at: { x: 10, y: 0 } },
      ],
      constraints: [
        {
          id: 'distinct-corner', kind: 'coincident',
          a: ref(hostA.id, 'end'), b: ref(hostB.id, 'start'),
        },
        {
          id: 'anchor-a-tie', kind: 'coincident',
          a: ref(anchorAId, 'self'), b: ref(hostA.id, 'end'),
        },
        {
          id: 'anchor-b-tie', kind: 'coincident',
          a: ref(anchorBId, 'self'), b: ref(hostB.id, 'start'),
        },
      ],
      dimensions: [], solveStatus: null,
    }
    let id = 0
    const generatedIds = [
      'distinct-chamfer-line',
      phantomId,
      'distinct-joint-a',
      'distinct-joint-b',
      'distinct-pin-a',
      'distinct-pin-b',
      'distinct-setback-a',
      'distinct-setback-b',
    ]
    const result = chamferLines(
      base as unknown as SketchDoc,
      hostA.id,
      hostB.id,
      hostA.start,
      hostB.end,
      2,
      () => generatedIds[id++] ?? `distinct-extra-${id}`,
    )
    if (typeof result === 'string') throw new Error(result)
    expect(result.phantomPointId).toBe(phantomId)
    expect(result.transform.entities.filter((entity) =>
      entity.id === anchorAId || entity.id === anchorBId).map((entity) => entity.id))
      .toEqual([anchorAId, anchorBId])
    expect(result.transform.constraints.filter((constraint) =>
      constraint.id === 'anchor-a-tie' || constraint.id === 'anchor-b-tie'))
      .toEqual([
        {
          id: 'anchor-a-tie', kind: 'coincident',
          a: ref(anchorAId, 'self'), b: ref(phantomId, 'self'),
        },
        {
          id: 'anchor-b-tie', kind: 'coincident',
          a: ref(anchorBId, 'self'), b: ref(phantomId, 'self'),
        },
      ])
  })

  it('M12 rigidly reseeds a real arc start through solve and JSON reopen', async () => {
    const fixture = realArcChamfer('start')
    expectSurvivingArcTie(fixture.sketch.constraints, fixture)
    expectRigidArcSeed(fixture.sketch.entities, fixture)
    const solved = solveSketchOnWrapper(await getWrapper(), fixture.sketch)
    expectClean(solved, 9)
    if (!solved.ok) return
    expectRigidArcSeed(solved.entities, fixture)
    const reopenedSketch = JSON.parse(JSON.stringify({
      ...fixture.sketch, entities: solved.entities, solveStatus: solved.status,
    })) as Sketch
    expectSurvivingArcTie(reopenedSketch.constraints, fixture)
    const reopened = solveSketchOnWrapper(await getWrapper(), reopenedSketch)
    expectClean(reopened, 9)
    if (reopened.ok) expectRigidArcSeed(reopened.entities, fixture)
  })

  it('M13 rigidly reseeds a real arc end without changing its angles', async () => {
    const fixture = realArcChamfer('end')
    expectSurvivingArcTie(fixture.sketch.constraints, fixture)
    expectRigidArcSeed(fixture.sketch.entities, fixture)
    const solved = solveSketchOnWrapper(await getWrapper(), fixture.sketch)
    expectClean(solved, 9)
    if (!solved.ok) return
    expectRigidArcSeed(solved.entities, fixture)
    const reopenedSketch = JSON.parse(JSON.stringify({
      ...fixture.sketch, entities: solved.entities, solveStatus: solved.status,
    })) as Sketch
    expectSurvivingArcTie(reopenedSketch.constraints, fixture)
    const reopened = solveSketchOnWrapper(await getWrapper(), reopenedSketch)
    expectClean(reopened, 9)
    if (reopened.ok) expectRigidArcSeed(reopened.entities, fixture)
  })
})

describe('SKC-41A real PlaneGCS chamfer integrity matrix', () => {
  it('80x60 diagonal corner stays exact, drives to 120x60, and round-trips', async () => {
    const fixture = rectangleChamfer(2)
    const initial = solveSketchOnWrapper(await getWrapper(), fixture.sketch)
    expectClean(initial, 0)
    if (!initial.ok) return

    expect(bbox(initial.entities, fixture.sideIds)).toEqual({
      minX: expect.closeTo(0, 5),
      minY: expect.closeTo(0, 5),
      maxX: expect.closeTo(80, 5),
      maxY: expect.closeTo(60, 5),
    })
    const initialPhantom = initial.entities.find(
      (entity): entity is Extract<SketchEntity, { kind: 'point' }> =>
        entity.id === fixture.result.phantomPointId && entity.kind === 'point',
    )
    expect(initialPhantom?.at.x).toBeCloseTo(80, 5)
    expect(initialPhantom?.at.y).toBeCloseTo(60, 5)
    expectTheoreticalCornerAtHostIntersection(initial.entities, fixture)
    expectFiveMillimeterSetbacks(initial.entities, fixture)
    expect(acuteLineAngleDeg(asLine(initial.entities, fixture.result.lineId))).toBeCloseTo(45, 5)

    const resizedSketch: Sketch = {
      ...fixture.sketch,
      entities: initial.entities,
      solveStatus: initial.status,
      dimensions: fixture.sketch.dimensions.map((dimension) =>
        dimension.id === fixture.widthDimId ? { ...dimension, value: 120 } : dimension),
    }
    const resized = solveSketchOnWrapper(await getWrapper(), resizedSketch)
    expectClean(resized, 0)
    if (!resized.ok) return
    expect(bbox(resized.entities, fixture.sideIds)).toEqual({
      minX: expect.closeTo(0, 5),
      minY: expect.closeTo(0, 5),
      maxX: expect.closeTo(120, 5),
      maxY: expect.closeTo(60, 5),
    })
    const resizedPhantom = resized.entities.find(
      (entity): entity is Extract<SketchEntity, { kind: 'point' }> =>
        entity.id === fixture.result.phantomPointId && entity.kind === 'point',
    )
    const resizedDiagonal = asLine(resized.entities, fixture.diagonalId)
    expect(resizedPhantom?.at.x).toBeCloseTo(120, 5)
    expect(resizedPhantom?.at.y).toBeCloseTo(60, 5)
    expect(resizedDiagonal.end.x).toBeCloseTo(120, 5)
    expect(resizedDiagonal.end.y).toBeCloseTo(60, 5)
    expectTheoreticalCornerAtHostIntersection(resized.entities, fixture)
    expectFiveMillimeterSetbacks(resized.entities, fixture)
    expect(acuteLineAngleDeg(asLine(resized.entities, fixture.result.lineId))).toBeCloseTo(45, 5)

    const roundTripped = JSON.parse(JSON.stringify({
      ...resizedSketch,
      entities: resized.entities,
      solveStatus: resized.status,
    })) as Sketch
    const reopened = solveSketchOnWrapper(await getWrapper(), roundTripped)
    expectClean(reopened, 0)
    if (!reopened.ok) return
    expect(bbox(reopened.entities, fixture.sideIds).maxX).toBeCloseTo(120, 5)
    expectTheoreticalCornerAtHostIntersection(reopened.entities, fixture)
    expectFiveMillimeterSetbacks(reopened.entities, fixture)
    expect(acuteLineAngleDeg(asLine(reopened.entities, fixture.result.lineId))).toBeCloseTo(45, 5)
  })

  it('all four rectangle corners solve clean with equal five millimeter setbacks', async () => {
    for (let cornerIndex = 0; cornerIndex < CORNERS.length; cornerIndex += 1) {
      const fixture = rectangleChamfer(cornerIndex)
      const out = solveSketchOnWrapper(await getWrapper(), fixture.sketch)
      expectClean(out, 0)
      if (!out.ok) continue
      expect(bbox(out.entities, fixture.sideIds)).toEqual({
        minX: expect.closeTo(0, 5),
        minY: expect.closeTo(0, 5),
        maxX: expect.closeTo(80, 5),
        maxY: expect.closeTo(60, 5),
      })
      expectTheoreticalCornerAtHostIntersection(out.entities, fixture)
      expectFiveMillimeterSetbacks(out.entities, fixture)
      expect(acuteLineAngleDeg(asLine(out.entities, fixture.result.lineId))).toBeCloseTo(45, 5)
    }
  })

  it('a 60 degree corner keeps equal distances without hard-coding a 45 degree cut', async () => {
    const hostA: SketchLineEntity = {
      id: 'non90-a', kind: 'line', construction: false,
      start: { x: 10, y: 0 }, end: { x: 0, y: 0 },
    }
    const hostB: SketchLineEntity = {
      id: 'non90-b', kind: 'line', construction: false,
      start: { x: 0, y: 0 },
      end: { x: 5, y: 5 * Math.sqrt(3) },
    }
    const base: Sketch = {
      id: 'non90', layerId: 'fixture-layer',
      entities: [hostA, hostB],
      constraints: [{
        id: 'non90-corner', kind: 'coincident',
        a: ref(hostA.id, 'end'), b: ref(hostB.id, 'start'),
      }],
      dimensions: [],
      solveStatus: null,
    }
    let id = 0
    const result = chamferLines(
      base as unknown as SketchDoc,
      hostA.id,
      hostB.id,
      hostA.start,
      hostB.end,
      1.5,
      () => `non90-${id++}`,
    )
    if (typeof result === 'string') throw new Error(result)
    const dimensions: SketchDimension[] = [
      ...result.transform.dimensions,
      {
        id: 'non90-host-a-length', kind: 'distance', driving: true, value: 10,
        a: ref(result.phantomPointId, 'self'), b: ref(hostA.id, 'start'),
      },
      {
        id: 'non90-host-b-length', kind: 'distance', driving: true, value: 10,
        a: ref(result.phantomPointId, 'self'), b: ref(hostB.id, 'end'),
      },
    ]
    const out = solveSketchOnWrapper(await getWrapper(), {
      ...base,
      entities: result.transform.entities,
      constraints: result.transform.constraints,
      dimensions,
    })
    expectClean(out, 4)
    if (!out.ok) return
    const phantom = out.entities.find(
      (entity): entity is Extract<SketchEntity, { kind: 'point' }> =>
        entity.id === result.phantomPointId && entity.kind === 'point',
    )!
    const solvedA = asLine(out.entities, hostA.id)
    const solvedB = asLine(out.entities, hostB.id)
    expect(Math.hypot(solvedA.end.x - phantom.at.x, solvedA.end.y - phantom.at.y))
      .toBeCloseTo(1.5, 5)
    expect(Math.hypot(solvedB.start.x - phantom.at.x, solvedB.start.y - phantom.at.y))
      .toBeCloseTo(1.5, 5)
    const cutAngle = acuteLineAngleDeg(asLine(out.entities, result.lineId))
    expect(cutAngle).toBeCloseTo(60, 5)
    expect(cutAngle).not.toBeCloseTo(45, 2)
  })
})

describe('SKC-41A named mutation gates', () => {
  it('M1 requires the phantom entity in the solver document', () => {
    const fixture = rectangleChamfer(2)
    expect(fixture.sketch.entities.some(
      (entity) => entity.id === fixture.result.phantomPointId && entity.kind === 'point'))
      .toBe(true)
  })

  it('M2 requires the host A passive pin', () => {
    const fixture = rectangleChamfer(2)
    expect(fixture.sketch.constraints.some((constraint) =>
      constraint.kind === 'point_on_object' &&
      constraint.point.entityId === fixture.result.phantomPointId &&
      constraint.object === fixture.hostAId)).toBe(true)
  })

  it('M3 requires the host B passive pin', () => {
    const fixture = rectangleChamfer(2)
    expect(fixture.sketch.constraints.some((constraint) =>
      constraint.kind === 'point_on_object' &&
      constraint.point.entityId === fixture.result.phantomPointId &&
      constraint.object === fixture.hostBId)).toBe(true)
  })

  it('M4 requires setback dimension A', () => {
    const fixture = rectangleChamfer(2)
    expect(fixture.sketch.dimensions.some(
      (dimension) => dimension.id === fixture.result.setbackDimAId)).toBe(true)
  })

  it('M5 requires setback dimension B', () => {
    const fixture = rectangleChamfer(2)
    expect(fixture.sketch.dimensions.some(
      (dimension) => dimension.id === fixture.result.setbackDimBId)).toBe(true)
  })

  it('M6 requires real-profile propagation to the trim site', () => {
    const fixture = rectangleChamfer(2)
    const hostB = asLine(fixture.sketch.entities, fixture.hostBId)
    const real: SketchLineEntity = {
      id: 'mutation-real', kind: 'line', construction: false,
      start: CORNERS[2].at, end: { x: 90, y: 70 },
    }
    const cornerTie = fixture.sketch.constraints.find(
      (constraint) => constraint.kind === 'coincident' &&
        constraint.b.entityId === fixture.result.phantomPointId,
    )
    expect(cornerTie).toBeDefined()

    const base = rectangleChamferSourceWithRealRelation(real)
    const movedReal = asLine(base.sketch.entities, real.id)
    const movedHostB = asLine(base.sketch.entities, base.hostBId)
    expect(movedReal.start).toEqual(movedHostB.start)
    expect(movedReal.start).not.toEqual(CORNERS[2].at)
    expect(hostB.start).not.toEqual(CORNERS[2].at)
  })

  it('M7 requires passive pins and forbids a fix on the phantom', () => {
    const fixture = rectangleChamfer(2)
    const pins = fixture.sketch.constraints.filter((constraint) =>
      constraint.kind === 'point_on_object' &&
      constraint.point.entityId === fixture.result.phantomPointId)
    expect(pins).toHaveLength(2)
    expect(fixture.sketch.constraints.some((constraint) => constraint.kind === 'fix' &&
      (constraint.point?.entityId === fixture.result.phantomPointId ||
        constraint.entityId === fixture.result.phantomPointId))).toBe(false)
  })

  it('M8 requires the rectangle diagonal on the phantom instead of the trim endpoint', () => {
    const fixture = rectangleChamfer(2)
    expect(fixture.sketch.constraints.some((constraint) =>
      constraint.kind === 'coincident' &&
      ((constraint.a.entityId === fixture.diagonalId && constraint.a.site === fixture.diagonalSite &&
        constraint.b.entityId === fixture.result.phantomPointId) ||
       (constraint.b.entityId === fixture.diagonalId && constraint.b.site === fixture.diagonalSite &&
        constraint.a.entityId === fixture.result.phantomPointId)))).toBe(true)
    expect(fixture.sketch.constraints.some((constraint) =>
      constraint.kind === 'coincident' &&
      ((constraint.a.entityId === fixture.diagonalId && constraint.a.site === fixture.diagonalSite &&
        constraint.b.entityId === fixture.hostAId) ||
       (constraint.b.entityId === fixture.diagonalId && constraint.b.site === fixture.diagonalSite &&
        constraint.a.entityId === fixture.hostAId)))).toBe(false)
  })

  it('M9 requires both setback dimensions to remain driving', () => {
    const fixture = rectangleChamfer(2)
    const dims = fixture.sketch.dimensions.filter((dimension) =>
      dimension.id === fixture.result.setbackDimAId ||
      dimension.id === fixture.result.setbackDimBId)
    expect(dims).toHaveLength(2)
    expect(dims.every((dimension) => dimension.driving)).toBe(true)
  })
})

function rectangleChamferSourceWithRealRelation(real: SketchLineEntity): RectChamferFixture {
  let rectId = 0
  const commit = buildRectCommit(
    { x: 0, y: 0 }, { x: 80, y: 60 }, false, () => `real-rect-${rectId++}`,
  )
  const sideIds = commit.entities.slice(0, 4).map((entity) => entity.id)
  const diagonal = commit.entities.find(
    (entity): entity is SketchLineEntity => entity.kind === 'line' && entity.construction,
  )!
  const corner = CORNERS[2]
  const realTie: SketchConstraint = {
    id: 'mutation-real-tie', kind: 'coincident',
    a: ref(real.id, 'start'), b: ref(sideIds[corner.b], 'start'),
  }
  const base: Sketch = {
    id: 'real-relation', layerId: 'fixture-layer',
    entities: [...commit.entities, real],
    constraints: [...commit.constraints, realTie],
    dimensions: [], solveStatus: null,
  }
  let id = 0
  const result = chamferLines(
    base as unknown as SketchDoc,
    sideIds[corner.a], sideIds[corner.b], corner.hintA, corner.hintB, 5,
    () => `real-chamfer-${id++}`,
  )
  if (typeof result === 'string') throw new Error(result)
  return {
    sketch: {
      ...base,
      entities: result.transform.entities,
      constraints: result.transform.constraints,
      dimensions: result.transform.dimensions,
    },
    result,
    sideIds,
    hostAId: sideIds[corner.a],
    hostBId: sideIds[corner.b],
    diagonalId: diagonal.id,
    diagonalSite: 'end',
    widthDimId: 'unused-width',
    heightDimId: 'unused-height',
  }
}

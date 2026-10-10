import { describe, expect, it } from 'vitest'
import {
  CENTER_BEARING_ENTITY_CENSUS,
  centerPointForEntity,
  centerRefForEntity,
  centerSelectionIdForEntity,
  decodeCenterSelectionRef,
  resolveCenterRef,
} from '../../lib/sketch/centerReferences'
import type { SketchEntity } from '../../lib/sketch/types'

const UNION_KINDS = [
  'point',
  'line',
  'arc',
  'circle',
  'ellipse',
  'elliptical-arc',
  'spline',
  'text',
  'block',
] as const satisfies readonly SketchEntity['kind'][]

const FIXTURES: Record<SketchEntity['kind'], SketchEntity> = {
  point: { id: 'point', kind: 'point', construction: false, at: { x: 1, y: 2 } },
  line: {
    id: 'line', kind: 'line', construction: false,
    start: { x: -4, y: 2 }, end: { x: 8, y: 6 },
  },
  arc: {
    id: 'arc', kind: 'arc', construction: false,
    center: { x: 3, y: 4 }, radius: 2, startAngle: 0, endAngle: Math.PI,
  },
  circle: {
    id: 'circle', kind: 'circle', construction: false,
    center: { x: 5, y: 6 }, radius: 3,
  },
  ellipse: {
    id: 'ellipse', kind: 'ellipse', construction: false,
    center: { x: 7, y: 8 }, majorRadius: 5, minorRadius: 2, rotation: 0,
  },
  'elliptical-arc': {
    id: 'elliptical-arc', kind: 'elliptical-arc', construction: false,
    center: { x: 9, y: 10 }, majorRadius: 5, minorRadius: 2, rotation: 0,
    startParam: 0, endParam: Math.PI,
  },
  spline: {
    id: 'spline', kind: 'spline', construction: false,
    points: [{ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 5, y: 0 }],
    closed: false,
  },
  text: {
    id: 'text', kind: 'text', construction: false,
    at: { x: 0, y: 0 }, text: 'A', height: 5, fontStyle: 'single-line',
  },
  block: {
    id: 'block', kind: 'block', construction: false,
    origin: { x: 3, y: 3 }, rotation: 0, scale: 1,
    members: { entities: [], constraints: [], dimensions: [] },
  },
}

describe('SKC-62 compiler-derived center-bearing census', () => {
  it('has one fail-loud disposition row for every SketchEntity union member', () => {
    expect(Object.keys(CENTER_BEARING_ENTITY_CENSUS).sort())
      .toEqual([...UNION_KINDS].sort())
    for (const kind of UNION_KINDS) {
      expect(CENTER_BEARING_ENTITY_CENSUS[kind].reason.length).toBeGreaterThan(20)
    }
  })

  it('requires circle and includes every unambiguous atomic center', () => {
    // Mutation anchor: changing circle.included to false must make this named
    // acceptance test RED.
    expect(CENTER_BEARING_ENTITY_CENSUS.circle.included).toBe(true)
    expect(UNION_KINDS.filter((kind) => CENTER_BEARING_ENTITY_CENSUS[kind].included))
      .toEqual(['line', 'arc', 'circle', 'ellipse', 'elliptical-arc'])
  })

  it('derives one stable owner/site ref without adding an entity', () => {
    for (const kind of UNION_KINDS) {
      const entity = FIXTURES[kind]
      const expected = CENTER_BEARING_ENTITY_CENSUS[kind].included
      expect(centerRefForEntity(entity) !== null, kind).toBe(expected)
      expect(centerPointForEntity(entity) !== null, kind).toBe(expected)
      expect(centerSelectionIdForEntity(entity) !== null, kind).toBe(expected)
    }
    expect(centerPointForEntity(FIXTURES.line)).toEqual({ x: 2, y: 4 })
    expect(centerRefForEntity(FIXTURES.circle))
      .toEqual({ entityId: 'circle', site: 'center' })
  })

  it('survives reorder, parent edits, and JSON save/reload by owner id', () => {
    const selectionId = centerSelectionIdForEntity(FIXTURES.circle)!
    const ref = decodeCenterSelectionRef(selectionId)!
    const reloaded = JSON.parse(JSON.stringify([
      FIXTURES.ellipse,
      { ...FIXTURES.circle, center: { x: 42, y: -11 } },
      FIXTURES.line,
    ])) as SketchEntity[]
    const resolved = resolveCenterRef(reloaded.reverse(), ref)
    expect(resolved.entity.id).toBe('circle')
    expect(resolved.point).toEqual({ x: 42, y: -11 })
  })
})

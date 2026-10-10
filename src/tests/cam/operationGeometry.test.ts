import { describe, it, expect } from 'vitest'
import {
  OPERATION_GEOMETRY,
  consumableEntities,
  consumeEntity,
  consumeCylinder,
  facePickBannerText,
  type ClickableEntity,
  type EntityFacts,
} from '../../lib/cam/operationGeometry'
import type { OperationType } from '../../types'

// Small fact builders ------------------------------------------------------

function face(over: Partial<EntityFacts> = {}): EntityFacts {
  return { kind: 'planarFace', geoId: 'g1', surfaceType: 0, topZ: 0, ...over }
}
function cylinder(kind: 'bore' | 'boss', over: Partial<EntityFacts> = {}): EntityFacts {
  return {
    kind: 'cylinder',
    geoId: 'g1',
    surfaceType: 1,
    diameter: 10,
    cylinderKind: kind,
    topZ: 0,
    bottomZ: -10,
    ...over,
  }
}
function edge(over: Partial<EntityFacts> = {}): EntityFacts {
  return { kind: 'edge', geoId: 'g1', edgeIndex: 0, ...over }
}
function loop(over: Partial<EntityFacts> = {}): EntityFacts {
  return { kind: 'loop', geoId: 'g1', loopId: 'L1', closed: true, ...over }
}
function openCurve(over: Partial<EntityFacts> = {}): EntityFacts {
  return { kind: 'openCurve', geoId: 'g1', loopId: 'L1', closed: false, ...over }
}

const ALL_OPS: OperationType[] = Object.keys(OPERATION_GEOMETRY) as OperationType[]
const ALL_ENTITIES: ClickableEntity[] = ['planarFace', 'cylinder', 'edge', 'loop', 'openCurve']

// --------------------------------------------------------------------------

describe('OPERATION_GEOMETRY record', () => {
  it('covers exactly the OperationType variants (no gaps, no extras)', () => {
    // 10 x 2.5d + 6 x 3d = 16 ops
    expect(ALL_OPS).toHaveLength(16)
  })

  it('every 3d op uses solid selection rather than clickable body entities', () => {
    const threeD: OperationType[] = [
      'parallel_3d',
      'waterline_3d',
      'adaptive_3d',
      'scallop_3d',
      'steep_shallow_3d',
      'pencil_3d',
    ]
    for (const op of threeD) {
      expect(OPERATION_GEOMETRY[op].dimensionality).toBe('3d')
      expect(OPERATION_GEOMETRY[op].accepts).toEqual([])
      expect(consumableEntities(op)).toEqual([])
    }
  })

  it('consumableEntities returns a copy (mutation does not leak into the spec)', () => {
    const ents = consumableEntities('pocket_2d')
    ents.push('openCurve')
    expect(OPERATION_GEOMETRY.pocket_2d.accepts).not.toContain('openCurve')
  })

  it('every op x every entity yields a well-formed ConsumeResult', () => {
    const builders: Record<ClickableEntity, () => EntityFacts> = {
      planarFace: () => face(),
      cylinder: () => cylinder('bore'),
      edge: () => edge(),
      loop: () => loop(),
      openCurve: () => openCurve(),
    }
    for (const op of ALL_OPS) {
      for (const ent of ALL_ENTITIES) {
        const r = consumeEntity(op, builders[ent]())
        expect(typeof r.ok).toBe('boolean')
        if (r.ok) expect(r.deriveKind).toBeDefined()
        else expect(r.reason && r.reason.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('planar face height roles (R2a)', () => {
  it('pocket + planarFace -> ok, deriveKind face, heightRole top', () => {
    const r = consumeEntity('pocket_2d', face())
    expect(r).toMatchObject({ ok: true, deriveKind: 'face', heightRole: 'top' })
  })

  it('contour + planarFace -> heightRole top', () => {
    expect(consumeEntity('contour_2d', face()).heightRole).toBe('top')
  })

  it('adaptive_clearing + planarFace -> heightRole top', () => {
    expect(consumeEntity('adaptive_clearing_2d', face()).heightRole).toBe('top')
  })

  // face is the OperationType for the facing op (informally "face_2d" in design docs)
  it('face + planarFace -> ok, heightRole floor', () => {
    const r = consumeEntity('face', face())
    expect(r).toMatchObject({ ok: true, deriveKind: 'face', heightRole: 'floor' })
  })
})

describe('cylinder coercion (contour / pocket family)', () => {
  it('contour + cylinder(bore) -> ok, coercedFrom cylinder, side inside', () => {
    const r = consumeEntity('contour_2d', cylinder('bore'))
    expect(r).toMatchObject({
      ok: true,
      deriveKind: 'loop',
      coercedFrom: 'cylinder',
      side: 'inside',
    })
  })

  it('pocket + cylinder(boss) -> ok, coerced to top rim loop, side outside', () => {
    const r = consumeEntity('pocket_2d', cylinder('boss'))
    expect(r).toMatchObject({
      ok: true,
      deriveKind: 'loop',
      coercedFrom: 'cylinder',
      side: 'outside',
    })
    // confirm the spec declares the coercion as a top rim circle
    expect(OPERATION_GEOMETRY.pocket_2d.coerce?.cylinder).toEqual({
      to: 'loop',
      note: 'top rim circle',
    })
  })

  it('face + cylinder(bore) -> coerced, side inside', () => {
    expect(consumeEntity('face', cylinder('bore'))).toMatchObject({
      ok: true,
      coercedFrom: 'cylinder',
      side: 'inside',
    })
  })
})

describe('drill / bore', () => {
  it('drill + cylinder(bore) -> ok, deriveKind holes', () => {
    expect(consumeEntity('drill', cylinder('bore'))).toMatchObject({
      ok: true,
      deriveKind: 'holes',
    })
  })

  it('drill + loop(circle) -> ok, deriveKind holes', () => {
    expect(consumeEntity('drill', loop())).toMatchObject({ ok: true, deriveKind: 'holes' })
  })

  it('drill + planarFace -> ok:false with a reason', () => {
    const r = consumeEntity('drill', face())
    expect(r.ok).toBe(false)
    expect(r.reason && r.reason.length).toBeGreaterThan(0)
  })

  it('bore mirrors drill (cylinder -> holes)', () => {
    expect(consumeEntity('bore', cylinder('bore'))).toMatchObject({
      ok: true,
      deriveKind: 'holes',
    })
  })
})

describe('thread_mill', () => {
  it('thread_mill + cylinder -> ok, deriveKind cylinder', () => {
    expect(consumeEntity('thread_mill', cylinder('bore'))).toMatchObject({
      ok: true,
      deriveKind: 'cylinder',
    })
  })

  it('thread_mill + loop -> ok, deriveKind loop (manual)', () => {
    expect(consumeEntity('thread_mill', loop())).toMatchObject({ ok: true, deriveKind: 'loop' })
  })

  it('thread_mill + planarFace -> ok:false (hint)', () => {
    expect(consumeEntity('thread_mill', face()).ok).toBe(false)
  })
})

describe('open-curve handling', () => {
  it('engrave + openCurve -> ok (loopFilter closedAndOpen)', () => {
    expect(OPERATION_GEOMETRY.engrave.loopFilter).toBe('closedAndOpen')
    expect(consumeEntity('engrave', openCurve()).ok).toBe(true)
  })

  it('contour + openCurve -> ok (mode-specific UI applies the final loop filter)', () => {
    expect(OPERATION_GEOMETRY.contour_2d.loopFilter).toBe('closedAndOpen')
    expect(consumeEntity('contour_2d', openCurve())).toMatchObject({
      ok: true,
      deriveKind: 'loop',
    })
  })

  it('engrave + edge and + loop both ok', () => {
    expect(consumeEntity('engrave', edge()).ok).toBe(true)
    expect(consumeEntity('engrave', loop()).ok).toBe(true)
  })
})

describe('chamfer', () => {
  it('chamfer + edge -> ok, deriveKind edge', () => {
    expect(consumeEntity('chamfer', edge())).toMatchObject({ ok: true, deriveKind: 'edge' })
  })
  it('chamfer + loop -> ok, deriveKind loop', () => {
    expect(consumeEntity('chamfer', loop())).toMatchObject({ ok: true, deriveKind: 'loop' })
  })
  it('chamfer + planarFace -> ok:false', () => {
    expect(consumeEntity('chamfer', face()).ok).toBe(false)
  })
})

describe('contour edge/loop direct routing', () => {
  it('contour + edge -> deriveKind edge', () => {
    expect(consumeEntity('contour_2d', edge())).toMatchObject({ ok: true, deriveKind: 'edge' })
  })
  it('contour + loop -> deriveKind loop', () => {
    expect(consumeEntity('contour_2d', loop())).toMatchObject({ ok: true, deriveKind: 'loop' })
  })
})

describe('3d ops reject all clickable entities for now', () => {
  it('parallel_3d + planarFace -> ok:false (no body entity yet)', () => {
    expect(consumeEntity('parallel_3d', face()).ok).toBe(false)
  })
})

describe('Part B: op-aware cylinder routing', () => {
  // Boundary-inference ops (pocket / adaptive_clearing / face): a coerced
  // cylinder gets a loopType + FLOOR height role. boss -> avoid-ISLAND ('hole',
  // side outside); bore -> machined boundary ('contour', side inside).
  it('pocket_2d + cylinder(boss) -> loopType hole, heightRole floor, side outside', () => {
    expect(consumeEntity('pocket_2d', cylinder('boss'))).toMatchObject({
      ok: true,
      deriveKind: 'loop',
      heightRole: 'floor',
      side: 'outside',
      loopType: 'hole',
      coercedFrom: 'cylinder',
    })
  })

  it('pocket_2d + cylinder(bore) -> loopType contour, heightRole floor, side inside', () => {
    expect(consumeEntity('pocket_2d', cylinder('bore'))).toMatchObject({
      ok: true,
      deriveKind: 'loop',
      heightRole: 'floor',
      side: 'inside',
      loopType: 'contour',
      coercedFrom: 'cylinder',
    })
  })

  it('adaptive_clearing_2d + cylinder(boss) -> loopType hole, heightRole floor, side outside', () => {
    expect(consumeEntity('adaptive_clearing_2d', cylinder('boss'))).toMatchObject({
      ok: true,
      deriveKind: 'loop',
      heightRole: 'floor',
      side: 'outside',
      loopType: 'hole',
      coercedFrom: 'cylinder',
    })
  })

  it('face + cylinder(boss) -> loopType hole, heightRole floor, side outside', () => {
    expect(consumeEntity('face', cylinder('boss'))).toMatchObject({
      ok: true,
      deriveKind: 'loop',
      heightRole: 'floor',
      side: 'outside',
      loopType: 'hole',
      coercedFrom: 'cylinder',
    })
  })

  // Non-boundary ops (contour / vcarve, boundaryInference 'none'): a plain
  // profile loop (NO island loopType) but the cut floor STILL binds to the
  // cylinder base. Bug A fix: contouring a boss must descend its wall to the
  // base; previously this returned heightRole 'none' and the bottom fell to a
  // default depth (the reported failure on Deck-Rough-FINAL).
  it('contour_2d + cylinder(boss) -> heightRole floor (base), no loopType, side outside', () => {
    const r = consumeEntity('contour_2d', cylinder('boss'))
    expect(r).toMatchObject({
      ok: true,
      deriveKind: 'loop',
      heightRole: 'floor',
      side: 'outside',
      coercedFrom: 'cylinder',
    })
    expect(r.loopType).toBeUndefined()
  })

  it('vcarve + cylinder(bore) -> heightRole floor (base), no loopType, side inside', () => {
    const r = consumeEntity('vcarve', cylinder('bore'))
    expect(r).toMatchObject({
      ok: true,
      deriveKind: 'loop',
      heightRole: 'floor',
      side: 'inside',
      coercedFrom: 'cylinder',
    })
    expect(r.loopType).toBeUndefined()
  })

  // Sanity: ops that ACCEPT a cylinder directly are untouched by Part B.
  it('drill + cylinder -> deriveKind holes (unchanged), no loopType', () => {
    const r = consumeEntity('drill', cylinder('bore'))
    expect(r).toMatchObject({ ok: true, deriveKind: 'holes' })
    expect(r.loopType).toBeUndefined()
  })

  it('thread_mill + cylinder -> deriveKind cylinder (unchanged), no loopType', () => {
    const r = consumeEntity('thread_mill', cylinder('boss'))
    expect(r).toMatchObject({ ok: true, deriveKind: 'cylinder' })
    expect(r.loopType).toBeUndefined()
  })
})

// consumeCylinder: the convenience wrapper the modal's cylinder-pick path uses.
// It must map a derived CylinderFeature shape (kind/diameter/top/bottom) onto
// the SAME ConsumeResult a real cylinder click produces, so loopType + heightRole
// + side stay single-sourced from the matrix (no per-op hardcoding in the modal).
describe('consumeCylinder (derived-feature wrapper)', () => {
  const feat = (kind: 'bore' | 'boss') =>
    ({ geoId: 'g1', kind, diameter: 12, topZ: 0, bottomZ: -8 })

  it('pocket + BOSS -> island (loopType hole), FLOOR role, outside', () => {
    const r = consumeCylinder('pocket_2d', feat('boss'))
    expect(r).toMatchObject({
      ok: true, deriveKind: 'loop', heightRole: 'floor',
      side: 'outside', loopType: 'hole', coercedFrom: 'cylinder',
    })
  })

  it('pocket + BORE -> boundary (loopType contour), FLOOR role, inside', () => {
    const r = consumeCylinder('pocket_2d', feat('bore'))
    expect(r).toMatchObject({
      ok: true, deriveKind: 'loop', heightRole: 'floor',
      side: 'inside', loopType: 'contour', coercedFrom: 'cylinder',
    })
  })

  it('adaptive_clearing + BOSS -> island + FLOOR (same as pocket)', () => {
    const r = consumeCylinder('adaptive_clearing_2d', feat('boss'))
    expect(r).toMatchObject({ ok: true, heightRole: 'floor', loopType: 'hole' })
  })

  it('face + BORE -> boundary + FLOOR (boundary-inference op)', () => {
    const r = consumeCylinder('face', feat('bore'))
    expect(r).toMatchObject({ ok: true, heightRole: 'floor', loopType: 'contour' })
  })

  it('contour + BOSS -> plain profile (no loopType) but FLOOR binds to base (Bug A)', () => {
    const r = consumeCylinder('contour_2d', feat('boss'))
    expect(r).toMatchObject({ ok: true, deriveKind: 'loop', heightRole: 'floor', side: 'outside' })
    expect(r.loopType).toBeUndefined()
  })

  it('matches a hand-built cylinder click exactly (single source of truth)', () => {
    const viaWrapper = consumeCylinder('pocket_2d', feat('boss'))
    const viaFacts = consumeEntity('pocket_2d', {
      kind: 'cylinder', geoId: 'g1', surfaceType: 1, diameter: 12,
      topZ: 0, bottomZ: -8, cylinderKind: 'boss',
    })
    expect(viaWrapper).toEqual(viaFacts)
  })
})

// facePickBannerText: the B-rep model-FACE picking banner's lead help sentence,
// per op (Bug C fix: the THREAD-specific wording was shown for EVERY op).
//
// NOTE on test altitude: this is a function-level unit test, not a full mount of
// NewOperationModal. Mounting that modal in jsdom is impractical -- it pulls in
// the operation wizard, the viewport bridge and store wiring -- and the banner
// text is a pure function of opType, so asserting facePickBannerText directly is
// the real gate. The modal merely renders `{facePickBannerText(opType)}`.
describe('facePickBannerText (face-pick banner copy)', () => {
  const THREAD_WORD = /thread/i

  it('thread_mill is the ONLY op whose banner mentions a thread', () => {
    expect(facePickBannerText('thread_mill')).toMatch(THREAD_WORD)
    for (const op of ALL_OPS) {
      if (op === 'thread_mill') continue
      expect(facePickBannerText(op)).not.toMatch(THREAD_WORD)
    }
  })

  it('contour_2d / pocket_2d / face / drill each return a distinct string', () => {
    const strings = [
      facePickBannerText('contour_2d'),
      facePickBannerText('pocket_2d'),
      facePickBannerText('face'),
      facePickBannerText('drill'),
    ]
    expect(new Set(strings).size).toBe(strings.length)
  })

  it('contour_2d banner profiles a wall (no thread wording, includes "profile")', () => {
    const t = facePickBannerText('contour_2d')
    expect(t).not.toMatch(THREAD_WORD)
    expect(t).toContain('profile')
  })

  it('pocket_2d and adaptive_clearing_2d share the same banner', () => {
    expect(facePickBannerText('adaptive_clearing_2d')).toBe(facePickBannerText('pocket_2d'))
  })

  it('drill and bore share the same banner', () => {
    expect(facePickBannerText('bore')).toBe(facePickBannerText('drill'))
  })

  it('an arbitrary 3d op returns the generic fallback', () => {
    expect(facePickBannerText('parallel_3d')).toBe(
      'Click faces on the model to select or deselect them.')
  })

  it('every op returns a non-empty string', () => {
    for (const op of ALL_OPS) {
      expect(facePickBannerText(op).length).toBeGreaterThan(0)
    }
  })
})

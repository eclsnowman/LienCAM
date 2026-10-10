import { describe, expect, it } from 'vitest'
import {
  DIMENSION_KINDS,
  UnknownSketchDimensionKindError,
  cycleDimForceMode,
  dimForceFamily,
  formatDimensionValue,
  measureDimension,
  positiveArcSweep,
  remeasureReferenceDimensions,
} from '../../lib/sketch/tools/dimTool'
import { dimGuides, resolveDimPlacement } from '../../lib/sketch/tools/dimPlacement'
import { cycleDimForce } from '../../lib/sketch/tools/toolMachine'
import {
  sketchToGcsPrimitives, solveSketchOnWrapper,
} from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { dimensionRefIds } from '../../lib/sketch/refIds'
import { deleteFromSketch } from '../../lib/sketch/deleteSelection'
import { trimAtPoint } from '../../lib/sketch/tools/trimTool'
import { buildBrowserModel } from '../../lib/sketch/browserModel'
import { dimensionDisplay } from '../../lib/sketch/sketcher/sketchLayer'
import type {
  Sketch, SketchArcEntity, SketchDimension, SketchDimensionKind, SketchEntity,
} from '../../lib/sketch/types'

const SEAM_ARC: SketchArcEntity = {
  id: 'seam-arc',
  kind: 'arc',
  construction: false,
  center: { x: 0, y: 0 },
  radius: 7,
  startAngle: 3 * Math.PI / 2,
  endAngle: Math.PI / 2,
}

function arcLength(
  id: string, driving: boolean, value = 7 * Math.PI,
): SketchDimension {
  return { id, kind: 'arcLength', entityId: SEAM_ARC.id, driving, value }
}

function sketch(
  dimensions: SketchDimension[], entities: SketchEntity[] = [SEAM_ARC],
): Sketch {
  return {
    id: 'ui-50b', layerId: 'layer', entities,
    constraints: [], dimensions, solveStatus: null,
  }
}

describe('UI-50B arcLength seam measurement and shared placement mode', () => {
  it('measures the mandatory 3pi/2 -> pi/2 CCW seam as positive r*pi for driving and reference', () => {
    expect(positiveArcSweep(SEAM_ARC.startAngle, SEAM_ARC.endAngle)).toBeCloseTo(Math.PI, 12)
    expect(measureDimension([SEAM_ARC], arcLength('driving', true))).toBeCloseTo(7 * Math.PI, 12)
    expect(measureDimension([SEAM_ARC], arcLength('reference', false))).toBeCloseTo(7 * Math.PI, 12)
  })

  it('uses the existing Tab cycle to resolve Radius <-> Arc length and commit the previewed plan', () => {
    const defaultPlacement = resolveDimPlacement([SEAM_ARC], [SEAM_ARC.id], { x: 12, y: 0 })
    expect(defaultPlacement?.kind).toBe('radius')

    const family = dimForceFamily([SEAM_ARC], [SEAM_ARC.id])
    expect(family).toBe('arc')
    const forced = cycleDimForceMode(null, family!)
    expect(forced).toBe('arcLength')
    const placement = resolveDimPlacement(
      [SEAM_ARC], [SEAM_ARC.id], { x: 12, y: 0 }, { forceOrientation: forced },
    )
    expect(placement).toMatchObject({ kind: 'arcLength', value: 7 * Math.PI })
    expect(placement?.plan).toEqual({
      kind: 'arcLength', entityId: SEAM_ARC.id, value: 7 * Math.PI,
    })
    expect(cycleDimForceMode(forced, 'arc')).toBeNull()
  })

  it('makes arcLength unreachable through Tab for circle, ellipse, elliptical arc, line, and point', () => {
    const nonArcs: SketchEntity[] = [
      { id: 'circle', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 7 },
      { id: 'ellipse', kind: 'ellipse', construction: false, center: { x: 0, y: 0 },
        majorRadius: 7, minorRadius: 3, rotation: 0 },
      { id: 'elliptical-arc', kind: 'elliptical-arc', construction: false,
        center: { x: 0, y: 0 }, majorRadius: 7, minorRadius: 3, rotation: 0,
        startParam: 0, endParam: Math.PI },
      { id: 'line', kind: 'line', construction: false,
        start: { x: 0, y: 0 }, end: { x: 7, y: 0 } },
      { id: 'point', kind: 'point', construction: false, at: { x: 0, y: 0 } },
    ]
    for (const entity of nonArcs) {
      const family = dimForceFamily(nonArcs, [entity.id])
      expect(family, entity.kind).toBe(entity.kind === 'line' ? 'linear' : null)
      const state = cycleDimForce(
        { tool: 'smart-dimension', chain: { kind: 'dim', operandIds: [entity.id] } },
        nonArcs,
      )
      expect(state.chain?.kind === 'dim' ? state.chain.forceMode : null, entity.kind)
        .not.toBe('arcLength')
      expect(resolveDimPlacement(
        nonArcs, [entity.id], { x: 10, y: 10 }, { forceOrientation: 'arcLength' },
      ), entity.kind).toBeNull()
    }
  })
})

describe('UI-50B driving/reference solver contract and refusals', () => {
  it('maps a driving arcLength to Planegcs arc_length and validates but never pushes a reference', () => {
    const driving = sketchToGcsPrimitives(sketch([arcLength('drive', true)]))
    expect(driving).toContainEqual({
      id: 'drive', type: 'arc_length', a_id: SEAM_ARC.id,
      dist: 7 * Math.PI, driving: true,
    })

    const reference = sketchToGcsPrimitives(sketch([arcLength('ref', false)]))
    expect(reference.some((primitive) => primitive.id === 'ref')).toBe(false)
  })

  it('refuses malformed arcLength targets by entity kind name', () => {
    const targets: SketchEntity[] = [
      { id: 'full-circle', kind: 'circle', construction: false,
        center: { x: 0, y: 0 }, radius: 4 },
      { id: 'ellipse', kind: 'ellipse', construction: false,
        center: { x: 0, y: 0 }, majorRadius: 4, minorRadius: 2, rotation: 0 },
      { id: 'elliptical-arc', kind: 'elliptical-arc', construction: false,
        center: { x: 0, y: 0 }, majorRadius: 4, minorRadius: 2, rotation: 0,
        startParam: 0, endParam: Math.PI },
      { id: 'line', kind: 'line', construction: false,
        start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
      { id: 'point', kind: 'point', construction: false, at: { x: 0, y: 0 } },
    ]
    for (const entity of targets) {
      const malformed = {
        id: `bad-${entity.kind}`, kind: 'arcLength', entityId: entity.id,
        driving: true, value: 4,
      } as SketchDimension
      expect(() => sketchToGcsPrimitives(sketch([malformed], [entity])), entity.kind)
        .toThrow(new RegExp(`is a ${entity.kind}.*expected arc`))
    }
  })

  it('keeps existing conflict marking when a fixed seam arc cannot satisfy a changed length', async () => {
    const wrapper = await createGcsWrapper()
    try {
      const conflicting: Sketch = {
        ...sketch([arcLength('arc-length-conflict', true, 3 * Math.PI)]),
        constraints: [{ id: 'fixed-seam', kind: 'fix', entityId: SEAM_ARC.id }],
      }
      const out = solveSketchOnWrapper(wrapper, conflicting)
      expect(out.ok).toBe(false)
      expect(out.status.conflicting).toContain('arc-length-conflict')
    } finally {
      wrapper.destroy_gcs_module()
    }
  })
})

describe('UI-50B derived consumers, renderer, delete, trim, and reference tracking', () => {
  it('formats explicitly, fails loud on an unknown kind, and derives browser order from the label map', () => {
    expect(formatDimensionValue('arcLength', 7 * Math.PI, true)).toBe('Larc 21.99')
    expect(formatDimensionValue('arcLength', 7 * Math.PI, false)).toBe('(Larc 21.99)')
    expect(() => formatDimensionValue(
      'not-a-dimension' as SketchDimensionKind, 1, true,
    )).toThrow(UnknownSketchDimensionKindError)
    expect(DIMENSION_KINDS).toContain('arcLength')

    const model = buildBrowserModel(sketch([
      { id: 'radius', kind: 'radius', entityId: SEAM_ARC.id, driving: true, value: 7 },
      arcLength('length', false),
    ]), null)
    expect(model.groups.map((group) => group.kind)).toEqual(['radius', 'arcLength'])
    expect(model.groups[1].title).toBe('Arc length dim')
    expect(model.groups[1].rows[0].operands).toContain('(21.991 mm)')
  })

  it('renders the measured arc, endpoint arrows, leader, and label in the shared renderer', () => {
    const dim = { ...arcLength('rendered', true), labelAnchor: { x: 12, y: 0 } }
    const display = dimensionDisplay(sketch([dim]), dim)
    expect(display).toEqual({ anchor: { x: 12, y: 0 }, text: 'Larc 21.99' })
    const guides = dimGuides([SEAM_ARC], dim, display!.anchor, 0.5)
    expect(guides).toHaveLength(4)
    expect(guides[0].length).toBeGreaterThan(20)
    expect(guides.flat().every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))
      .toBe(true)
  })

  it('participates in refIds/delete cascade and reference remeasurement', () => {
    const reference = arcLength('tracked', false, 1)
    expect(dimensionRefIds(reference)).toEqual([SEAM_ARC.id])
    expect(deleteFromSketch(sketch([reference]), [SEAM_ARC.id])?.dimensions).toEqual([])
    expect(remeasureReferenceDimensions([SEAM_ARC], [reference])).toEqual([
      { ...reference, value: 7 * Math.PI },
    ])
  })

  it('repairs an arcLength dimension to the surviving arc after trim', () => {
    const source: SketchArcEntity = {
      id: 'trim-arc', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI,
    }
    const cutter: SketchEntity = {
      id: 'cutter', kind: 'line', construction: false,
      start: { x: 0, y: -1 }, end: { x: 0, y: 8 },
    }
    const before: SketchDimension = {
      id: 'trim-length', kind: 'arcLength', entityId: source.id,
      driving: true, value: 5 * Math.PI,
    }
    const outcome = trimAtPoint(
      sketch([before], [source, cutter]),
      { x: 5 * Math.cos(Math.PI / 8), y: 5 * Math.sin(Math.PI / 8) },
      0.4,
      () => 'new-piece',
    )
    expect(outcome.transform).not.toBeNull()
    const kept = outcome.transform!.entities.find((entity) => entity.id === source.id)
    const repaired = outcome.transform!.dimensions.find((dimension) => dimension.id === before.id)
    expect(kept?.kind).toBe('arc')
    expect(repaired?.kind).toBe('arcLength')
    expect(measureDimension(outcome.transform!.entities, repaired!)).toBeCloseTo(repaired!.value, 12)
    expect(outcome.notice).toContain('arc length dim now measures the kept piece')
  })
})

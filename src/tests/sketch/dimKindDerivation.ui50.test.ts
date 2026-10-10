import { describe, expect, it } from 'vitest'
import { dimModeLabel, type DimModeLabel } from '../../lib/sketch/tools/dimTool'
import type { SketchDimensionKind } from '../../lib/sketch/types'

// `satisfies Record<SketchDimensionKind, ...>` makes this literal fail the
// build whenever the type union grows without a corresponding enumeration.
// The runtime pass through dimModeLabel separately catches a missing production
// label because Vitest strips the production Record type before execution.
const EXPECTED_LABEL_BY_KIND = {
  distance: 'Aligned',
  distanceX: 'Horizontal',
  distanceY: 'Vertical',
  // WO-1867: ONE label for both ordinate axes -- the axis is a field on the
  // dimension, and this map is keyed by kind.
  ordinate: 'Ordinate',
  distancePL: 'Perpendicular',
  radius: 'Radius',
  diameter: 'Diameter',
  arcLength: 'Arc length',
  majorRadius: 'Major radius',
  minorRadius: 'Minor radius',
  angle: 'Angle',
  // WO-1868: three-point / arc included angle reads as an Angle too.
  angle3: 'Angle',
  focusDistance: 'Focus distance',
  d1xd2: 'D1 x D2',
} satisfies Record<SketchDimensionKind, DimModeLabel>

const DIMENSION_KINDS = Object.keys(EXPECTED_LABEL_BY_KIND) as SketchDimensionKind[]

describe('SketchDimensionKind derivation', () => {
  it('resolves one production mode label for every type-derived kind', () => {
    const resolved = DIMENSION_KINDS.map((kind) => [kind, dimModeLabel(kind)] as const)
    const presentCount = resolved.filter(([, label]) => label !== undefined).length

    expect(presentCount).toBe(DIMENSION_KINDS.length)
    expect(Object.fromEntries(resolved)).toEqual(EXPECTED_LABEL_BY_KIND)
  })
})

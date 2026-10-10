// WO-1478 (Codex audit BUG-500): unbindSketchTextPath cleared pathId/
// pathOffsetMm/pathFlip/pathAlign without ever touching the entity's stored
// anchor (`at`). For center/right-aligned on-path text the RENDERED position
// is `at` warped by an effective start offset (effectiveStartOffsetMm), so
// clearing the binding left the free entity at the raw, un-centered anchor --
// every glyph stroke jumped even though nothing about the visible layout
// needed to change for a straight guide. The fix bakes the resolved world
// position (and baseline orientation) into `at`/`rotation` before clearing
// the path fields, using the SAME resolver the drag-to-free handler already
// uses (effectiveStartOffsetMm), so the free entity renders exactly where the
// on-path entity rendered a moment before.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Sketch, SketchTextEntity } from '../../lib/sketch/types'
import {
  pathLUT, effectiveStartOffsetMm, textEntityAdvanceMm,
  textOnPathToWorldPolylines,
} from '../../lib/sketch/textOnPath'
import { textToWorldPolylines } from '../../lib/sketch/text'

vi.stubGlobal('localStorage', {
  getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
})
class NoopWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', NoopWorker)

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
function closeVec(a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-6): boolean {
  return close(a.x, b.x, eps) && close(a.y, b.y, eps)
}
function closePolylines(
  a: readonly (readonly { x: number; y: number }[])[],
  b: readonly (readonly { x: number; y: number }[])[],
  eps = 1e-6,
): boolean {
  if (a.length !== b.length) return false
  return a.every((poly, i) => {
    const other = b[i]
    if (poly.length !== other.length) return false
    return poly.every((p, j) => closeVec(p, other[j], eps))
  })
}

// Horizontal straight guide: (0,0) -> (100,0). Arc length s == x.
const LINE = {
  id: 'ln', kind: 'line' as const, construction: false,
  start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
}
// Curved guide: circle r=20 at the origin (seam s=0 at (20,0), CCW).
const CIRCLE = {
  id: 'ci', kind: 'circle' as const, construction: false,
  center: { x: 0, y: 0 }, radius: 20,
}

function textOn(over: Partial<SketchTextEntity> = {}): SketchTextEntity {
  return {
    id: 'tx', kind: 'text', construction: false,
    at: { x: 999, y: 999 }, text: 'HI', height: 15, rotation: 1.23,
    fontStyle: 'single-line',
    ...over,
  }
}

describe('WO-1478: unbindSketchTextPath preserves the visible position', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
  })

  function seed(entities: Sketch['entities']): void {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L', entities, constraints: [],
        dimensions: [], solveStatus: null,
      },
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTextEditId: null, sketchPickPathForTextId: null,
      sketchTextPathId: null, sketchTextPathOffsetMm: 0, sketchTextPathFlip: false,
      sketchTextPathAlign: 'free',
    })
  }
  const entity = (id: string) =>
    useCamStore.getState().activeSketch!.entities.find((e) => e.id === id) as SketchTextEntity

  describe.each(['left', 'center', 'right', 'free'] as const)(
    'straight guide, align=%s', (align) => {
      it('detach leaves every glyph stroke exactly where it rendered while attached', () => {
        seed([LINE, textOn({
          pathId: 'ln', pathOffsetMm: align === 'free' ? 37 : 0, pathFlip: false,
          ...(align === 'free' ? {} : { pathAlign: align }),
        })])
        const before = entity('tx')
        const linePath = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'ln')!
        const expectedStrokes = textOnPathToWorldPolylines(before, linePath)

        useCamStore.getState().unbindSketchTextPath('tx')

        const after = entity('tx')
        expect(after.pathId).toBeUndefined()
        expect(after.pathOffsetMm).toBeUndefined()
        expect(after.pathAlign).toBeUndefined()
        const actualStrokes = textToWorldPolylines(after.text, after.height, after.at, after.rotation ?? 0)
        expect(closePolylines(expectedStrokes, actualStrokes)).toBe(true)
      })
    },
  )

  it('a curved guide keeps the resolved start point (not a silent jump) and logs the tradeoff', () => {
    seed([CIRCLE, textOn({ pathId: 'ci', pathOffsetMm: 0, pathFlip: false, pathAlign: 'center' })])
    const before = entity('tx')
    const circlePath = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'ci')!
    const lut = pathLUT(circlePath)!
    const resolved = effectiveStartOffsetMm(before, lut, textEntityAdvanceMm(before))
    const expectedAnchor = lut.pointAt(resolved)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useCamStore.getState().unbindSketchTextPath('tx')
    const after = entity('tx')

    expect(after.pathId).toBeUndefined()
    expect(closeVec(after.at, expectedAnchor)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('curved guide'))
    warn.mockRestore()
  })

  it('a straight guide does NOT log the curved-guide disclosure', () => {
    seed([LINE, textOn({ pathId: 'ln', pathOffsetMm: 0, pathFlip: false, pathAlign: 'left' })])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useCamStore.getState().unbindSketchTextPath('tx')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('save/reload (plain serialize round-trip) preserves the resolved position', () => {
    seed([LINE, textOn({ pathId: 'ln', pathOffsetMm: 0, pathFlip: false, pathAlign: 'center' })])
    useCamStore.getState().unbindSketchTextPath('tx')
    const before = entity('tx')
    const reloaded = JSON.parse(JSON.stringify(before)) as SketchTextEntity
    expect(reloaded.at).toEqual(before.at)
    expect(reloaded.rotation).toEqual(before.rotation)
    expect(reloaded.pathId).toBeUndefined()
  })

  it('a flipped on-path text detaches to the same flipped visible position', () => {
    seed([LINE, textOn({ pathId: 'ln', pathOffsetMm: 0, pathFlip: true, pathAlign: 'left' })])
    const before = entity('tx')
    const linePath = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'ln')!
    const expectedStrokes = textOnPathToWorldPolylines(before, linePath)

    useCamStore.getState().unbindSketchTextPath('tx')

    const after = entity('tx')
    const actualStrokes = textToWorldPolylines(after.text, after.height, after.at, after.rotation ?? 0)
    expect(closePolylines(expectedStrokes, actualStrokes)).toBe(true)
  })

  it('a text with no pathId is a no-op on the anchor (already free)', () => {
    seed([LINE, textOn({ at: { x: 4, y: 7 }, rotation: 0.5 })])
    useCamStore.getState().unbindSketchTextPath('tx')
    const after = entity('tx')
    expect(after.at).toEqual({ x: 4, y: 7 })
    expect(after.rotation).toBe(0.5)
  })

  // WO-1478 fix round (audit FAIL): detach bakes a new entity.rotation but the
  // toolbox Angle field is a SEPARATE mirror field (sketchTextRotationDeg) --
  // left stale, the next touch of that field snaps the text to the old angle.
  // Flip a horizontal guide so the baked rotation (180deg) differs from the
  // stale seeded value (0deg); a same-value case can't tell "updated" from
  // "coincidentally already right".
  it('detach with the edit open pushes the baked rotation into the toolbox Angle field', () => {
    seed([LINE, textOn({ pathId: 'ln', pathOffsetMm: 0, pathFlip: true, pathAlign: 'left' })])
    useCamStore.setState({ sketchTextEditId: 'tx', sketchTextRotationDeg: 0 })

    useCamStore.getState().unbindSketchTextPath('tx')

    const after = entity('tx')
    const rotationDeg = useCamStore.getState().sketchTextRotationDeg
    expect(close(rotationDeg, ((after.rotation ?? 0) * 180) / Math.PI)).toBe(true)
    expect(close(Math.abs(rotationDeg), 180)).toBe(true)
  })

  it('the no-op detach (no pathId, nothing baked) leaves the toolbox Angle field untouched', () => {
    seed([LINE, textOn({ at: { x: 4, y: 7 }, rotation: 0.5 })])
    useCamStore.setState({ sketchTextEditId: 'tx', sketchTextRotationDeg: 42 })

    useCamStore.getState().unbindSketchTextPath('tx')

    expect(useCamStore.getState().sketchTextRotationDeg).toBe(42)
  })
})

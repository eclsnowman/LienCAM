// Unified font picker store wiring: ONE selection sets BOTH the text style and
// the outline family (store.setSketchTextFont), so the toolbox can present a
// single always-visible Font dropdown instead of a font choice hidden behind an
// "outline" toggle. The single-line/Hershey entry -> style 'single-line'; any
// outline family key -> style 'outline' + that family. Also proves the pick
// routes onto a live placed-text edit (round-trip) via applyTextEditPatch.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SketchTextEntity } from '../../lib/sketch/types'
import { SINGLE_LINE_FONT_VALUE } from '../../lib/sketch/textOutline'

// WO-1052: the `../../lib/geometry/worker` vi.mock this file used to carry
// mocked a module specifier that resolves to nothing in src/ and an export
// (`getGeometryWorker`) referenced nowhere else in the repo - dead code left
// over from an earlier architecture. Removed rather than typed (there is no
// real module to type against) and rather than left untyped (nothing in this
// file or in src/ ever imports it, so the mock was a no-op); the Worker global
// stub immediately below is what the sketch worker path actually exercises.
class NoopWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', NoopWorker)

describe('unified font picker: one pick sets style + family', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
  })
  beforeEach(() => {
    useCamStore.setState({
      sketchTextStyle: 'single-line',
      sketchTextFontFamily: 'Rounded Mplus 1c',
      sketchTextEditId: null,
    } as never)
  })

  it('an outline family selection -> style outline + that family', () => {
    useCamStore.getState().setSketchTextFont('Helvetiker Bold')
    const s = useCamStore.getState()
    expect(s.sketchTextStyle).toBe('outline')
    expect(s.sketchTextFontFamily).toBe('Helvetiker Bold')
  })

  it('the single-line sentinel -> style single-line', () => {
    // Start from outline, then pick the Hershey entry.
    useCamStore.getState().setSketchTextFont('Optimer')
    expect(useCamStore.getState().sketchTextStyle).toBe('outline')
    useCamStore.getState().setSketchTextFont(SINGLE_LINE_FONT_VALUE)
    expect(useCamStore.getState().sketchTextStyle).toBe('single-line')
  })

  it('routes the pick onto a live placed-text edit (round-trip)', () => {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [
          { id: 'tx', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'HI', height: 5, rotation: 0, fontStyle: 'single-line' },
        ],
        constraints: [], dimensions: [], solveStatus: null,
      },
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTextEditId: 'tx',
    } as never)
    const ent = () =>
      useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'tx') as SketchTextEntity

    // Pick an outline face -> the edited entity gains outline + family.
    useCamStore.getState().setSketchTextFont('Gentilis')
    expect(ent().fontStyle).toBe('outline')
    expect(ent().fontFamily).toBe('Gentilis')

    // Pick the single-line entry -> the entity drops back to single-line (Hershey),
    // and the family is cleared (that face is always Hershey).
    useCamStore.getState().setSketchTextFont(SINGLE_LINE_FONT_VALUE)
    expect(ent().fontStyle).toBe('single-line')
    expect(ent().fontFamily).toBeUndefined()
  })

  it('picking the default outline face leaves fontFamily undefined on the entity (byte-identical default)', () => {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [
          { id: 'tx', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'HI', height: 5, rotation: 0, fontStyle: 'single-line' },
        ],
        constraints: [], dimensions: [], solveStatus: null,
      },
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTextEditId: 'tx',
    } as never)
    useCamStore.getState().setSketchTextFont('Rounded Mplus 1c')
    const ent =
      useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'tx') as SketchTextEntity
    expect(ent.fontStyle).toBe('outline')
    // Default family maps to undefined on the entity (the default text path).
    expect(ent.fontFamily).toBeUndefined()
  })
})

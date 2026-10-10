// Single-line text DRAW tool + bake + solver-inert mapping (sketch text C3,
// part A). Headless. Mirrors splineTools.test.ts.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { toolClick, type ToolState } from '../../lib/sketch/tools/toolMachine'
import { textClick } from '../../lib/sketch/tools/textTools'
import { textLocalBBox } from '../../lib/sketch/text'
import { textEntityAdvanceMm } from '../../lib/sketch/textOnPath'
import { toolOverlay } from '../../lib/sketch/tools/toolOverlay'
import { bakeSketch } from '../../lib/sketch/bake'
import {
  sketchToGcsPrimitives, entitiesFromSolved,
} from '../../lib/sketch/solver/gcsMapping'
import type { Sketch, SketchEntity, SketchTextEntity } from '../../lib/sketch/types'

// Store-flow harness (double-click edit block below): the edit actions never
// touch the solver worker, but importing the store must not new a real Worker
// or read a real localStorage under jsdom — same stubs as mirrorStoreFlow.
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})
class NoopWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', NoopWorker)

// WO SKC-14B: the tool slice (armed tool, chain, construction mode, the tool
// click/arm/escape actions) moved out of the CAM store into the sketcher
// package. Store-flow blocks below drive it through `sketcherTools` and read
// `sketcherToolStore`; every sketchText* field/action stays on the CAM store.
// Both are dynamically imported AFTER the store so the CAM document sink is
// already bound into the package.
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

const TOL = 0.5
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}
function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

// NOTE: the USER-FACING text flow is now WYSIWYG create-then-edit (see the
// "text tool WYSIWYG placement (store flow)" describe below): a click places an
// EMPTY entity and opens the in-canvas editor. textClick / the machine 'text'
// case remain as the pure headless primitive (preview===commit geometry) and
// are still validated here.
describe('text tool pure primitive (textClick / machine)', () => {
  it('a click places ONE text entity carrying the ctx string + height', () => {
    const commit = textClick(
      { x: 7, y: 3 }, { text: 'HELLO', height: 6 }, false, idFactory(),
    )!
    expect(commit).not.toBeNull()
    expect(commit.constraints).toEqual([])
    const e = commit.entities[0] as SketchTextEntity
    expect(e.kind).toBe('text')
    expect(e.text).toBe('HELLO')
    expect(e.height).toBe(6)
    expect(e.fontStyle).toBe('single-line')
    expect(e.rotation).toBe(0)
    expect(e.at).toEqual({ x: 7, y: 3 })
    expect(e.construction).toBe(false)
  })

  it('the construction flag is carried onto the entity', () => {
    const e = textClick(
      { x: 0, y: 0 }, { text: 'X', height: 5 }, true, idFactory(),
    )!.entities[0] as SketchTextEntity
    expect(e.construction).toBe(true)
  })

  it('an empty / whitespace string is rejected (no commit)', () => {
    expect(textClick({ x: 0, y: 0 }, { text: '', height: 5 }, false, idFactory())).toBeNull()
    expect(textClick({ x: 0, y: 0 }, { text: '   ', height: 5 }, false, idFactory())).toBeNull()
  })

  it('a non-positive height is rejected (no commit)', () => {
    expect(textClick({ x: 0, y: 0 }, { text: 'A', height: 0 }, false, idFactory())).toBeNull()
    expect(textClick({ x: 0, y: 0 }, { text: 'A', height: -2 }, false, idFactory())).toBeNull()
  })

  it('routes through the tool machine with the ctx string + height', () => {
    const r = toolClick(armed('text'), { x: 2, y: 2 }, TOL, idFactory(), {
      entities: [], textValue: 'HI', textHeight: 8,
    })
    expect(r.commit).not.toBeNull()
    const e = r.commit!.entities[0] as SketchTextEntity
    expect(e.text).toBe('HI')
    expect(e.height).toBe(8)
    expect(e.at).toEqual({ x: 2, y: 2 })
    // Single-click commit: no chain is left armed.
    expect(r.state.chain).toBeNull()
  })

  it('a degenerate ctx string makes the machine click a clean no-op', () => {
    const r = toolClick(armed('text'), { x: 0, y: 0 }, TOL, idFactory(), {
      entities: [], textValue: '   ', textHeight: 5,
    })
    expect(r.commit).toBeNull()
  })

  it('the armed text tool has NO cursor ghost (WYSIWYG: nothing to preview)', () => {
    // The old workflow ghosted the toolbox string at the cursor; the WYSIWYG
    // workflow places an EMPTY entity and the user types in place, so a
    // string-at-cursor preview would render as a floating dashed duplicate
    // of the live-typed text. Contract: no overlay at all for 'text'.
    expect(toolOverlay(armed('text'), { x: 5, y: 5 }, TOL, { entities: [] }))
      .toBeNull()
  })

  it('a non-zero rotation (radians) flows through the machine into the commit', () => {
    const rot = Math.PI / 6 // 30 deg
    const r = toolClick(armed('text'), { x: 0, y: 0 }, TOL, idFactory(), {
      entities: [], textValue: 'HI', textHeight: 8, textRotation: rot,
    })
    const e = r.commit!.entities[0] as SketchTextEntity
    expect(e.rotation).toBeCloseTo(rot)
    // Omitting the rotation still defaults to horizontal (byte-identical path).
    const r0 = toolClick(armed('text'), { x: 0, y: 0 }, TOL, idFactory(), {
      entities: [], textValue: 'HI', textHeight: 8,
    })
    expect((r0.commit!.entities[0] as SketchTextEntity).rotation).toBe(0)
  })
})

describe('placed-text double-click edit (store flow, live in-place mutation)', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
  })
  beforeEach(() => {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [{
          id: 'tx', kind: 'text', construction: false,
          at: { x: 1, y: 2 }, text: 'HI', height: 5, rotation: 0,
          fontStyle: 'single-line',
        }],
        constraints: [], dimensions: [],
        solveStatus: null,
      },
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTextEditId: null, sketchTextValue: 'TEXT', sketchTextHeight: 5,
      sketchTextRotationDeg: 0, sketchTextStyle: 'single-line',
      sketchNotice: null,
    })
  })
  const txt = () =>
    useCamStore.getState().activeSketch!.entities[0] as SketchTextEntity

  it('begin loads the entity fields into the toolbox inputs', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    const s = useCamStore.getState()
    expect(s.sketchTextEditId).toBe('tx')
    expect(s.sketchTextValue).toBe('HI')
    expect(s.sketchTextHeight).toBe(5)
    expect(s.sketchTextRotationDeg).toBe(0)
  })

  it('a non-text pick is a no-op (no edit opens)', () => {
    useCamStore.getState().beginSketchTextEdit('does-not-exist')
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
  })

  it('begin opens with the CARET at the end of the string (M1b)', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    expect(useCamStore.getState().sketchTextCaretIndex).toBe(2) // 'HI'.length
  })

  it('setSketchTextCaretIndex updates the transient caret index', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().setSketchTextCaretIndex(1)
    expect(useCamStore.getState().sketchTextCaretIndex).toBe(1)
  })

  it('commit resets the caret index to null', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().setSketchTextCaretIndex(1)
    useCamStore.getState().commitSketchTextEdit()
    expect(useCamStore.getState().sketchTextCaretIndex).toBeNull()
  })

  it('cancel resets the caret index to null', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().setSketchTextCaretIndex(1)
    useCamStore.getState().cancelSketchTextEdit()
    expect(useCamStore.getState().sketchTextCaretIndex).toBeNull()
  })

  it('setting the angle rotates the placed entity IN PLACE (same id)', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().setSketchTextRotation(90)
    const e = txt()
    expect(e.id).toBe('tx') // mutated in place, not delete+redo
    expect(e.rotation).toBeCloseTo(Math.PI / 2)
    // Anchor + string untouched — a proper edit, not a re-placement.
    expect(e.at).toEqual({ x: 1, y: 2 })
    expect(e.text).toBe('HI')
    // Commit finalizes; the rotation persists on the entity.
    useCamStore.getState().commitSketchTextEdit()
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
    expect(txt().rotation).toBeCloseTo(Math.PI / 2)
  })

  it('editing the string / height mutates in place too', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().setSketchTextValue('HELLO')
    useCamStore.getState().setSketchTextHeight(9)
    const e = txt()
    expect(e.id).toBe('tx')
    expect(e.text).toBe('HELLO')
    expect(e.height).toBe(9)
  })

  it('Esc cancels: the live mutation reverts and the pushed undo step is dropped', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().setSketchTextRotation(45)
    expect(txt().rotation).toBeCloseTo(Math.PI / 4)
    // A live change pushed exactly one undo step.
    expect(useCamStore.getState().sketchHistory.length).toBe(1)
    useCamStore.getState().cancelSketchTextEdit()
    const e = txt()
    expect(e.rotation).toBe(0) // reverted to the pre-edit entity
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
    expect(useCamStore.getState().sketchHistory.length).toBe(0) // no dangling undo
    // Reverting an EXISTING edit is a normal cancel (the original is
    // restored, nothing is lost) -- it stays QUIET, no notice.
    expect(useCamStore.getState().sketchNotice).toBeNull()
  })
})

describe('text tool WYSIWYG placement (store flow, create-then-edit)', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
    ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
  })
  beforeEach(() => {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [], constraints: [], dimensions: [],
        solveStatus: null,
      },
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchSelectedIds: [],
      sketchTextEditId: null, sketchTextValue: 'TEXT', sketchTextHeight: 5,
      sketchTextRotationDeg: 0, sketchTextStyle: 'single-line',
      sketchPickPathForTextId: null, sketchNotice: null,
    } as never)
    sketcherToolStore.setState({ tool: 'text', chain: null, constructionMode: false })
  })
  const ents = () => useCamStore.getState().activeSketch!.entities
  const txt = () => ents()[0] as SketchTextEntity | undefined

  it('a placement click CREATES an empty text entity + ENTERS edit mode at the anchor', () => {
    sketcherTools.click({ x: 10, y: 20 }, 0.5, null, false)
    const s = useCamStore.getState()
    expect(ents().length).toBe(1)
    const e = txt()!
    expect(e.kind).toBe('text')
    expect(e.text).toBe('') // seeded EMPTY -> the user types in the workspace
    expect(e.height).toBe(5)
    expect(e.at).toEqual({ x: 10, y: 20 })
    // The in-canvas editor is now open for the just-created entity.
    expect(s.sketchTextEditId).toBe(e.id)
    // Caret ready at the (empty) string's end -- the in-canvas caret is
    // visible AT the emit origin before anything is typed (M1b).
    expect(s.sketchTextCaretIndex).toBe(0)
    // The create pushed exactly ONE undo step (create+type = one undo).
    expect(s.sketchHistory.length).toBe(1)
  })

  it('typing updates the entity LIVE, Enter (commit) keeps it', () => {
    sketcherTools.click({ x: 1, y: 2 }, 0.5, null, false)
    const id = useCamStore.getState().sketchTextEditId!
    useCamStore.getState().setSketchTextValue('HELLO')
    expect(txt()!.text).toBe('HELLO') // live mutation, same entity
    expect(txt()!.id).toBe(id)
    // Live typing REUSES the create's undo step (still one).
    expect(useCamStore.getState().sketchHistory.length).toBe(1)
    useCamStore.getState().commitSketchTextEdit()
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
    expect(ents().length).toBe(1)
    expect(txt()!.text).toBe('HELLO')
    expect(useCamStore.getState().sketchHistory.length).toBe(1) // one undo total
  })

  it('an EMPTY commit REMOVES the just-created entity WITH a notice (never silent)', () => {
    sketcherTools.click({ x: 3, y: 4 }, 0.5, null, false)
    expect(ents().length).toBe(1)
    expect(useCamStore.getState().sketchHistory.length).toBe(1)
    // Never typed -> commit with empty text -> removal + status-bar notice.
    useCamStore.getState().commitSketchTextEdit()
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
    expect(ents().length).toBe(0) // no dangling empty text
    expect(useCamStore.getState().sketchHistory.length).toBe(0) // undo dropped
    expect(useCamStore.getState().sketchNotice).toBe('Empty text discarded')
  })

  it('a whitespace-only commit also removes the entity, with the same notice', () => {
    sketcherTools.click({ x: 0, y: 0 }, 0.5, null, false)
    useCamStore.getState().setSketchTextValue('   ')
    useCamStore.getState().commitSketchTextEdit()
    expect(ents().length).toBe(0)
    expect(useCamStore.getState().sketchHistory.length).toBe(0)
    expect(useCamStore.getState().sketchNotice).toBe('Empty text discarded')
  })

  it('Esc on a fresh placement WITH typed text COMMITS it (typed work survives)', () => {
    sketcherTools.click({ x: 5, y: 6 }, 0.5, null, false)
    useCamStore.getState().setSketchTextValue('AB')
    expect(ents().length).toBe(1)
    useCamStore.getState().cancelSketchTextEdit()
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
    expect(ents().length).toBe(1) // Esc never destroys typed work
    expect(txt()!.text).toBe('AB')
    expect(useCamStore.getState().sketchHistory.length).toBe(1) // one undo kept
  })

  it('Esc on an UNTYPED fresh placement cancels it WITH a notice', () => {
    sketcherTools.click({ x: 5, y: 6 }, 0.5, null, false)
    expect(ents().length).toBe(1)
    useCamStore.getState().cancelSketchTextEdit()
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
    expect(ents().length).toBe(0) // nothing typed -> nothing kept
    expect(useCamStore.getState().sketchHistory.length).toBe(0)
    expect(useCamStore.getState().sketchNotice).toBe('Text canceled - nothing typed')
  })

  it('the placement click snaps the anchor to the provided snap point', () => {
    sketcherTools.click(
      { x: 10, y: 10 }, 0.5,
      { point: { x: 9, y: 9 }, inferences: [], wake: null } as never,
      false,
    )
    expect(txt()!.at).toEqual({ x: 9, y: 9 })
  })

  // Canvas pointerdown preventDefault suppresses the browser blur that would
  // commit SketchTextInput, so the STORE must finish an open edit before any
  // new canvas tool click (standard editor click-away semantics) — otherwise an
  // untyped placement is orphaned SILENTLY as an invisible "" entity
  // (ADR-0003 class).
  it('a new canvas click with an open EMPTY edit discards it WITH a notice (no orphan)', () => {
    sketcherTools.click({ x: 1, y: 1 }, 0.5, null, false)
    expect(ents().length).toBe(1) // caret open on the empty placement
    // Without typing, click elsewhere to place another text: the first
    // (empty) placement must be discarded, never silently accumulated.
    sketcherTools.click({ x: 30, y: 30 }, 0.5, null, false)
    const s = useCamStore.getState()
    expect(ents().length).toBe(1) // ONLY the new placement remains
    expect(txt()!.at).toEqual({ x: 30, y: 30 })
    expect(s.sketchTextEditId).toBe(txt()!.id) // caret moved to the new one
    expect(s.sketchNotice).toBe('Empty text discarded') // fail loud
  })

  it('a new canvas click with an open TYPED edit commits it first (typed work kept)', () => {
    sketcherTools.click({ x: 1, y: 1 }, 0.5, null, false)
    useCamStore.getState().setSketchTextValue('HI')
    sketcherTools.click({ x: 30, y: 30 }, 0.5, null, false)
    const s = useCamStore.getState()
    expect(ents().length).toBe(2) // first committed, second is the new caret
    const first = ents()[0] as SketchTextEntity
    expect(first.text).toBe('HI') // typed work survived the click-away
    expect(s.sketchTextEditId).toBe((ents()[1] as SketchTextEntity).id)
  })
})

// M1c drag-while-typing, store side: with the TEXT tool armed and an edit
// OPEN, a tool click that lands ON the edited text belongs to that edit --
// it must NOT commit (6d93e68 click-away) and must NOT place another text.
// The viewport turns the same press into a drag; a stationary press reaches
// sketchToolClick, where this guard no-ops it. Clicks AWAY keep the 6d93e68
// commit+place behavior byte-identical.
describe('M1c: armed-tool click ON the edited text never commits (store guard)', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
    ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
  })
  beforeEach(() => {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [{
          id: 'ln', kind: 'line', construction: false,
          start: { x: 0, y: 0 }, end: { x: 20, y: 0 },
        }],
        constraints: [], dimensions: [], solveStatus: null,
      },
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchSelectedIds: [],
      sketchTextEditId: null, sketchTextValue: 'TEXT', sketchTextHeight: 5,
      sketchTextRotationDeg: 0, sketchTextStyle: 'single-line',
      sketchTextPathId: null, sketchTextPathOffsetMm: 0, sketchTextPathFlip: false,
      sketchTextPathAlign: 'free',
      sketchPickPathForTextId: null, sketchNotice: null,
    } as never)
    sketcherToolStore.setState({ tool: 'text', chain: null, constructionMode: false })
  })
  const ents = () => useCamStore.getState().activeSketch!.entities
  const texts = () =>
    ents().filter((e) => e.kind === 'text') as SketchTextEntity[]

  it('FREE text: a click INSIDE the edited bbox is a no-op (edit stays open, no new entity)', () => {
    // Place free text far from the line, type into it.
    sketcherTools.click({ x: 10, y: 10 }, 0.5, null, false)
    const id = useCamStore.getState().sketchTextEditId!
    useCamStore.getState().setSketchTextValue('HELLO')
    // Click the CENTER of its bbox (rotation 0, anchor at (10,10)).
    const box = textLocalBBox('HELLO', 5)!
    const inside = {
      x: 10 + (box.minX + box.maxX) / 2,
      y: 10 + (box.minY + box.maxY) / 2,
    }
    sketcherTools.click(inside, 0.5, null, false)
    const s = useCamStore.getState()
    expect(s.sketchTextEditId).toBe(id) // caret still open on the SAME edit
    expect(texts().length).toBe(1) // NO second placement
    expect(texts()[0].text).toBe('HELLO') // value untouched
    expect(s.sketchNotice).not.toBe('Empty text discarded')
  })

  it('FREE text: a click AWAY still commits + places a new text (6d93e68 holds)', () => {
    sketcherTools.click({ x: 10, y: 10 }, 0.5, null, false)
    const firstId = useCamStore.getState().sketchTextEditId!
    useCamStore.getState().setSketchTextValue('HELLO')
    sketcherTools.click({ x: 40, y: 40 }, 0.5, null, false)
    const s = useCamStore.getState()
    expect(texts().length).toBe(2) // committed + the new placement
    expect(texts()[0].id).toBe(firstId)
    expect(texts()[0].text).toBe('HELLO') // typed work survived
    expect(s.sketchTextEditId).toBe(texts()[1].id) // caret on the NEW one
  })

  it('ON-PATH text: a click INSIDE the warped band is a no-op (edit stays open, still attached)', () => {
    // Birth on the curve (click 0.4mm off the line attaches, offset ~5).
    sketcherTools.click({ x: 5, y: 0.4 }, 0.5, null, false)
    const id = useCamStore.getState().sketchTextEditId!
    useCamStore.getState().setSketchTextValue('HI')
    const e = texts()[0]
    expect(e.pathId).toBe('ln')
    // Band midpoint: the path is the +X line with +normal = +Y, so the
    // warped band is the local bbox translated by the start offset.
    const box = textLocalBBox('HI', 5)!
    expect(textEntityAdvanceMm(e)).toBeGreaterThan(0) // sanity: box exists
    const inside = {
      x: e.pathOffsetMm! + (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
    }
    sketcherTools.click(inside, 0.5, null, false)
    const s = useCamStore.getState()
    expect(s.sketchTextEditId).toBe(id) // edit survived the click
    expect(texts().length).toBe(1) // no new placement
    expect(texts()[0].text).toBe('HI')
    expect(texts()[0].pathId).toBe('ln') // still attached
  })

  it('ON-PATH text: a click AWAY still commits (attached text kept, new free text placed)', () => {
    sketcherTools.click({ x: 5, y: 0.4 }, 0.5, null, false)
    useCamStore.getState().setSketchTextValue('HI')
    sketcherTools.click({ x: 10, y: 15 }, 0.5, null, false)
    const s = useCamStore.getState()
    expect(texts().length).toBe(2)
    expect(texts()[0].text).toBe('HI')
    expect(texts()[0].pathId).toBe('ln') // commit kept the attachment
    expect(texts()[1].pathId).toBeUndefined() // the away click was far from the curve
    expect(s.sketchTextEditId).toBe(texts()[1].id)
  })
})

// Shared fixture for the two on-path placement gestures: a 20mm line, a
// (non-sampleable) point, and a clean tool/editor state.
function onPathPlacementState() {
  return {
    activeSketch: {
      id: 'sk', layerId: 'L',
      entities: [
        { id: 'ln', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
        { id: 'pt', kind: 'point', construction: false, at: { x: 3, y: 3 } },
      ],
      constraints: [], dimensions: [], solveStatus: null,
    },
    sketchHistory: [], projectHistory: [], canUndo: false,
    sketchSelectedIds: [],
    sketchTextEditId: null, sketchTextValue: 'TEXT', sketchTextHeight: 5,
    sketchTextRotationDeg: 0, sketchTextStyle: 'single-line',
    sketchTextPathId: null, sketchTextPathOffsetMm: 0, sketchTextPathFlip: false,
    sketchTextPathAlign: 'free',
    sketchPickPathForTextId: null, sketchNotice: null,
  }
}

describe('text tool CLICK-ON-CURVE attach (store flow, spec T1b)', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
    ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
  })
  beforeEach(() => {
    useCamStore.setState(onPathPlacementState() as never)
    sketcherToolStore.setState({ tool: 'text', chain: null, constructionMode: false })
  })
  const ents = () => useCamStore.getState().activeSketch!.entities
  const newText = () =>
    ents().find((e) => e.kind === 'text') as SketchTextEntity | undefined

  it('a click NEAR a curve births the text ON-PATH at the projected offset (never floating)', () => {
    // tol 0.5 -> pick tolerance 1.0 (same as the attach-to-path flow); the
    // click at (5, 0.4) is 0.4mm off the line -> attaches, offset ~5mm.
    sketcherTools.click({ x: 5, y: 0.4 }, 0.5, null, false)
    const e = newText()!
    expect(e.pathId).toBe('ln')
    expect(e.pathFlip).toBe(false)
    expect(e.pathOffsetMm).toBeCloseTo(5, 1)
    // A clicked position along the curve is a FREE position (plan item 4).
    expect(e.pathAlign).toBe('free')
    // Caret ready: the in-canvas editor opened for the new entity.
    const s = useCamStore.getState()
    expect(s.sketchTextEditId).toBe(e.id)
    // The toolbox edit fields mirror the born-on-path state.
    expect(s.sketchTextPathId).toBe('ln')
    expect(s.sketchTextPathOffsetMm).toBeCloseTo(5, 1)
  })

  it('a click FAR from any curve places FREE text (byte-identical to before)', () => {
    sketcherTools.click({ x: 5, y: 10 }, 0.5, null, false)
    const e = newText()!
    expect(e.pathId).toBeUndefined()
    expect(e.pathOffsetMm).toBeUndefined()
    expect(e.at).toEqual({ x: 5, y: 10 })
    expect(useCamStore.getState().sketchTextPathId).toBeNull()
  })

  it('a point entity is not a curve: clicking near it stays FREE', () => {
    sketcherTools.click({ x: 3, y: 3.2 }, 0.5, null, false)
    expect(newText()!.pathId).toBeUndefined()
  })
})

describe('text tool SELECT-CURVE-FIRST (arm attaches immediately, spec T1c)', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
    ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
  })
  beforeEach(() => {
    useCamStore.setState(onPathPlacementState() as never)
    sketcherToolStore.setState({ tool: 'select', chain: null, constructionMode: false })
  })
  const ents = () => useCamStore.getState().activeSketch!.entities
  const newText = () =>
    ents().find((e) => e.kind === 'text') as SketchTextEntity | undefined

  it('arming Text with a curve selected creates the on-path text IMMEDIATELY (no click)', () => {
    useCamStore.getState().setSketchSelection(['ln'])
    sketcherTools.armTool('text')
    const e = newText()!
    expect(e.pathId).toBe('ln')
    expect(e.text).toBe('') // seeded empty; the user types in the workspace
    // CENTER-aligned birth (spec T1c "default anchor: center"): render/bake
    // resolve the start offset from arc length + string advance. pathOffsetMm
    // keeps the mid-curve value (20mm line -> 10mm) ONLY as the numeric
    // fallback a later switch to 'free' starts from.
    expect(e.pathAlign).toBe('center')
    expect(e.pathOffsetMm).toBeCloseTo(10, 6)
    // Anchor rides the curve at mid-curve (the caret lands there).
    expect(e.at.x).toBeCloseTo(10, 6)
    expect(e.at.y).toBeCloseTo(0, 6)
    const s = useCamStore.getState()
    expect(s.sketchTextEditId).toBe(e.id) // caret ready
    expect(s.sketchTextPathId).toBe('ln')
    expect(s.sketchTextPathOffsetMm).toBeCloseTo(10, 6)
    expect(s.sketchTextPathAlign).toBe('center')
    expect(s.sketchHistory.length).toBe(1) // create = the one undo step
  })

  it('typing + Enter keeps the immediately-created text on the curve', () => {
    useCamStore.getState().setSketchSelection(['ln'])
    sketcherTools.armTool('text')
    useCamStore.getState().setSketchTextValue('HI')
    useCamStore.getState().commitSketchTextEdit()
    const e = newText()!
    expect(e.text).toBe('HI')
    expect(e.pathId).toBe('ln')
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
  })

  it('Esc right after arming cancels the untyped placement WITH a notice', () => {
    useCamStore.getState().setSketchSelection(['ln'])
    sketcherTools.armTool('text')
    expect(newText()).toBeDefined()
    sketcherTools.escape()
    expect(newText()).toBeUndefined() // nothing typed -> nothing kept
    expect(useCamStore.getState().sketchHistory.length).toBe(0)
    expect(useCamStore.getState().sketchNotice).toBe('Text canceled - nothing typed')
  })

  it('arming CONSUMES the seed selection; re-arming creates NO second caret', () => {
    useCamStore.getState().setSketchSelection(['ln'])
    sketcherTools.armTool('text')
    const first = newText()!
    expect(first.pathId).toBe('ln')
    // The seed curve is consumed from the selection (standard editor semantics) —
    // leaving it selected made EVERY later arm re-create another empty caret.
    expect(useCamStore.getState().sketchSelectedIds).not.toContain('ln')
    // Finish the open (empty) edit, then arm Text again: nothing sampleable
    // is selected any more, so NO new on-path text appears.
    useCamStore.getState().commitSketchTextEdit() // empty -> discarded
    sketcherTools.armTool('text')
    expect(newText()).toBeUndefined()
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
  })

  it('an untyped select-first placement is discarded WITH a notice by the next canvas click', () => {
    // Repro from the verification drive: select curve -> arm Text (caret
    // opens) -> without typing, click elsewhere to place another text. The
    // empty on-path text must NOT be silently orphaned.
    useCamStore.getState().setSketchSelection(['ln'])
    sketcherTools.armTool('text')
    expect(newText()!.pathId).toBe('ln')
    sketcherTools.click({ x: 5, y: 10 }, 0.5, null, false)
    const texts = ents().filter((e) => e.kind === 'text')
    expect(texts.length).toBe(1) // only the NEW placement — no orphan
    expect((texts[0] as SketchTextEntity).pathId).toBeUndefined()
    expect(useCamStore.getState().sketchNotice).toBe('Empty text discarded')
  })

  it('with nothing sampleable selected, arming creates NOTHING (click still places)', () => {
    // A point is not a sampleable path -> no immediate creation.
    useCamStore.getState().setSketchSelection(['pt'])
    sketcherTools.armTool('text')
    expect(newText()).toBeUndefined()
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
    // A far-from-curve click then places ordinary FREE text.
    sketcherTools.click({ x: 5, y: 10 }, 0.5, null, false)
    const e = newText()!
    expect(e.pathId).toBeUndefined()
    expect(useCamStore.getState().sketchTextPathId).toBeNull()
  })
})

describe('text bake -> OPEN polyline Loop2Ds', () => {
  const layerId = 'L'
  function sketchOf(entities: SketchEntity[]): Sketch {
    return {
      id: 'sk', layerId, entities, constraints: [], dimensions: [],
      solveStatus: { dof: 0, conflicting: [], redundant: [] },
    }
  }

  it("'I' bakes to ONE open loop with a known point on the stroke", () => {
    // height 21 -> scale 1: 'I' is the vertical stroke x=4, y from 0..21.
    const e: SketchTextEntity = {
      id: 't1', kind: 'text', construction: false,
      at: { x: 0, y: 0 }, text: 'I', height: 21, rotation: 0, fontStyle: 'single-line',
    }
    const { loops, bakedEntities } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(bakedEntities).toBe(1)
    expect(loops.length).toBe(1)
    const loop = loops[0]
    expect(loop.closed).toBe(false)
    expect(loop.type).toBe('open')
    expect(loop.segments!.every((s) => s.type === 'line')).toBe(true)
    // Known points: the stroke endpoints (4, 0) and (4, 21).
    const hasBaseline = loop.points.some((p) => close(p.x, 4) && close(p.y, 0))
    const hasCap = loop.points.some((p) => close(p.x, 4) && close(p.y, 21))
    expect(hasBaseline).toBe(true)
    expect(hasCap).toBe(true)
  })

  it("multi-stroke 'A' bakes to several OPEN loops (one per stroke)", () => {
    const e: SketchTextEntity = {
      id: 't2', kind: 'text', construction: false,
      at: { x: 0, y: 0 }, text: 'A', height: 10, rotation: 0, fontStyle: 'single-line',
    }
    const { loops } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(loops.length).toBe(3) // A = 3 strokes
    expect(loops.every((l) => l.closed === false && l.type === 'open')).toBe(true)
  })

  it('construction text never bakes', () => {
    const e: SketchTextEntity = {
      id: 't3', kind: 'text', construction: true,
      at: { x: 0, y: 0 }, text: 'A', height: 10, rotation: 0, fontStyle: 'single-line',
    }
    const { loops } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(loops.length).toBe(0)
  })

  it('degenerate (empty) text is excluded from bake', () => {
    const e: SketchTextEntity = {
      id: 't4', kind: 'text', construction: false,
      at: { x: 0, y: 0 }, text: '   ', height: 10, rotation: 0, fontStyle: 'single-line',
    }
    const { loops, excludedEntities } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(loops.length).toBe(0)
    expect(excludedEntities).toBe(1)
  })
})

describe('text solver mapping (SOLVER-INERT)', () => {
  const text: SketchTextEntity = {
    id: 't1', kind: 'text', construction: false,
    at: { x: 3, y: 5 }, text: 'AB', height: 6, rotation: 0, fontStyle: 'single-line',
  }
  const sketch: Sketch = {
    id: 'sk', layerId: 'L', entities: [text], constraints: [], dimensions: [],
    solveStatus: null,
  }

  it('pushes only the anchor as a gcs point, NO text/line primitive', () => {
    const prims = sketchToGcsPrimitives(sketch)
    const anchor = prims.find((p) => p.id === 't1:start')
    expect(anchor?.type).toBe('point')
    expect(anchor).toMatchObject({ x: 3, y: 5 })
    expect(prims.some((p) => p.id === 't1')).toBe(false) // no shape primitive
  })

  it('rebuild moves the anchor to follow the solved point; text carried verbatim', () => {
    const lookup = (id: string) =>
      id === 't1:start'
        ? ({ id, type: 'point', x: 10, y: 20, fixed: false } as never)
        : undefined
    const [out] = entitiesFromSolved(sketch, lookup) as [SketchTextEntity]
    expect(out.at).toEqual({ x: 10, y: 20 })
    expect(out.text).toBe('AB')
    expect(out.height).toBe(6)
    expect(out.fontStyle).toBe('single-line')
  })
})

// ---- Letter spacing: bake parity + store live-edit/load -------------------
describe('letter spacing: bake parity (single-line)', () => {
  function sketchOf(entities: SketchEntity[]): Sketch {
    return {
      id: 'sk', layerId: 'L', entities, constraints: [], dimensions: [],
      solveStatus: null,
    }
  }
  const bboxOf = (pts: { x: number; y: number }[]) => {
    let minX = Infinity, maxX = -Infinity
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x) }
    return { minX, maxX }
  }
  it('spaced text bakes to loops with the widened advance (render/bake parity)', () => {
    const base: SketchTextEntity = {
      id: 'a', kind: 'text', construction: false, at: { x: 0, y: 0 },
      text: 'ABC', height: 10, rotation: 0, fontStyle: 'single-line',
    }
    const spaced: SketchTextEntity = { ...base, id: 'b', letterSpacingMm: 3 }
    const lb = bakeSketch(sketchOf([base]), { newId: idFactory() }).loops
    const ls = bakeSketch(sketchOf([spaced]), { newId: idFactory() }).loops
    const wb = bboxOf(lb.flatMap((l) => l.points))
    const ws = bboxOf(ls.flatMap((l) => l.points))
    // 3 glyphs -> 2 gaps -> width grows by 2*3 = 6; first glyph unmoved.
    expect((ws.maxX - ws.minX) - (wb.maxX - wb.minX)).toBeCloseTo((3 - 1) * 3, 6)
    expect(ws.minX).toBeCloseTo(wb.minX, 6)
  })
})

describe('letter spacing: store live-edit + load', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
  })
  beforeEach(() => {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [{
          id: 'tx', kind: 'text', construction: false,
          at: { x: 1, y: 2 }, text: 'HI', height: 5, rotation: 0,
          fontStyle: 'single-line', letterSpacingMm: 1.5,
        }],
        constraints: [], dimensions: [], solveStatus: null,
      },
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTextEditId: null, sketchTextLetterSpacing: 0, sketchNotice: null,
    })
  })
  const txt = () =>
    useCamStore.getState().activeSketch!.entities[0] as SketchTextEntity

  it('beginSketchTextEdit loads the entity letterSpacingMm into the toolbox field', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    expect(useCamStore.getState().sketchTextLetterSpacing).toBe(1.5)
  })

  it('setSketchTextLetterSpacing mutates the live entity IN PLACE (same id)', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().setSketchTextLetterSpacing(-0.8)
    const e = txt()
    expect(e.id).toBe('tx')             // edited in place, not delete+redo
    expect(e.letterSpacingMm).toBe(-0.8) // negative (tighten) is valid
    expect(e.at).toEqual({ x: 1, y: 2 }) // anchor untouched -- a proper edit
  })

  it('rejects a non-finite value (no-op)', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().setSketchTextLetterSpacing(Number.NaN)
    expect(useCamStore.getState().sketchTextLetterSpacing).toBe(1.5) // unchanged
  })
})

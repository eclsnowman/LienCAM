// Sketch right-click context menu model — headless coverage.
//
// Three cases (buildSketchContextMenu header):
//   ARMED      tool-aware items (Confirm step / Cancel tool /
//              construction toggle), Confirm enabled iff confirmable
//   SELECTION  ONLY the constraint kinds valid for the selected operand
//              set (same plan as the toolbox buttons), Delete, Toggle
//              construction, launch-with-pre-selection items
//   EMPTY      tool launchers with shortcut hints

import { describe, it, expect } from 'vitest'
import { buildSketchContextMenu } from '../../lib/sketch/contextMenu'
import { createBlankSketch } from '../../lib/sketch/blankSketch'
import { PRESELECTION_TOOLS } from '../../lib/sketch/tools/toolMachine'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

function sketchWith(entities: SketchEntity[]): Sketch {
  const sk = createBlankSketch('layer-1')
  return { ...sk, entities }
}

const TWO_LINES: SketchEntity[] = [
  { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
  { id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 5 }, end: { x: 10, y: 7 } },
]

describe('armed tool case', () => {
  it('offers Confirm step / Cancel tool / construction toggle', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'mirror', chain: null },
      sketch: sketchWith(TWO_LINES),
      selectedIds: [],
      constructionMode: false,
    })
    const ids = items.map((i) => i.id)
    expect(ids).toEqual(['confirm-step', 'cancel-tool', 'toggle-construction'])
    expect(items[0].disabled).toBe(true) // mirror set step is not confirmable
    expect(items[1].label).toBe('Cancel Mirror (Esc)')
    expect(items[2].label).toContain('Construction mode: off')
  })

  it('Confirm step enables on a confirmable step (line chaining)', () => {
    const items = buildSketchContextMenu({
      state: {
        tool: 'line',
        chain: {
          kind: 'line', start: { x: 0, y: 0 }, firstLineId: 'l1',
          prev: { x: 10, y: 0 }, prevLineId: 'l1',
        },
      },
      sketch: sketchWith(TWO_LINES),
      selectedIds: [],
      constructionMode: true,
    })
    expect(items.find((i) => i.id === 'confirm-step')!.disabled).toBe(false)
    expect(items.find((i) => i.id === 'toggle-construction')!.label)
      .toContain('on')
  })
})

describe('selection case', () => {
  it('lists ONLY constraints valid for the selection, plus edits and launchers', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith(TWO_LINES),
      selectedIds: ['l1', 'l2'],
      constructionMode: false,
    })
    const ids = items.map((i) => i.id)
    // Two lines: parallel/perpendicular/equal (etc.) are valid...
    expect(ids).toContain('constraint-parallel')
    expect(ids).toContain('constraint-perpendicular')
    expect(ids).toContain('constraint-equal')
    // ...but kinds the selection cannot take are DROPPED, not greyed.
    expect(ids).not.toContain('constraint-concentric')
    expect(ids).not.toContain('constraint-point_on_object')
    // Edits + launch-with-pre-selection.
    expect(ids).toContain('copy-selection')
    expect(ids).toContain('paste-selection')
    expect(ids).toContain('delete-selection')
    expect(ids).toContain('toggle-construction')
    expect(ids).toContain('launch-mirror')
    expect(ids).toContain('launch-pattern-linear')
    expect(ids).toContain('launch-pattern-circular')
    expect(ids).toContain('launch-fillet')
    expect(items.find((i) => i.id === 'launch-mirror')!.label)
      .toBe('Mirror (M) with selection')
    // Armed-only items never appear here.
    expect(ids).not.toContain('confirm-step')
  })

  it('offers EVERY pre-selection tool as a launch-with-selection item', () => {
    // PRESELECTION_TOOLS is the single source of truth: any tool that
    // consumes a pre-selection when armed must be reachable from the
    // selection right-click (the gate found Offset missing).
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith(TWO_LINES),
      selectedIds: ['l1', 'l2'],
      constructionMode: false,
    })
    const ids = new Set(items.map((i) => i.id))
    for (const tool of PRESELECTION_TOOLS) {
      expect(ids.has(`launch-${tool}`), `missing launch-${tool}`).toBe(true)
    }
    expect(items.find((i) => i.id === 'launch-offset')!.label)
      .toBe('Offset (O) with selection')
  })

  it('a selection of non-entities (no sketch entities) falls back to launchers', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith(TWO_LINES),
      selectedIds: ['some-constraint-id'],
      constructionMode: false,
    })
    expect(items.some((i) => i.id === 'launch-line')).toBe(true)
    expect(items.some((i) => i.id === 'delete-selection')).toBe(false)
  })
})

describe('empty case', () => {
  it('offers tool launchers with shortcut hints', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith([]),
      selectedIds: [],
      constructionMode: false,
    })
    const byId = new Map(items.map((i) => [i.id, i]))
    expect(byId.get('launch-line')!.label).toBe('Line (L)')
    expect(byId.get('launch-trim')!.label).toBe('Trim (T)')
    expect(byId.get('launch-trim')!.separatorBefore).toBe(true) // MODIFY group
    expect(byId.get('launch-project')!.label).toBe('Project / Use')
    expect(byId.get('launch-project')!.action).toEqual({ kind: 'arm-tool', tool: 'project' })
    expect(items.filter((item) => item.id === 'launch-project')).toHaveLength(1)
    expect(byId.has('launch-mirror')).toBe(true)
    expect(byId.get('paste-selection')?.label).toBe('Paste (Ctrl+V)')
    // No selection-only or armed-only items.
    expect(byId.has('delete-selection')).toBe(false)
    expect(byId.has('confirm-step')).toBe(false)
  })

  it('works without an active sketch (null)', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: null,
      selectedIds: [],
      constructionMode: false,
    })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.action.kind === 'arm-tool')).toBe(true)
  })
})

describe('SKC-BLOCKS group/explode menu items', () => {
  const BLOCK: SketchEntity = {
    id: 'b1', kind: 'block', construction: false,
    origin: { x: 5, y: 5 }, rotation: 0, scale: 1,
    members: { entities: [], constraints: [], dimensions: [] },
  }

  it('offers "Group into block" for a selection of ordinary entities', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith(TWO_LINES),
      selectedIds: ['l1', 'l2'],
      constructionMode: false,
    })
    const ids = items.map((i) => i.id)
    expect(ids).toContain('group-block')
    expect(ids).not.toContain('explode-block')
    expect(items.find((i) => i.id === 'group-block')!.action).toEqual({ kind: 'group-block' })
  })

  it('offers "Explode block" for a single selected block (and NOT group)', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith([BLOCK]),
      selectedIds: ['b1'],
      constructionMode: false,
    })
    const ids = items.map((i) => i.id)
    expect(ids).toContain('explode-block')
    expect(ids).not.toContain('group-block')
    expect(items.find((i) => i.id === 'explode-block')!.action).toEqual({ kind: 'explode-block' })
  })

  it('offers "Place another instance" for a single selected block (SKC-BLOCKS Stage 5)', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith([BLOCK]),
      selectedIds: ['b1'],
      constructionMode: false,
    })
    const ids = items.map((i) => i.id)
    expect(ids).toContain('insert-instance')
    expect(items.find((i) => i.id === 'insert-instance')!.action).toEqual({ kind: 'insert-instance' })
  })

  it('offers NEITHER for a mixed selection containing a block', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith([...TWO_LINES, BLOCK]),
      selectedIds: ['l1', 'b1'],
      constructionMode: false,
    })
    const ids = items.map((i) => i.id)
    expect(ids).not.toContain('group-block')
    expect(ids).not.toContain('explode-block')
  })

  it('offers "Edit block" beside "Explode block" for a single selected block', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith([BLOCK]),
      selectedIds: ['b1'],
      constructionMode: false,
    })
    const ids = items.map((i) => i.id)
    expect(ids).toContain('explode-block')
    expect(ids).toContain('edit-block')
    expect(items.find((i) => i.id === 'edit-block')!.action).toEqual({ kind: 'edit-block' })
  })
})

describe('SKC-BLOCKS Stage 4: block-edit-active menu', () => {
  const BLOCK: SketchEntity = {
    id: 'b1', kind: 'block', construction: false,
    origin: { x: 5, y: 5 }, rotation: 0, scale: 1,
    members: { entities: [], constraints: [], dimensions: [] },
  }

  it('leads with Finish/Cancel and suppresses group/explode/edit-block', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith([BLOCK]),
      selectedIds: ['b1'],
      constructionMode: false,
      blockEditActive: true,
    })
    const ids = items.map((i) => i.id)
    expect(ids[0]).toBe('finish-block-edit')
    expect(ids[1]).toBe('cancel-block-edit')
    expect(items.find((i) => i.id === 'finish-block-edit')!.action).toEqual({ kind: 'finish-block-edit' })
    expect(items.find((i) => i.id === 'cancel-block-edit')!.action).toEqual({ kind: 'cancel-block-edit' })
    expect(ids).not.toContain('group-block')
    expect(ids).not.toContain('explode-block')
    expect(ids).not.toContain('edit-block')
  })

  it('still offers the rest of the selection menu underneath (Delete etc.)', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith(TWO_LINES),
      selectedIds: ['l1', 'l2'],
      constructionMode: false,
      blockEditActive: true,
    })
    const ids = items.map((i) => i.id)
    expect(ids[0]).toBe('finish-block-edit')
    expect(ids[1]).toBe('cancel-block-edit')
    expect(ids).toContain('delete-selection')
    expect(ids).not.toContain('group-block')
  })

  it('leads with Finish/Cancel on the EMPTY-selection menu too', () => {
    const items = buildSketchContextMenu({
      state: { tool: 'select', chain: null },
      sketch: sketchWith([]),
      selectedIds: [],
      constructionMode: false,
      blockEditActive: true,
    })
    const ids = items.map((i) => i.id)
    expect(ids[0]).toBe('finish-block-edit')
    expect(ids[1]).toBe('cancel-block-edit')
    expect(ids).toContain('launch-line') // the base empty-menu items still follow
  })
})

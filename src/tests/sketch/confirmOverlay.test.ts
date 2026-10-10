// Confirm-overlay view model (interaction framework rework).
//
// The overlay is derived from the SAME ToolState the machine owns: up
// exactly when a staged flow awaits confirmation, fields mirror the
// live store values, and the info line counts fits/misfits honestly.

import { describe, it, expect } from 'vitest'
import {
  confirmOverlayModel, confirmOverlayActive, confirmOverlayAnchor,
} from '../../lib/sketch/confirmOverlay'
import { filletSeedFromSelection } from '../../lib/sketch/tools/filletTool'
import { offsetSeedFromSelection } from '../../lib/sketch/tools/offsetTool'
import { escapeTool, type ToolState } from '../../lib/sketch/tools/toolMachine'
import type { SketchEntity } from '../../lib/sketch/types'

const LINES: SketchEntity[] = [
  { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
  { id: 'l2', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
]

function filletState(): ToolState {
  return {
    tool: 'fillet',
    chain: {
      kind: 'fillet',
      corners: filletSeedFromSelection(LINES, ['l1', 'l2']),
      pendingLineId: null,
      pendingClick: null,
    },
  }
}

describe('confirmOverlayModel', () => {
  it('no chain / no staged work: no overlay', () => {
    expect(confirmOverlayModel(
      { tool: 'select', chain: null }, { entities: LINES },
    )).toBeNull()
    expect(confirmOverlayModel(
      { tool: 'fillet', chain: { kind: 'fillet', corners: [], pendingLineId: 'l1', pendingClick: { x: 5, y: 0 } } },
      { entities: LINES },
    )).toBeNull()
  })

  it('fillet with staged corners: radius field + honest fit info', () => {
    const m = confirmOverlayModel(filletState(), { entities: LINES, filletRadius: 2 })!
    expect(m.tool).toBe('fillet')
    expect(m.fields).toHaveLength(1)
    expect(m.fields[0]).toMatchObject({ id: 'fillet-radius', value: 2, unit: 'mm' })
    expect(m.info).toBe('1 corner staged')
    expect(m.applyLabel).toBe('Apply')
    // The next-key hint spells out the apply key so the user is never stuck
    // wondering how to commit the staged corners.
    expect(m.hint).toBe('Enter to apply the fillet - Esc to cancel')
    expect(confirmOverlayActive(filletState(), { entities: LINES, filletRadius: 2 })).toBe(true)
  })

  it('a radius that does not fit is named in the info line', () => {
    const m = confirmOverlayModel(filletState(), { entities: LINES, filletRadius: 50 })!
    expect(m.info).toContain('does not fit')
    expect(m.info).toContain('skipped on Apply')
  })

  it('anchor = centroid of the staged corners', () => {
    expect(confirmOverlayAnchor(filletState())).toEqual({ x: 10, y: 0 })
    expect(confirmOverlayAnchor({ tool: 'select', chain: null })).toBeNull()
  })
})

describe('confirmOverlayModel - offset', () => {
  function offsetState(locked: 1 | -1 | null): ToolState {
    const source = offsetSeedFromSelection(LINES, [], ['l1'])!
    return { tool: 'offset', chain: { kind: 'offset', source, lockedSide: locked } }
  }

  it('side not locked yet: no overlay; locked: distance field + OK', () => {
    expect(confirmOverlayModel(offsetState(null), { entities: LINES })).toBeNull()
    const m = confirmOverlayModel(offsetState(1), { entities: LINES, offsetDistance: 3 })!
    expect(m.tool).toBe('offset')
    expect(m.fields[0]).toMatchObject({ id: 'offset-distance', value: 3, unit: 'mm' })
    expect(m.applyLabel).toBe('OK')
  })

  it('an impossible distance is explained in the info line', () => {
    // Shrinking a circle past its radius cannot apply.
    const circle: SketchEntity = {
      id: 'c', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 2,
    }
    const src = offsetSeedFromSelection([circle], [], ['c'])!
    const m = confirmOverlayModel(
      { tool: 'offset', chain: { kind: 'offset', source: src, lockedSide: 1 } },
      { entities: [circle], offsetDistance: 5 },
    )!
    expect(m.info).toMatch(/collapses/)
  })

  it('Esc steps BACK one step: locked side unlocks, source survives', () => {
    const r = escapeTool(offsetState(-1))
    expect(r.consumed).toBe(true)
    expect(r.state.tool).toBe('offset')
    expect(r.state.chain?.kind).toBe('offset')
    if (r.state.chain?.kind !== 'offset') return
    expect(r.state.chain.lockedSide).toBeNull()
    // Second Esc drops the chain; third disarms.
    const r2 = escapeTool(r.state)
    expect(r2.state.chain).toBeNull()
    expect(r2.state.tool).toBe('offset')
    const r3 = escapeTool(r2.state)
    expect(r3.state.tool).toBe('select')
  })
})

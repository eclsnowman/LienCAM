import { describe, it, expect } from 'vitest'
import {
  STOCK_CUTTING_BY_ROLE,
  isStockCuttingRole,
  effectiveMoveRole,
} from '../../lib/cam/stockCuttingRoles'
import type { MoveRole } from '../../types'

// Every role in the union, kept in sync manually so this test itself flags a
// new/removed role (the Record<MoveRole,boolean> in the module is the
// compile-time exhaustiveness guard; this is the runtime companion).
const ALL_ROLES: MoveRole[] = [
  'rapid', 'cut', 'helix', 'ramp', 'plunge', 'stepover', 'fast_traverse',
  'lead_in', 'lead_out', 'loop_back', 'wall_follow', 'finish', 'retract',
]

// Ported from the Codex-branch policy: stepover and finish DO remove stock.
const CUTTING: MoveRole[] = ['cut', 'helix', 'ramp', 'plunge', 'stepover', 'wall_follow', 'lead_in', 'lead_out', 'finish']
const NON_CUTTING: MoveRole[] = ['rapid', 'fast_traverse', 'loop_back', 'retract']

describe('isStockCuttingRole — the one shared carve authority', () => {
  it('exports the exact exhaustive stock-cutting policy', () => {
    expect(STOCK_CUTTING_BY_ROLE).toEqual({
      cut: true,
      helix: true,
      ramp: true,
      plunge: true,
      stepover: true,
      wall_follow: true,
      lead_in: true,
      lead_out: true,
      finish: true,
      rapid: false,
      fast_traverse: false,
      loop_back: false,
      retract: false,
    })
  })

  it('classifies every MoveRole (no role left unhandled)', () => {
    for (const r of ALL_ROLES) {
      expect(() => isStockCuttingRole(r)).not.toThrow()
    }
  })

  it('cutting roles remove stock', () => {
    for (const r of CUTTING) expect(isStockCuttingRole(r)).toBe(true)
  })

  it('non-cutting roles do NOT remove stock', () => {
    for (const r of NON_CUTTING) expect(isStockCuttingRole(r)).toBe(false)
  })

  it('CUTTING + NON_CUTTING partition covers the whole union exactly once', () => {
    expect([...CUTTING, ...NON_CUTTING].sort()).toEqual([...ALL_ROLES].sort())
  })

  it('FAILS LOUD on an unknown role string (never silently non-cutting)', () => {
    expect(() => isStockCuttingRole('bogus_role')).toThrow(/unknown move role/)
    expect(() => isStockCuttingRole('')).toThrow(/unknown move role/)
  })
})

describe('effectiveMoveRole — default resolution shared by pre-carve and live', () => {
  it('honors an explicit role', () => {
    expect(effectiveMoveRole({ type: 'feed', role: 'fast_traverse' })).toBe('fast_traverse')
    expect(effectiveMoveRole({ type: 'rapid', role: 'lead_in' })).toBe('lead_in')
  })
  it('defaults an untyped rapid to rapid, any other untyped move to cut', () => {
    expect(effectiveMoveRole({ type: 'rapid' })).toBe('rapid')
    expect(effectiveMoveRole({ type: 'feed' })).toBe('cut')
    expect(effectiveMoveRole({ type: 'arc_cw' })).toBe('cut')
  })
})

// ---------------------------------------------------------------------------
// Consolidation proof: pre-carve and live-carve now decide via the SAME
// function of the SAME move. Live playback carves on isStockCuttingRole(fr.role)
// where fr.role === effectiveMoveRole(m); pre-carve now carves on
// isStockCuttingRole(effectiveMoveRole(m)). So the two gates are identical, and
// they DIVERGE from the old pre-carve gate (type !== 'rapid') for feed-typed
// link moves — which is exactly the bug this fix closes.
// ---------------------------------------------------------------------------
type RawMove = { type: string; role?: string }

// The gate live-playback uses (fr.role is the effective role from buildFrames).
const liveGate = (m: RawMove) => isStockCuttingRole(effectiveMoveRole(m))
// The NEW pre-carve gate (post-fix).
const newPreCarveGate = (m: RawMove) => isStockCuttingRole(effectiveMoveRole(m))
// The OLD pre-carve gate (pre-fix) — carved everything that was not a rapid TYPE.
const oldPreCarveGate = (m: RawMove) => m.type !== 'rapid'

describe('pre-carve now agrees with live-carve', () => {
  const sample: RawMove[] = [
    { type: 'feed', role: 'cut' },
    { type: 'feed', role: 'wall_follow' },
    { type: 'feed', role: 'lead_in' },
    { type: 'feed', role: 'lead_out' },
    { type: 'feed', role: 'fast_traverse' },
    { type: 'feed', role: 'stepover' },
    { type: 'feed', role: 'loop_back' },
    { type: 'feed', role: 'finish' },
    { type: 'rapid', role: 'rapid' },
    { type: 'feed' }, // untyped -> cut
    { type: 'rapid' }, // untyped -> rapid
  ]

  it('new pre-carve gate matches the live gate for every sampled move', () => {
    for (const m of sample) {
      expect(newPreCarveGate(m)).toBe(liveGate(m))
    }
  })

  it('non-cutting LINK moves that live-carve skips are no longer carved in pre-carve (regression)', () => {
    for (const role of ['fast_traverse', 'loop_back']) {
      const m: RawMove = { type: 'feed', role }
      // Old gate WRONGLY carved these (type !== rapid); the new gate does not.
      expect(oldPreCarveGate(m)).toBe(true)
      expect(newPreCarveGate(m)).toBe(false)
      expect(liveGate(m)).toBe(false)
    }
  })

  it('cutting feed moves — INCLUDING finish and stepover — carve in BOTH lanes', () => {
    for (const role of ['cut', 'wall_follow', 'lead_in', 'finish', 'stepover']) {
      const m: RawMove = { type: 'feed', role }
      expect(newPreCarveGate(m)).toBe(true)
      expect(liveGate(m)).toBe(true)
    }
  })
})

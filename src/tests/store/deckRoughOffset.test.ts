// Unit coverage for deckRoughOffset (src/store/dispatchGeo.ts): the pure
// "clear to the deck" depth arithmetic behind the smart stock-rough planeOffset.
//
// The deck is the lowest boss BASE in world Z (min boss bottomZ + the part's
// geometry-local-to-world Z offset). The returned planeOffset is
// deckWorldZ - stockTopWorldZ -- NEGATIVE for a normal part whose deck sits
// below the stock top, so resolveStockBottomPlane pins the cut bottom at the
// deck. No bosses => null (caller keeps its fixed fallback depth). A deck at or
// above the stock top returns a non-negative number by contract -- the caller
// (modal) only applies a negative result, so this naturally keeps the fallback.

import { describe, it, expect } from 'vitest'
import { deckRoughOffset } from '../../store/dispatchGeo'

describe('deckRoughOffset (clear-to-deck planeOffset)', () => {
  it('single boss: deck 22, stockTop 48 -> -26', () => {
    const cyls = [{ kind: 'boss', bottomZ: 22 }]
    expect(deckRoughOffset(cyls, 0, 48)).toBe(-26)
  })

  it('multiple bosses use the LOWEST base (22) -> -26', () => {
    const cyls = [
      { kind: 'boss', bottomZ: 22 },
      { kind: 'boss', bottomZ: 30 },
      { kind: 'boss', bottomZ: 25 },
    ]
    expect(deckRoughOffset(cyls, 0, 48)).toBe(-26)
  })

  it('non-zero part position.z folds into the world deck: local 20 + posZ 2 = 22 -> -26', () => {
    const cyls = [{ kind: 'boss', bottomZ: 20 }]
    expect(deckRoughOffset(cyls, 2, 48)).toBe(-26)
  })

  it('bores only (no boss) -> null (keep fallback)', () => {
    const cyls = [
      { kind: 'bore', bottomZ: 5 },
      { kind: 'bore', bottomZ: 10 },
    ]
    expect(deckRoughOffset(cyls, 0, 48)).toBeNull()
  })

  it('empty cylinder list -> null', () => {
    expect(deckRoughOffset([], 0, 48)).toBeNull()
  })

  it('ignores bores when picking the boss deck (lowest boss is 22, not the bore 5)', () => {
    const cyls = [
      { kind: 'bore', bottomZ: 5 },
      { kind: 'boss', bottomZ: 22 },
    ]
    expect(deckRoughOffset(cyls, 0, 48)).toBe(-26)
  })

  it('degenerate deck >= stockTop returns a NON-NEGATIVE result (caller must not apply it)', () => {
    // deck 50, stockTop 48 -> +2. The modal only sets planeOffset when off < 0,
    // so this positive result is intentionally NOT applied (fallback kept).
    const cyls = [{ kind: 'boss', bottomZ: 50 }]
    expect(deckRoughOffset(cyls, 0, 48)).toBe(2)
  })
})

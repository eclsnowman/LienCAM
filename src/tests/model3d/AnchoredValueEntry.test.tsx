// @vitest-environment jsdom
//
// WO UI-57 audit F2, verbatim finding: "the anchored card is not
// viewport-clamped and visibly overlaps the Design Tree". The card centered a
// >=176px-wide box on the RAW projected point with no clamping, so an anchor
// near any viewport edge hung the card off-screen (or over a docked panel).
//
// Two layers are tested:
//   - placeAnchoredCard, the pure placement function -- one test per viewport
//     edge plus the docked-panel case, asserting the resolved box is wholly
//     inside the bounds. These are the real gate: exact numbers, no DOM.
//   - the mounted component, proving the rAF loop actually feeds that function
//     the measured card size and the measured container, i.e. that the clamp
//     is WIRED and not just present. jsdom reports 0x0 for every element, so
//     getBoundingClientRect is mocked on both the container and the card --
//     the same technique PushPullGizmo.test.tsx uses for its own canvas rect.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import {
  AnchoredValueEntry,
  placeAnchoredCard,
  type AnchoredValueEntryRect,
} from '../../components/model3d/workbench/AnchoredValueEntry'

afterEach(cleanup)

/** The reference viewport for this component's real caller: the workbench
 *  canvas container (SolidsWorkbenchPage.tsx:6464, `flex:1; position:relative`). */
const VIEWPORT: AnchoredValueEntryRect = { left: 0, top: 0, right: 800, bottom: 600 }
const CARD = { width: 176, height: 140 }

function inside(box: { left: number; top: number }, size: { width: number; height: number }, bounds: AnchoredValueEntryRect): boolean {
  return (
    box.left >= bounds.left &&
    box.top >= bounds.top &&
    box.left + size.width <= bounds.right &&
    box.top + size.height <= bounds.bottom
  )
}

describe('placeAnchoredCard (WO UI-57 audit F2: viewport clamp)', () => {
  it('centers the card above the anchor when there is room -- the unclamped case is unchanged', () => {
    const p = placeAnchoredCard({ x: 400, y: 300 }, CARD, VIEWPORT)
    expect(p.left).toBe(400 - CARD.width / 2) // centered horizontally on the anchor
    expect(p.top).toBe(300 - 12 - CARD.height) // lifted clear of the feature it describes
    expect(inside(p, CARD, VIEWPORT)).toBe(true)
  })

  it('LEFT edge: an anchor at x=4 does not push the card off the left of the viewport', () => {
    const p = placeAnchoredCard({ x: 4, y: 300 }, CARD, VIEWPORT)
    expect(p.left).toBe(8) // EDGE_MARGIN, not 4 - 88 = -84
    expect(inside(p, CARD, VIEWPORT)).toBe(true)
  })

  it('RIGHT edge: an anchor at x=796 does not push the card off the right of the viewport', () => {
    const p = placeAnchoredCard({ x: 796, y: 300 }, CARD, VIEWPORT)
    expect(p.left).toBe(800 - 8 - CARD.width) // flush against the right margin
    expect(inside(p, CARD, VIEWPORT)).toBe(true)
  })

  it('TOP edge: an anchor near the top flips the card BELOW it rather than clipping it', () => {
    const p = placeAnchoredCard({ x: 400, y: 10 }, CARD, VIEWPORT)
    expect(p.top).toBe(10 + 12) // under the anchor, not 10 - 12 - 140 = -142
    expect(inside(p, CARD, VIEWPORT)).toBe(true)
  })

  it('BOTTOM edge: an anchor near the bottom keeps the card above it and inside the viewport', () => {
    const p = placeAnchoredCard({ x: 400, y: 596 }, CARD, VIEWPORT)
    expect(p.top).toBe(596 - 12 - CARD.height) // still fits above -- preferred placement holds
    expect(inside(p, CARD, VIEWPORT)).toBe(true)
  })

  it('CORNER: an anchor at the bottom-right is clamped on BOTH axes at once', () => {
    const p = placeAnchoredCard({ x: 799, y: 599 }, CARD, VIEWPORT)
    expect(inside(p, CARD, VIEWPORT)).toBe(true)
    expect(p.left).toBe(800 - 8 - CARD.width)
  })

  it('off-viewport anchor (a stale/extreme projection) is still pulled fully inside', () => {
    for (const anchor of [{ x: -500, y: -500 }, { x: 5000, y: 5000 }, { x: -500, y: 5000 }, { x: 5000, y: -500 }]) {
      const p = placeAnchoredCard(anchor, CARD, VIEWPORT)
      expect(inside(p, CARD, VIEWPORT)).toBe(true)
    }
  })

  it('a viewport narrower than the card pins to the near edge instead of producing an inverted range', () => {
    const tiny: AnchoredValueEntryRect = { left: 0, top: 0, right: 100, bottom: 80 }
    const p = placeAnchoredCard({ x: 50, y: 40 }, CARD, tiny)
    expect(p.left).toBe(8)
    expect(p.top).toBe(8)
    expect(Number.isFinite(p.left) && Number.isFinite(p.top)).toBe(true)
  })

  describe('docked panels (avoidRects)', () => {
    // A left-docked Design Tree, expressed in the same container-relative space.
    const designTree: AnchoredValueEntryRect = { left: 0, top: 0, right: 260, bottom: 600 }

    it('an anchor over a left-docked Design Tree slides the card clear of it, still inside the viewport', () => {
      const p = placeAnchoredCard({ x: 120, y: 300 }, CARD, VIEWPORT, [designTree])
      expect(p.left).toBe(260 + 8) // clear of the dock's right edge
      expect(inside(p, CARD, VIEWPORT)).toBe(true)
      expect(p.left).toBeGreaterThanOrEqual(designTree.right) // the audit's exact defect: no overlap
    })

    it('an anchor that only CLIPS the dock is still moved fully off it', () => {
      // Centered at x=300 the card spans 212..388 -- its left edge overlaps the dock.
      const p = placeAnchoredCard({ x: 300, y: 300 }, CARD, VIEWPORT, [designTree])
      expect(p.left).toBeGreaterThanOrEqual(designTree.right)
      expect(inside(p, CARD, VIEWPORT)).toBe(true)
    })

    it('an anchor far from the dock is NOT disturbed (avoidance only fires on real overlap)', () => {
      const p = placeAnchoredCard({ x: 600, y: 300 }, CARD, VIEWPORT, [designTree])
      expect(p.left).toBe(600 - CARD.width / 2)
    })

    it('a RIGHT-docked panel pushes the card to its left', () => {
      const rightDock: AnchoredValueEntryRect = { left: 620, top: 0, right: 800, bottom: 600 }
      const p = placeAnchoredCard({ x: 700, y: 300 }, CARD, VIEWPORT, [rightDock])
      expect(p.left + CARD.width).toBeLessThanOrEqual(rightDock.left)
      expect(inside(p, CARD, VIEWPORT)).toBe(true)
    })

    it('both docks at once: the card lands in the gap between them', () => {
      const rightDock: AnchoredValueEntryRect = { left: 620, top: 0, right: 800, bottom: 600 }
      const p = placeAnchoredCard({ x: 60, y: 300 }, CARD, VIEWPORT, [designTree, rightDock])
      expect(p.left).toBeGreaterThanOrEqual(designTree.right)
      expect(p.left + CARD.width).toBeLessThanOrEqual(rightDock.left)
    })
  })
})

describe('AnchoredValueEntry (mounted: the clamp is actually wired to the rAF loop)', () => {
  /** Deliberately NOT equal to the component's own pre-measurement fallback
   *  (176x140): every mounted assertion below is computed from THESE numbers,
   *  so a component that ignored the measured card and clamped against the
   *  fallback would go RED. */
  const MEASURED = { width: 200, height: 160 }

  function mockRect(el: HTMLElement, width: number, height: number): void {
    el.getBoundingClientRect = () => ({
      left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}),
    })
  }

  /** Advance the component's own rAF loop one frame (vitest's fake timers fake
   *  requestAnimationFrame too). */
  function frame(): void {
    act(() => { vi.advanceTimersByTime(20) })
  }

  /** Mount the entry inside a measured 800x600 container. jsdom reports 0x0 for
   *  every element, so both the container and the card are given real rects --
   *  and the card can only be grabbed AFTER the first frame, since the
   *  component renders nothing until its first projection resolves. */
  function mountAt(
    anchor: { x: number; y: number },
    extra?: { avoidRects?: AnchoredValueEntryRect[]; bounds?: AnchoredValueEntryRect },
  ) {
    const container = document.createElement('div')
    mockRect(container, 800, 600)
    document.body.appendChild(container)
    const utils = render(
      <AnchoredValueEntry
        testId="entry"
        anchorWorldPoint={{ x: 0, y: 0, z: 0 }}
        projectToCanvas={() => anchor}
        title="Push/Pull"
        currentValueLabel="Convention"
        currentValueText="+ pulls, - pushes"
        deltaLabel="Offset"
        initialDraft="0"
        validate={() => ({ ok: true, deltaText: '+0 mm' })}
        onApply={async () => undefined}
        onCancel={() => {}}
        avoidRects={extra?.avoidRects}
        bounds={extra?.bounds}
      />,
      { container },
    )
    frame() // first projection -> the card mounts (placed off the fallback size)
    const card = utils.getByTestId('entry') as HTMLElement
    mockRect(card, MEASURED.width, MEASURED.height)
    frame() // now measurable -> the loop re-places it off the REAL size
    return { ...utils, card }
  }

  it('UI-57-R1 cohesion: every design token the card names is REAL (an undefined var() silently resolves to nothing -- the card shipped with NO background)', async () => {
    vi.useFakeTimers()
    let card: HTMLElement
    try {
      card = mountAt({ x: 400, y: 300 }).card
    } finally {
      vi.useRealTimers()
    }
    // The card's background was `var(--surface-panel)`, a token defined NOWHERE
    // in src/theme/tokens.css (this component was its only user in the repo), so
    // the 3D body rendered straight through it. jsdom does not resolve custom
    // properties, so assert against the real token file instead: every token the
    // card names must actually be declared there.
    const tokens = await import('node:fs').then((fs) => fs.readFileSync('src/theme/tokens.css', 'utf8'))
    const named = [...card.getAttribute('style')!.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1])
    expect(named.length, 'the card should reference design tokens, not raw values').toBeGreaterThan(0)
    const undefinedTokens = [...new Set(named)].filter((t) => !tokens.includes(`${t}:`))
    expect(undefinedTokens, `these tokens are used by the card but declared nowhere in tokens.css`).toEqual([])
  })

  it('UI-57-R1 cohesion: the card suppresses text selection (a drag must not smear a selection over its labels) but its INPUT stays selectable', () => {
    vi.useFakeTimers()
    try {
      const { card, getByTestId } = mountAt({ x: 400, y: 300 })
      // The gizmo drag starts on the canvas and sweeps across this card; with
      // userSelect:auto the browser paints the card's labels as selected text
      // mid-drag (seen in the R0 evidence capture).
      expect(card.style.userSelect).toBe('none')
      // ...but the user must still be able to select the value they typed.
      expect((getByTestId('entry-input') as HTMLElement).style.userSelect).toBe('text')
    } finally {
      vi.useRealTimers()
    }
  })

  it('RIGHT edge: clamps the card inside the measured container instead of hanging it off the viewport', () => {
    vi.useFakeTimers()
    try {
      const { card } = mountAt({ x: 790, y: 300 })
      // Unclamped this was 790 - 100 = 690, i.e. 90px of card outside an 800px viewport.
      expect(card.style.left).toBe(`${800 - 8 - MEASURED.width}px`)
      expect(parseFloat(card.style.left) + MEASURED.width).toBeLessThanOrEqual(800)
    } finally {
      vi.useRealTimers()
    }
  })

  it('LEFT edge: clamps the card to the left margin', () => {
    vi.useFakeTimers()
    try {
      const { card } = mountAt({ x: 6, y: 300 })
      expect(card.style.left).toBe('8px') // unclamped: 6 - 100 = -94
    } finally {
      vi.useRealTimers()
    }
  })

  it('TOP edge: flips the card below the anchor rather than clipping it off the top', () => {
    vi.useFakeTimers()
    try {
      const { card } = mountAt({ x: 400, y: 5 })
      expect(card.style.top).toBe('17px') // 5 + ANCHOR_GAP; unclamped: 5 - 12 - 160 = -167
    } finally {
      vi.useRealTimers()
    }
  })

  it('BOTTOM edge: keeps the card above the anchor and inside the viewport', () => {
    vi.useFakeTimers()
    try {
      const { card } = mountAt({ x: 400, y: 596 })
      expect(card.style.top).toBe(`${596 - 12 - MEASURED.height}px`)
      expect(parseFloat(card.style.top) + MEASURED.height).toBeLessThanOrEqual(600)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the card off a caller-declared docked panel (the Design Tree overlap the audit saw)', () => {
    vi.useFakeTimers()
    try {
      const { card } = mountAt({ x: 100, y: 300 }, { avoidRects: [{ left: 0, top: 0, right: 260, bottom: 600 }] })
      expect(parseFloat(card.style.left)).toBeGreaterThanOrEqual(260)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an explicit bounds prop overrides the measured container (the caller-owns-the-region seam)', () => {
    vi.useFakeTimers()
    try {
      // A region narrower than the container -- e.g. the canvas inset from a dock.
      const { card } = mountAt({ x: 390, y: 300 }, { bounds: { left: 0, top: 0, right: 400, bottom: 600 } })
      expect(card.style.left).toBe(`${400 - 8 - MEASURED.width}px`) // the prop's edge, not the container's 800
    } finally {
      vi.useRealTimers()
    }
  })

  it('no longer relies on a translate(-50%,-100%) transform (which would move the clamped edges back out)', () => {
    vi.useFakeTimers()
    try {
      const { card } = mountAt({ x: 790, y: 300 })
      expect(card.style.transform).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the shared first-click type-over and double-click caret contract', () => {
    vi.useFakeTimers()
    try {
      const { getByTestId } = mountAt({ x: 400, y: 300 })
      const input = getByTestId('entry-input') as HTMLInputElement

      expect(document.activeElement).toBe(input)
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe(input.value.length)

      // A real first click mouse-up collapses the programmatic selection; the
      // browser then fires click. WO-406: under src/components/model3d the one
      // sketch draw machine owns down/up, so this input re-selects on the CLICK
      // that follows (onClick is the one mouse verb the SKC-15C gate allows) -
      // the same one-shot contract, one event later, identical to the user.
      input.setSelectionRange(input.value.length, input.value.length)
      fireEvent.mouseUp(input, { detail: 1 })
      fireEvent.click(input, { detail: 1 })
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe(input.value.length)

      // Model the browser's replacement edit from its actual selection range.
      // Without the click-path reselect this produces the reported "08".
      const start = input.selectionStart ?? input.value.length
      const end = input.selectionEnd ?? start
      fireEvent.change(input, {
        target: { value: `${input.value.slice(0, start)}8${input.value.slice(end)}` },
      })
      expect(input.value).toBe('8')

      // Once the first-click arm is consumed, both clicks in a double-click
      // leave the browser's caret where it placed it.
      input.setSelectionRange(1, 1)
      fireEvent.mouseUp(input, { detail: 1 })
      fireEvent.click(input, { detail: 1 })
      expect(input.selectionStart).toBe(1)
      expect(input.selectionEnd).toBe(1)
      fireEvent.mouseUp(input, { detail: 2 })
      fireEvent.click(input, { detail: 2 })
      fireEvent.doubleClick(input, { detail: 2 })
      expect(input.selectionStart).toBe(1)
      expect(input.selectionEnd).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('WO-1490/BUG-382: the current-value and delta rows reserve a minimum gap, so a card shrink-wrapped to the row content never renders label and value flush', () => {
    vi.useFakeTimers()
    try {
      // The audit's exact case: Push/Pull's "Convention" label against its
      // "+ pulls, - pushes" value. The card has no fixed/max width -- it
      // shrink-wraps its content, so `space-between` has NO slack to distribute
      // once the row is as wide as the card and the two spans render adjoining.
      // jsdom does not lay out, so the browser-resolved flex `gap` (the
      // separation actually applied BETWEEN the row's two spans) is the
      // measured value here -- permitted by this WO's own acceptance.
      const MIN_LABEL_GAP = 12
      const { getByTestId } = mountAt({ x: 400, y: 300 })

      const current = getByTestId('entry-current')
      expect(current.textContent).toBe('Convention+ pulls, - pushes')

      for (const rowTestId of ['entry-current', 'entry-delta']) {
        const row = getByTestId(rowTestId)
        // The row is exactly two flex items: label first, value second.
        const spans = row.querySelectorAll(':scope > span')
        expect(spans.length).toBe(2)
        const style = window.getComputedStyle(row)
        // space-between still distributes any real slack...
        expect(style.justifyContent).toBe('space-between')
        // ...and the explicit gap guarantees a floor when there is none.
        const gap = parseFloat(style.gap)
        expect(Number.isFinite(gap)).toBe(true)
        expect(gap).toBeGreaterThanOrEqual(MIN_LABEL_GAP)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders nothing while the anchor does not project (behind the camera) -- unchanged contract', () => {
    vi.useFakeTimers()
    try {
      const container = document.createElement('div')
      mockRect(container, 800, 600)
      document.body.appendChild(container)
      const { queryByTestId } = render(
        <AnchoredValueEntry
          testId="entry"
          anchorWorldPoint={{ x: 0, y: 0, z: 0 }}
          projectToCanvas={() => null}
          title="Push/Pull"
          currentValueLabel="Convention"
          currentValueText="+ pulls, - pushes"
          deltaLabel="Offset"
          initialDraft="0"
          validate={() => ({ ok: true, deltaText: '+0 mm' })}
          onApply={async () => undefined}
          onCancel={() => {}}
        />,
        { container },
      )
      frame()
      expect(queryByTestId('entry')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

// @vitest-environment jsdom
//
// WO-037 (Operator, annotated screenshot 2026-08-07): while a program is RUNNING,
// the active highlighted line must stay vertically CENTERED in the line-list
// viewport - today it drifts below the fold. Pinned here:
//   - exact scroll position math across a simulated run (centered, and
//     clamped at both ends of the scroll range), not just "it scrolled";
//   - the operator's own scroll wins; centering resumes after a short idle
//     (FOLLOW_RESUME_MS) and on a NEW run, never mid-override;
//   - our own programmatic scroll echo does NOT count as an operator scroll;
//   - idle and feed-hold (paused) browsing is never auto-scrolled, and a
//     scroll during feed hold arms the SAME idle window, so resuming right
//     after browsing does not snap-recenter (WO-040 finding 3).
//
// WO-040 tightened the geometry simulation after WO-037's audit: the list is
// NOT the rows' offset parent (it has no CSS position), so offsetTop here is
// DOCUMENT-relative with a nonzero LIST_DOC_TOP gap - exactly the production
// relationship the old code got wrong by feeding offsetTop into scrollTop.
// The component must derive a list-local row top from getBoundingClientRect
// deltas plus scrollTop; rects, client/scrollHeight and scrollTop are all
// mocked consistently below.
//
// WO-044 tightened it again after WO-040's audit: rects are BORDER-box while
// scrollTop/clientHeight are CLIENT-area, and the production list has a 1px
// border - so rect deltas alone land every centering off by clientTop. The
// mock list here has a LIST_BORDER border (bigger than production's 1px, so
// the mock is LESS convenient than reality, never more) and the exact
// assertions below fail on the WO-040 formula by exactly that much.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useMachineControl } = await import('../../store/machineControlStore')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const {
  FOLLOW_RESUME_MS,
  centeredScrollTop,
  initialFollowScroll,
  isFollowing,
  markApplied,
  observeScroll,
} = await import('../../components/machine/followScroll')

const ROW_H = 18
const VIEW_H = 306 // 17 rows visible; half = 153
const TOTAL = 200
const PROGRAM = Array.from({ length: TOTAL }, (_, i) => `G1 X${i + 1}`).join('\n')

// ProgramPanel renders a FOLLOW_WINDOW=160 slice starting 40 lines behind the
// cursor. These expectations replicate that windowing on purpose: if the
// window math changes, the centered positions here must be re-derived.
const WINDOW = 160
const BACK = 40
function expectedTop(cursor: number): number {
  const windowStart = Math.max(0, cursor - BACK)
  const rows = Math.min(WINDOW, TOTAL - windowStart)
  const rowTop = (cursor - windowStart - 1) * ROW_H
  return centeredScrollTop(rowTop, ROW_H, VIEW_H, rows * ROW_H)
}

// --- jsdom geometry ---------------------------------------------------------
// The list sits LIST_DOC_TOP px below the rows' actual offset parent (the
// document body) - the nonzero gap that separates document-relative offsetTop
// from a list-local coordinate. Old code (scrollTop = f(offsetTop)) lands
// every centering off by exactly this much; the WO-040 regression test pins it.
const LIST_DOC_TOP = 500
// The list's top border. scrollTop is measured from BELOW it; rect tops are
// measured ABOVE it (border box). 3px, not production's 1px: a 1px error can
// hide inside rounding or the follow echo epsilon - 3px cannot.
const LIST_BORDER = 3
const scrollTops = new WeakMap<Element, number>()
const saved: Array<[object, string, PropertyDescriptor | undefined]> = []
function mock(proto: object, prop: string, desc: PropertyDescriptor) {
  saved.push([proto, prop, Object.getOwnPropertyDescriptor(proto, prop)])
  Object.defineProperty(proto, prop, { configurable: true, ...desc })
}

function rowIndex(el: Element): number {
  return el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0
}

function rect(top: number, height: number): DOMRect {
  return {
    top, height, bottom: top + height,
    left: 0, right: 0, width: 0, x: 0, y: top,
    toJSON() { return this },
  } as DOMRect
}

beforeAll(() => {
  mock(HTMLElement.prototype, 'offsetTop', {
    // DOCUMENT-relative on purpose: the list is not positioned, so the rows'
    // offset parent is the body and offsetTop includes the list's own offset.
    get(this: HTMLElement) {
      if (!this.classList.contains('gcode-line') || !this.parentElement) return 0
      // Rows live in the list's client area, which starts below its border.
      return LIST_DOC_TOP + LIST_BORDER + rowIndex(this) * ROW_H
    },
  })
  mock(HTMLElement.prototype, 'offsetParent', {
    get(this: HTMLElement) {
      return this.classList.contains('gcode-line') ? document.body : null
    },
  })
  mock(HTMLElement.prototype, 'offsetHeight', {
    get(this: HTMLElement) { return this.classList.contains('gcode-line') ? ROW_H : 0 },
  })
  mock(Element.prototype, 'getBoundingClientRect', {
    value(this: Element): DOMRect {
      // Rects are BORDER boxes: the list's rect spans border + client area,
      // and an unscrolled first row's rect top sits LIST_BORDER below the
      // list's rect top - the exact production relationship (WO-044).
      if (this.classList.contains('control-gcode-list')) {
        return rect(LIST_DOC_TOP, VIEW_H + 2 * LIST_BORDER)
      }
      if (this.classList.contains('gcode-line') && this.parentElement) {
        const scrolled = scrollTops.get(this.parentElement) ?? 0
        return rect(LIST_DOC_TOP + LIST_BORDER + rowIndex(this) * ROW_H - scrolled, ROW_H)
      }
      return rect(0, 0)
    },
  })
  mock(Element.prototype, 'clientHeight', {
    get(this: Element) { return this.classList.contains('control-gcode-list') ? VIEW_H : 0 },
  })
  mock(Element.prototype, 'clientTop', {
    get(this: Element) { return this.classList.contains('control-gcode-list') ? LIST_BORDER : 0 },
  })
  mock(Element.prototype, 'scrollHeight', {
    get(this: Element) {
      return this.classList.contains('control-gcode-list') ? this.children.length * ROW_H : 0
    },
  })
  mock(Element.prototype, 'scrollTop', {
    get(this: Element) { return scrollTops.get(this) ?? 0 },
    set(this: Element, v: number) { scrollTops.set(this, v) },
  })
})

afterAll(() => {
  for (const [proto, prop, desc] of saved.reverse()) {
    if (desc) Object.defineProperty(proto, prop, desc)
    else delete (proto as Record<string, unknown>)[prop]
  }
})

// --- store driving ----------------------------------------------------------
let now = 100_000
vi.spyOn(Date, 'now').mockImplementation(() => now)

function setJob(patch: Partial<ReturnType<typeof useMachineControl.getState>['job']>) {
  act(() => {
    useMachineControl.setState((s) => ({ job: { ...s.job, ...patch } }))
  })
}

/** Advance the simulated run: machine running, cursor at `line`. */
function streamTo(line: number) {
  setJob({
    phase: 'streaming',
    ackedSourceLine: line,
    ackedLines: line,
    sentSourceLine: line,
    sentLines: line,
  })
}

function list(): HTMLElement {
  return screen.getByTestId('control-gcode-list')
}

/** The active row's center in CLIENT-AREA coordinates (rect deltas minus the border). */
function hlCenter(): number {
  const el = list()
  const row = el.querySelector<HTMLElement>('.gcode-line-hl')
  expect(row).not.toBeNull()
  return (
    row!.getBoundingClientRect().top -
    el.getBoundingClientRect().top -
    el.clientTop +
    el.scrollTop +
    ROW_H / 2
  )
}

beforeEach(() => {
  now = 100_000
  act(() => {
    useMachineControl.setState((s) => ({
      programText: PROGRAM,
      job: {
        ...s.job,
        phase: 'ready',
        name: 'follow.nc',
        totalLines: TOTAL,
        sentLines: 0,
        ackedLines: 0,
        ackedSourceLine: 0,
        sentSourceLine: 0,
        startedAt: 1000,
        pausedAt: null,
        error: null,
        toolChanges: [],
      },
    }))
  })
})

afterEach(cleanup)

describe('WO-037 pure math: centeredScrollTop', () => {
  it('puts the row center at the viewport center', () => {
    // row at 702px, 18 tall -> center 711; viewport 306 -> top = 711 - 153.
    expect(centeredScrollTop(702, 18, 306, 2880)).toBe(558)
  })
  it('clamps at the top of the scroll range', () => {
    expect(centeredScrollTop(72, 18, 306, 2880)).toBe(0)
  })
  it('clamps at the bottom of the scroll range', () => {
    // raw 558 but only 810px of content: max = 810 - 306 = 504.
    expect(centeredScrollTop(702, 18, 306, 810)).toBe(504)
    // Content shorter than the viewport can never scroll below 0.
    expect(centeredScrollTop(100, 18, 306, 200)).toBe(0)
  })
})

describe('WO-037 pure policy: operator override state machine', () => {
  it('our own applied-scroll echo does not pause following', () => {
    const s = markApplied(initialFollowScroll(), 558)
    expect(observeScroll(s, 558, 5000)).toBe(s)
    expect(observeScroll(s, 558.6, 5000)).toBe(s) // fractional echo within 1px
    expect(isFollowing(observeScroll(s, 558, 5000), 5000)).toBe(true)
  })
  it('an operator scroll pauses following until FOLLOW_RESUME_MS of idle', () => {
    const s = observeScroll(markApplied(initialFollowScroll(), 558), 120, 5000)
    expect(isFollowing(s, 5000)).toBe(false)
    expect(isFollowing(s, 5000 + FOLLOW_RESUME_MS - 1)).toBe(false)
    expect(isFollowing(s, 5000 + FOLLOW_RESUME_MS)).toBe(true)
  })
  it('re-applying after the idle clears the override', () => {
    const paused = observeScroll(initialFollowScroll(), 120, 5000)
    expect(isFollowing(markApplied(paused, 300), 5001)).toBe(true)
  })
})

describe('WO-037 component: the active line stays centered while running', () => {
  it('centers across a simulated run, clamped at both ends (exact positions)', () => {
    render(<ProgramPanel />)
    // Near the start: centering would need negative scrollTop -> clamp 0.
    streamTo(5)
    expect(list().scrollTop).toBe(expectedTop(5))
    expect(list().scrollTop).toBe(0)
    // Mid-list, window not yet sliding: true centering.
    streamTo(30)
    expect(list().scrollTop).toBe(expectedTop(30))
    expect(list().scrollTop + VIEW_H / 2).toBe(hlCenter()) // row center == view center
    // Window sliding (cursor past BACK): steady-state centered position.
    streamTo(100)
    expect(list().scrollTop).toBe(expectedTop(100))
    expect(list().scrollTop).toBe(558)
    expect(list().scrollTop + VIEW_H / 2).toBe(hlCenter())
    streamTo(101)
    expect(list().scrollTop).toBe(558) // steady state holds line-over-line
    // Near the end: short window -> clamp to max scroll.
    streamTo(195)
    expect(list().scrollTop).toBe(expectedTop(195))
    expect(list().scrollTop).toBe(504)
  })

  it('an operator scroll wins, then centering resumes after the idle window', () => {
    render(<ProgramPanel />)
    streamTo(100)
    expect(list().scrollTop).toBe(558)
    // Operator scrolls away mid-run.
    list().scrollTop = 120
    fireEvent.scroll(list())
    // Next acks arrive before the idle window closes: do not fight them.
    now += 2000
    streamTo(101)
    expect(list().scrollTop).toBe(120)
    // Idle window passed: centering resumes on the next ack.
    now += FOLLOW_RESUME_MS
    streamTo(102)
    expect(list().scrollTop).toBe(558)
  })

  it('the programmatic scroll echo does not count as an operator scroll', () => {
    render(<ProgramPanel />)
    streamTo(100)
    expect(list().scrollTop).toBe(558)
    // The browser echoes our own assignment as a scroll event.
    fireEvent.scroll(list())
    // Still following: the very next ack may move the viewport (end clamp).
    streamTo(195)
    expect(list().scrollTop).toBe(504)
  })

  it('centers despite a NONZERO offset between the list and the rows\' offset parent (WO-040 finding 1)', () => {
    render(<ProgramPanel />)
    streamTo(30)
    const row = list().querySelector<HTMLElement>('.gcode-line-hl')!
    // Prove the simulated geometry is document-relative: feeding offsetTop
    // into scrollTop CANNOT center here (it is off by LIST_DOC_TOP).
    expect(row.offsetTop).toBe(LIST_DOC_TOP + LIST_BORDER + (30 - 1) * ROW_H)
    expect(row.offsetParent).toBe(document.body)
    // The component must still land the row mid-viewport, list-locally.
    expect(list().scrollTop).toBe(expectedTop(30))
    expect(list().scrollTop + VIEW_H / 2).toBe(hlCenter())
    // Steady state too (window sliding), still exact.
    streamTo(100)
    expect(list().scrollTop).toBe(558)
    expect(list().scrollTop + VIEW_H / 2).toBe(hlCenter())
  })

  it('centers exactly against the CLIENT area despite a nonzero list border (WO-044)', () => {
    render(<ProgramPanel />)
    streamTo(100) // mid-viewport steady state: no clamp can hide an offset
    const el = list()
    const row = el.querySelector<HTMLElement>('.gcode-line-hl')!
    // The mock models the production geometry the WO-040 audit flagged:
    // a real border, so scrollTop's origin sits clientTop BELOW the rect top.
    expect(el.clientTop).toBe(LIST_BORDER)
    // The WO-040 formula (rect delta WITHOUT clientTop) is border-box
    // relative and misses by exactly the border - pin the failure mode.
    const borderBoxRowTop = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    expect(centeredScrollTop(borderBoxRowTop, ROW_H, el.clientHeight, el.scrollHeight)).toBe(
      558 + LIST_BORDER,
    )
    // The component must land the exact client-area position anyway.
    expect(el.scrollTop).toBe(558)
    expect(el.scrollTop + VIEW_H / 2).toBe(hlCenter())
  })

  it('a scroll during feed hold arms the idle window - resume does not snap-recenter (WO-040 finding 3)', () => {
    render(<ProgramPanel />)
    streamTo(100)
    expect(list().scrollTop).toBe(558)
    // Feed hold: the operator browses away while paused.
    setJob({ phase: 'paused' })
    list().scrollTop = 120
    fireEvent.scroll(list())
    // Resume BEFORE the idle window closes: the override must survive.
    now += 2000
    setJob({ phase: 'streaming', ackedSourceLine: 101, ackedLines: 101 })
    expect(list().scrollTop).toBe(120)
    // Once the idle window passes, centering resumes on the next ack.
    now += FOLLOW_RESUME_MS
    streamTo(102)
    expect(list().scrollTop).toBe(558)
  })

  it('a new run resets an operator override immediately', () => {
    render(<ProgramPanel />)
    streamTo(100)
    list().scrollTop = 120
    fireEvent.scroll(list())
    streamTo(101)
    expect(list().scrollTop).toBe(120) // override active
    // A fresh run starts (new startedAt): follow from the first ack.
    setJob({ startedAt: 2000 })
    streamTo(30)
    expect(list().scrollTop).toBe(expectedTop(30))
  })

  it('idle and feed-hold browsing are untouched', () => {
    render(<ProgramPanel />)
    // Idle (ready): manual scroll position survives store updates.
    list().scrollTop = 42
    fireEvent.scroll(list())
    setJob({ ackedLines: 0 }) // any re-render
    expect(list().scrollTop).toBe(42)
    // Feed hold: cursor exists but phase is 'paused' - no auto-scroll.
    setJob({ phase: 'paused', ackedSourceLine: 50, ackedLines: 50 })
    expect(list().scrollTop).toBe(42)
  })
})

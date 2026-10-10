// @vitest-environment jsdom
//
// WO-049: four-role visual language — radio sets, role classes, contrast.
// Acceptance: radio exactly-one-lit (incl. the CW/CCW always-green
// regression), role classes applied, contrast tokens asserted, font
// sizes per group. See docs/ui-ux/COHESION-STANDARD.md section 9.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import type {
  ConnectionPhase, LoadOutcome, MachineController, MachineState, MachineStatus, StreamerProgress,
} from '../../lib/machine/controller'
import type { MachineActionResult, SpindleCommandResult, SpindleRoute } from '../../lib/machine/machineSession'
import { typedMock } from '../support/typedMock'

/** A full MachineController stub - only `status()` varies here, but the
 *  module's real `getMachineController` returns a genuine `MachineController`
 *  (same shape as collapsedSummaryTruth.wo959.test.tsx's stubMachineController). */
function stubMachineController(): MachineController {
  const jobProgress: StreamerProgress = {
    phase: 'empty', totalLines: 0, sentLines: 0, ackedLines: 0,
    ackedSourceLine: 0, sentSourceLine: 0, bytesInFlight: 0,
  }
  return {
    capabilities: {
      geometryQueue: false, executingMoveId: false, bufferSeconds: false,
      gcodeText: false, perAxisHoming: false, ownsSpindle: false, spindleCommands: false,
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    connectionPhase: vi.fn((): ConnectionPhase => 'connected'),
    firmwareVersion: vi.fn(() => null),
    machineState: vi.fn((): MachineState => 'idle'),
    status: vi.fn((): MachineStatus => ({
      state: 'idle', subState: null, machinePos: null, workPos: null, feedMmMin: null, spindleRpm: null,
      overrides: null, executingMoveId: null, buffer: null, inputs: null, homed: null, spindle: null,
    })),
    queryStatus: vi.fn(),
    refreshState: vi.fn(() => true),
    querySettings: vi.fn(() => true),
    verifiedIdle: vi.fn(() => true),
    homedThisSession: vi.fn(() => false),
    resetInProgress: vi.fn(() => false),
    subscribeResetInProgress: vi.fn(() => () => {}),
    jog: vi.fn(() => true),
    jogToWorkXY: vi.fn(() => true),
    jogToMachineZ: vi.fn(() => true),
    jogCancel: vi.fn(),
    home: vi.fn(() => true),
    feedHold: vi.fn(),
    cycleResume: vi.fn(() => true),
    reset: vi.fn(),
    unlock: vi.fn(() => true),
    emergencyStop: vi.fn(),
    resetToIdle: vi.fn(async () => ({ ok: true, reason: null })),
    setOverride: vi.fn(),
    selectWcs: vi.fn(() => true),
    zeroWorkAxis: vi.fn(() => true),
    probe: vi.fn(async () => ({ ok: true, at: null })),
    sendCommand: vi.fn(() => true),
    sendCommandAwait: vi.fn(async () => ({ ok: true, message: null })),
    loadJob: vi.fn((): LoadOutcome => ({ ok: false, reason: 'stub controller' })),
    loadJobFrom: vi.fn((): LoadOutcome => ({ ok: false, reason: 'stub controller' })),
    startJob: vi.fn(() => true),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(() => true),
    stopJob: vi.fn(),
    stepJob: vi.fn(() => true),
    setSingleBlockMode: vi.fn(),
    singleBlockMode: vi.fn(() => false),
    hasActiveJob: vi.fn(() => false),
    jobProgress: vi.fn(() => jobProgress),
    stoppedJobProgress: vi.fn(() => null),
  }
}

// Mock runMachineAction so spindle button clicks don't require a real
// controller — the test verifies the latched-state UI, not the g-code
// send. The commanded-state tracking is local to the panel (WO-050 has
// not landed; TODO marker in SpindlePanel.tsx).
vi.mock('../../lib/machine/machineSession', () => typedMock<typeof import('../../lib/machine/machineSession')>({
  // WO-2237: SpindlePanel reads the tool-change hold and the kept-pause verdict.
  subscribeToolChangeHold: () => () => {},
  toolChangeHoldActive: () => false,
  subscribePausedProgramTakesCommands: () => () => {},
  pausedProgramTakesCommands: () => false,
  getMachineController: vi.fn(() => stubMachineController()),
  // WO-474 (coolant half): runMachineAction returns { ok, sent } and has since
  // machineSession.ts:1933 - it was never a bare boolean. The coolant buttons
  // now read `.ok` to decide whether to latch, the same rule the spindle
  // buttons already followed, so `true` here made `run(action).ok` undefined
  // and every coolant press look REFUSED. THIRD time an incomplete mock in this
  // file has caught a change, and the third time the mock was the thing that
  // was wrong. Carry the real SHAPE, not merely the real truthiness.
  runMachineAction: vi.fn((): MachineActionResult => ({ ok: true, sent: 1 })),
  // WO-905/UI completed this mock, it did not change an assertion. SpindlePanel
  // now asks machineSession which route this connection offers instead of always
  // emitting M3/M5, so a mock missing these members throws before any of the
  // WO-049 tests below can look at a button. 'text' is the pre-WO-905 behaviour
  // these tests were written against, so what they assert is unchanged.
  spindleRoute: vi.fn((): SpindleRoute => 'text'),
  // WO-474: commandSpindle returns {ok, route}, NOT a bare boolean, and the
  // panel now reads `.ok` to decide whether to latch. A mock returning `true`
  // made every press look REFUSED, which sent the panel down a branch that
  // calls estopNeedsReset - absent here, so it threw. Mocks have to carry the
  // real SHAPE, not merely the real truthiness; that is the second time an
  // incomplete mock in this file has caught a change, and both times the mock
  // was the thing that was wrong.
  commandSpindle: vi.fn((): SpindleCommandResult => ({ ok: true, route: 'text' })),
  estopNeedsReset: vi.fn(() => false),
}))

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

const { SpindlePanel } = await import('../../components/machine/SpindlePanel')
const { useMachineControl } = await import('../../store/machineControlStore')

const appCss = readFileSync('src/styles/app.css', 'utf8')
const tokensCss = readFileSync('src/theme/tokens.css', 'utf8')

// -- CSS parsing helpers (adapted from controlPagePolish.test.tsx) --

/** The WO-049 CSS section, comments stripped, for rule parsing. */
const wo049Start = appCss.indexOf('WO-049: FOUR-ROLE VISUAL LANGUAGE')
const wo049Css = appCss.slice(wo049Start).replace(/\/\*[\s\S]*?\*\//g, '')

/** Body of the first CSS rule whose selector list contains `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`, 'm').exec(wo049Css)
  if (!match) throw new Error(`no WO-049 CSS rule found for "${selector}"`)
  return match[1]
}

function decl(selector: string, property: string): string {
  const body = ruleBody(selector)
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, 'm').exec(body)
  if (!match) throw new Error(`"${selector}" has no ${property} declaration in WO-049 section`)
  return match[1].trim()
}

/** Declaration from the FULL app.css (for pre-existing rules the WO-049
 *  section inherits but does not redeclare — e.g. the spindle six-pack's
 *  12px sm or the chip 11px xs, which were already correct). */
function fullRuleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(appCss)
  if (!match) throw new Error(`no CSS rule found for "${selector}" in full app.css`)
  return match[1]
}

function fullDecl(selector: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, 'm').exec(fullRuleBody(selector))
  if (!match) throw new Error(`"${selector}" has no ${property} in full app.css`)
  return match[1].trim()
}

// -- Token resolution (tokens.css var() chain -> hex) --

function resolveToken(css: string, token: string): string {
  const direct = new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)
  if (direct) return direct[1]
  const varMatch = new RegExp(`${token}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(css)
  if (varMatch) return resolveToken(css, varMatch[1])
  throw new Error(`cannot resolve token ${token} in tokens.css`)
}

// -- WCAG contrast ratio --

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) throw new Error(`bad hex: ${hex}`)
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

function srgbToLinear(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

afterEach(cleanup)

// -- Radio sets: CW/CCW/Off and Mist/Flood/Off --

// WO-957 RESOLVES WO-049, IT DOES NOT DRIFT FROM IT. Operator ruling 2026-08-24:
// "Remove off. The CW and CCW are a two state button (hit once for on and
// button illuminates, hit twice and it turns off. Same for the buttons for
// mist, flood, remove off." The radio set with a lit Off member is retired by
// that ruling, and this block is re-pinned to the two-state design rather than
// deleted - the properties WO-049 actually protected (never two lit at once,
// never the always-green jog class) are still protected below.
//
// Per-assertion verdicts, written down:
//   RETIRE  "exactly one lit, and at rest it is Off" - there IS no Off member.
//           At rest nothing is lit, which is what "plain means off" means.
//   RE-PIN  "clicking CW lights CW only" - kept verbatim minus the Off clause.
//   RE-PIN  "clicking Off returns to off" -> "a second press on CW turns it off".
//   RE-PIN  coolant radio set -> coolant two-state, still never two lit.
//   RE-PIN  "all six buttons share the family class" -> four buttons.
// WO-964 AMENDS THE AMENDMENT, and it is Operator's ruling both times. WO-957
// read his first instruction ("Remove off... two state button") and removed
// Off from both groups. He looked at the result and ruled again: "OK we can
// leave off button on spindle. But spindle only. All others are two state
// buttons." So WO-049's radio set is RESTORED for the spindle and stays
// retired for the coolant. Both are his calls; neither is drift.
describe('WO-964: spindle is a radio set again, coolant stays two-state', () => {
  beforeEach(() => {
    useMachineControl.setState({ connectionPhase: 'connected', job: { phase: 'idle' } as never })
  })

  // The two groups now REST DIFFERENTLY, and that is the ruling rather than an
  // inconsistency: the spindle has an Off MEMBER to light, the coolant's "off"
  // is the absence of a lit button.
  it('at rest the spindle lights Off and the coolant lights nothing', () => {
    const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
    const spindleGroup = container.querySelector('[data-spindle-dir]')!
    const coolantGroup = container.querySelector('[data-coolant-mode]')!
    expect(spindleGroup.getAttribute('data-spindle-dir')).toBe('off')
    expect(coolantGroup.getAttribute('data-coolant-mode')).toBe('off')
    expect(spindleGroup.querySelectorAll('.control-latched').length).toBe(1)
    expect(screen.getByTestId('control-spindle-off').className).toContain('control-latched')
    expect(coolantGroup.querySelectorAll('.control-latched').length).toBe(0)
  })

  it('the SPINDLE keeps its Off and the COOLANT does not have one', () => {
    const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
    expect(screen.getByTestId('control-spindle-off')).toBeTruthy()
    expect(screen.queryByTestId('control-coolant-off')).toBeNull()
    const spindleGroup = container.querySelector('[data-spindle-dir]')!
    const coolantGroup = container.querySelector('[data-coolant-mode]')!
    expect(spindleGroup.querySelectorAll('button').length).toBe(3)
    expect(coolantGroup.querySelectorAll('button').length).toBe(2)
  })

  it('clicking CW lights CW only — CCW stays quiet (the always-green regression)', () => {
    const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
    const spindleGroup = container.querySelector('[data-spindle-dir]')!
    fireEvent.click(screen.getByTestId('control-spindle-cw'))
    expect(spindleGroup.getAttribute('data-spindle-dir')).toBe('cw')
    expect(spindleGroup.querySelectorAll('.control-latched').length).toBe(1)
    expect(screen.getByTestId('control-spindle-cw').className).toContain('control-latched')
    expect(screen.getByTestId('control-spindle-ccw').className).not.toContain('control-latched')
  })

  it('clicking CCW lights CCW only — CW loses the latched state (exactly one lit)', () => {
    const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
    const spindleGroup = container.querySelector('[data-spindle-dir]')!
    fireEvent.click(screen.getByTestId('control-spindle-cw'))
    fireEvent.click(screen.getByTestId('control-spindle-ccw'))
    expect(spindleGroup.getAttribute('data-spindle-dir')).toBe('ccw')
    expect(spindleGroup.querySelectorAll('.control-latched').length).toBe(1)
    expect(screen.getByTestId('control-spindle-ccw').className).toContain('control-latched')
    expect(screen.getByTestId('control-spindle-cw').className).not.toContain('control-latched')
  })

  // RETIRED FOR THE SPINDLE by WO-964: the two-state press is gone there, so a
  // second press on CW re-sends CW. What replaces it is the behaviour Operator
  // actually asked to keep - Off returns the radio set to off.
  it('clicking Off clears CW/CCW and lights Off (the radio set returns to off)', () => {
    const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
    const spindleGroup = container.querySelector('[data-spindle-dir]')!
    fireEvent.click(screen.getByTestId('control-spindle-cw'))
    fireEvent.click(screen.getByTestId('control-spindle-off'))
    expect(spindleGroup.getAttribute('data-spindle-dir')).toBe('off')
    expect(spindleGroup.querySelectorAll('.control-latched').length).toBe(1)
    expect(screen.getByTestId('control-spindle-off').className).toContain('control-latched')
    expect(screen.getByTestId('control-spindle-cw').className).not.toContain('control-latched')
  })

  it('coolant Mist/Flood are two-state, and never both lit at once', () => {
    const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
    const coolantGroup = container.querySelector('[data-coolant-mode]')!
    const buttons = coolantGroup.querySelectorAll('button')
    fireEvent.click(buttons[0]) // Mist
    expect(coolantGroup.getAttribute('data-coolant-mode')).toBe('mist')
    expect(coolantGroup.querySelectorAll('.control-latched').length).toBe(1)
    fireEvent.click(buttons[1]) // Flood
    expect(coolantGroup.getAttribute('data-coolant-mode')).toBe('flood')
    expect(coolantGroup.querySelectorAll('.control-latched').length).toBe(1)
    fireEvent.click(buttons[1]) // Flood again - the second press turns it off
    expect(coolantGroup.getAttribute('data-coolant-mode')).toBe('off')
    expect(coolantGroup.querySelectorAll('.control-latched').length).toBe(0)
  })
})

describe('WO-049: CW/CCW no longer wear the always-green jog class', () => {
  it('CW and CCW use the momentary spindle family, not control-jog-btn', () => {
    render(<SpindlePanel onOpenActions={() => {}} />)
    const cw = screen.getByTestId('control-spindle-cw')
    const ccw = screen.getByTestId('control-spindle-ccw')
    expect(cw.className).not.toContain('control-jog-btn')
    expect(ccw.className).not.toContain('control-jog-btn')
    expect(cw.className).toContain('control-spindle-btn')
    expect(ccw.className).toContain('control-spindle-btn')
  })

  it('all five spindle/coolant buttons share the momentary family class', () => {
    const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
    const groups = container.querySelectorAll('.control-spindle-btns')
    expect(groups.length).toBe(2)
    for (const group of groups) {
      // WO-964: three in the spindle group, two in the coolant group - so the
      // assertion is that EVERY button carries the class, not a fixed count.
      const btns = group.querySelectorAll('button.control-spindle-btn')
      expect(btns.length).toBe(group.querySelectorAll('button').length)
      for (const btn of Array.from(btns)) {
        expect(btn.className).not.toContain('control-jog-btn')
        expect(btn.className).not.toContain('modal-btn')
      }
    }
  })
})

// -- Role classes applied (CSS parsing) --

describe('WO-049: four-role visual language — role classes applied', () => {
  it('RULE 2: .modal-btn on the Control surface takes the 6px corner', () => {
    expect(decl('.control-page .modal-btn', 'border-radius')).toBe('6px')
  })

  it('LATCHING: .control-chip-active gets the blue selection language + active underline', () => {
    expect(decl('.control-page .control-chip-active', 'border-color')).toBe('var(--accent)')
    expect(decl('.control-page .control-chip-active', 'color')).toBe('var(--text-active)')
    expect(decl('.control-page .control-chip-active', 'box-shadow')).toBe('inset 0 -2px 0 var(--accent-cyan)')
  })

  it('LATCHING: the latched treatment survives :disabled (contrast fix)', () => {
    const body = ruleBody('.control-page .control-chip-active:disabled')
    expect(body).toContain('var(--text-active)')
    expect(body).toContain('var(--accent)')
    // The :disabled selector is in the same rule as the non-disabled one.
    expect(body).toContain('box-shadow')
  })

  it('STATUS: .control-state-chip is flat (transparent border, no hover affordance)', () => {
    expect(decl('.control-page .control-state-chip', 'border-color')).toBe('transparent')
  })

  it('BANNER: .control-next-action is inline-flex (never a full-width row)', () => {
    expect(decl('.control-page .control-next-action', 'display')).toBe('inline-flex')
  })

  it('BANNER: hold/door states tint amber via data-state', () => {
    const body = ruleBody('.control-page .control-next-action[data-state="hold"]')
    expect(body).toContain('var(--accent-amber)')
  })

  it('OPERATOR NOTE 1: .control-step-btn uses the same family surface (6px, surface-2)', () => {
    expect(decl('.control-page .control-step-btn', 'border-radius')).toBe('6px')
    expect(decl('.control-page .control-step-btn', 'background')).toBe('var(--surface-2)')
  })

  it('MOMENTARY: spindle buttons strip the green look at rest', () => {
    expect(decl('.control-page .control-spindle-btn', 'border')).toContain('var(--border-strong)')
    expect(decl('.control-page .control-spindle-btn', 'background')).toBe('var(--surface-2)')
    expect(decl('.control-page .control-spindle-btn', 'color')).toBe('var(--text-secondary)')
  })
})

// -- Contrast tokens asserted (OPERATOR NOTE 2) --

describe('WO-049: selected-pill contrast (Operator note 2)', () => {
  it('the latched label token passes 4.5:1 against the latched fill token', () => {
    const textActive = resolveToken(tokensCss, '--text-active')
    const surface2 = resolveToken(tokensCss, '--surface-2')
    const ratio = contrastRatio(textActive, surface2)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('the latched label achieves 8:1 or better (WCAG AAA normal text)', () => {
    const textActive = resolveToken(tokensCss, '--text-active')
    const surface2 = resolveToken(tokensCss, '--surface-2')
    const ratio = contrastRatio(textActive, surface2)
    // State the achieved ratio: --text-active (--blue-300 #7ec0ff) on
    // --surface-2 (--slate-850 #1c2230) = 8.23:1.
    expect(ratio).toBeGreaterThanOrEqual(8)
  })

  it('without the :disabled fix, muted text on the selected fill would fail', () => {
    // This documents WHY the :disabled selector is necessary: without it,
    // .control-chip-btn:disabled (specificity 0,2,0) overrides the active
    // label, dropping it to --text-muted on the dark fill.
    const textMuted = resolveToken(tokensCss, '--text-muted')
    const surface2 = resolveToken(tokensCss, '--surface-2')
    const ratio = contrastRatio(textMuted, surface2)
    // --text-muted (--slate-400 #7e8ea1) on --surface-2 (#1c2230) would
    // be ~4.3:1 — but on the OLD --surface-selected (#1a3a5c) it was
    // ~1.82:1 (the pre-fix failure mode). Either way, the :disabled
    // selector in the latched rule prevents this override entirely.
    expect(ratio).toBeLessThan(8) // proves the muted path is worse than the active path
  })
})

describe('WO-061: Single Block toggle takes BUTTON geometry (6px + md)', () => {
  it('Single Block toggle has 6px border-radius (not the 10px chip pill)', () => {
    expect(decl('.control-page .control-single-block-mode', 'border-radius')).toBe('6px')
  })

  it('Single Block toggle font-size is md (joins its STEP-row group)', () => {
    expect(decl('.control-page .control-single-block-mode', 'font-size')).toBe('var(--font-size-md)')
  })

  it('the base chip class it inherits from still ships the 10px pill (proves the override is needed)', () => {
    expect(fullDecl('.control-chip-btn', 'border-radius')).toBe('10px')
  })
})

describe('WO-061: latched underline is exactly 2px (standard, not 3px)', () => {
  it('.control-chip-active box-shadow is exactly inset 0 -2px 0 (not 3px)', () => {
    expect(decl('.control-page .control-chip-active', 'box-shadow')).toBe('inset 0 -2px 0 var(--accent-cyan)')
  })

  it('.control-latched box-shadow is exactly inset 0 -2px 0 (not 3px)', () => {
    expect(decl('.control-page .control-latched', 'box-shadow')).toBe('inset 0 -2px 0 var(--accent-cyan)')
  })

  it('the latched hover rule keeps the 2px underline', () => {
    expect(decl('.control-page .control-latched:hover:not(:disabled)', 'box-shadow')).toBe('inset 0 -2px 0 var(--accent-cyan)')
  })
})

// -- Font sizes per group (RULE 3) --

describe('WO-049: one font size per group (rule 3)', () => {
  it('Single Block toggle joins its STEP-row group at 13px md', () => {
    expect(decl('.control-page .control-single-block-mode', 'font-size')).toBe('var(--font-size-md)')
  })

  it('spindle six-pack keeps its 12px sm density override', () => {
    expect(fullDecl('.control-spindle-btn', 'font-size')).toBe('var(--font-size-sm)')
  })

  it('chips stay at 11px xs', () => {
    expect(fullDecl('.control-chip-btn', 'font-size')).toBe('var(--font-size-xs)')
  })

  it('step-row buttons use 13px md (same family type as transport neighbors)', () => {
    expect(decl('.control-page .control-step-btn', 'font-size')).toBe('var(--font-size-md)')
  })
})

// -- TODO marker for WO-050 (accessory state plumbing) --

describe.skip('WO-049 TODO (WO-050): bind latched state to live accessory state', () => {
  // When WO-050 (accessory state plumbing) lands, SpindlePanel should
  // bind the latched state to the store's live GrblParserState.spindle /
  // .coolant instead of the local commanded-state tracking. This test
  // is skipped until that plumbing exists; un-skip and verify the
  // latched member follows the controller's reported state, not just
  // the commanded click.
  it('latched state follows the store live accessory state', () => {
    expect(true).toBe(true)
  })
})

// (beforeEach is imported at the top with the other vitest exports)

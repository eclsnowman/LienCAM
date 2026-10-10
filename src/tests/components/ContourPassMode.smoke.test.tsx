// @vitest-environment jsdom
//
// React-render SMOKE test for the Contour "Passes" tab Cutting-strategy dropdown
// (replaced the entangled enableRoughing + enableFinish checkboxes).
//
// WHY THIS EXISTS (feedback_render_gate_ui_changes): a hooks-order crash once
// shipped from a modal change with no React render test. tsc + the pure-logic
// vitest suite do not mount React. This file mounts NewOperationModal, opens it
// for a contour op, switches to the Passes tab, and drives the new dropdown so a
// hooks-order regression throws here.
//
// It ALSO asserts the four-mode emit/derive CONTRACT directly against the two
// helpers the modal uses to map mode <-> params (contourPassParamsForMode /
// deriveContourMode). Asserting the created Operation in the store would need
// packable geometry + a worker the node/jsdom harness lacks; exercising the
// exact functions the emit path calls is the equivalent guard and pins the
// safety invariant (no mode yields stockToLeave=0 && finishPasses=0).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's localStorage is broken under vitest's node launch flags and the store
// persists on every set(). Install an in-memory Storage shim BEFORE importing
// the store (same scaffolding as NestModal.smoke.test.tsx). No app change.
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

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { contourPassParamsForMode, deriveContourMode } = await import('../../lib/cam/types')

afterEach(cleanup)

// Ensure a setup exists (the modal returns null without one) and the modal is
// closed before each test so they are order-independent.
beforeEach(() => {
  act(() => {
    useCamStore.getState().closeModal()
    const st = useCamStore.getState()
    if (st.project.setups.length === 0) {
      st.addSetup({
        id: 'setup-test', name: 'Test Setup',
        wcs: {
          id: 'wcs-1', label: 'G54', fixtureOffset: 54,
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
        },
        stock: { type: 'auto' },
        operations: [],
        notes: '',
      } as unknown as Parameters<typeof st.addSetup>[0])
    }
  })
})

function openContourPassesTab() {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  // New op defaults to contour_2d. Click the Passes tab.
  fireEvent.click(screen.getByText('Passes'))
}

describe('Contour Cutting-strategy dropdown render smoke', () => {
  it('mounts closed without crashing', () => {
    render(<NewOperationModal />)
    expect(screen.queryByText('Cutting strategy')).toBeNull()
  })

  it('opens to the Passes tab and shows the strategy dropdown without a hooks crash', () => {
    openContourPassesTab()
    const sel = screen.getByTestId('contour-cutting-strategy') as HTMLSelectElement
    expect(sel).not.toBeNull()
    // Default mode = cut at the geometry.
    expect(sel.value).toBe('cut_at_geometry')
    act(() => { useCamStore.getState().closeModal() })
    expect(screen.queryByText('Cutting strategy')).toBeNull()
  })

  it('shows conditional Stock-to-leave / Finish-passes fields per mode', () => {
    openContourPassesTab()
    const sel = screen.getByTestId('contour-cutting-strategy') as HTMLSelectElement

    // cut_at_geometry: no roughing -> NO stock-to-leave AND NO finish-passes.
    // The single profile pass IS the cut; repeats are spring passes, so a
    // "finish passes" control is semantically wrong here (qa/012 P1).
    expect(screen.queryByText('Stock to leave')).toBeNull()
    expect(screen.queryByText('Finish passes')).toBeNull()

    // roughing_only: stock-to-leave, no finish passes.
    act(() => { fireEvent.change(sel, { target: { value: 'roughing_only' } }) })
    expect(screen.queryByText('Stock to leave')).not.toBeNull()
    expect(screen.queryByText('Finish passes')).toBeNull()

    // rough_finish_each: both fields (finish passes valid only with roughing).
    act(() => { fireEvent.change(sel, { target: { value: 'rough_finish_each' } }) })
    expect(screen.queryByText('Stock to leave')).not.toBeNull()
    expect(screen.queryByText('Finish passes')).not.toBeNull()

    // rough_finish_final: both fields.
    act(() => { fireEvent.change(sel, { target: { value: 'rough_finish_final' } }) })
    expect(screen.queryByText('Stock to leave')).not.toBeNull()
    expect(screen.queryByText('Finish passes')).not.toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })
})

describe('Contour mode -> emitted params CONTRACT (the helper the modal emits with)', () => {
  // prev carries the user's last-entered numbers; helpers clamp to a legal min.
  const prev = { stockToLeave: 0.3, finishPasses: 2 }

  it('cut_at_geometry: no roughing; finishPasses pinned to EXACTLY 1 (the profile cut)', () => {
    // The single profile pass IS the cut, so finishPasses is pinned to 1 and does
    // NOT track prev.finishPasses (prev=2 here). Repeats are spring passes. qa/012 P1.
    const p = contourPassParamsForMode('cut_at_geometry', prev)
    expect(p.stockToLeave).toBe(0)
    expect(p.finishPasses).toBe(1)
    expect(p.contourFinishMode).toBeUndefined()
    // No-silent-zero invariant: stockToLeave=0 + finishPasses=1 is a real cut.
    expect(p.stockToLeave === 0 && p.finishPasses === 0).toBe(false)
  })

  it('roughing_only: stock left, no finish', () => {
    const p = contourPassParamsForMode('roughing_only', prev)
    expect(p.stockToLeave).toBe(0.3)
    expect(p.finishPasses).toBe(0)
    expect(p.contourFinishMode).toBeUndefined()
  })

  it("rough_finish_each: rough + finish, contourFinishMode='each_stepdown'", () => {
    const p = contourPassParamsForMode('rough_finish_each', prev)
    expect(p.stockToLeave).toBe(0.3)
    expect(p.finishPasses).toBe(2)
    expect(p.contourFinishMode).toBe('each_stepdown')
  })

  it("rough_finish_final: rough + finish, contourFinishMode='final'", () => {
    const p = contourPassParamsForMode('rough_finish_final', prev)
    expect(p.stockToLeave).toBe(0.3)
    expect(p.finishPasses).toBe(2)
    expect(p.contourFinishMode).toBe('final')
  })

  it('SAFETY: no mode yields stockToLeave=0 && finishPasses=0 (even from zeroed prev)', () => {
    const zeroed = { stockToLeave: 0, finishPasses: 0 }
    for (const mode of ['cut_at_geometry', 'roughing_only', 'rough_finish_each', 'rough_finish_final'] as const) {
      const p = contourPassParamsForMode(mode, zeroed)
      expect(p.stockToLeave === 0 && p.finishPasses === 0).toBe(false)
    }
  })

  it('clamps illegal-low prev values to a legal minimum', () => {
    const p = contourPassParamsForMode('rough_finish_final', { stockToLeave: 0, finishPasses: 0 })
    expect(p.stockToLeave).toBe(0.01)
    expect(p.finishPasses).toBe(1)
  })

  it('R/8 seed survives the Math.max(0.01) floor for a sane tool (R=2 -> 0.25 > 0.01)', () => {
    // The seeding effect sets passes.stockToLeave = R/8; the emit helper floors at
    // 0.01. For R=2 the seed (0.25) is well above the floor, so the floor is a
    // no-op and the user's tool-relative default flows through unchanged.
    const seeded = { stockToLeave: 2 / 8, finishPasses: 1 }
    const p = contourPassParamsForMode('roughing_only', seeded)
    expect(p.stockToLeave).toBe(0.25)
  })
})

describe('NEW contour seeds tool-relative pass defaults (stockToLeave=R/8, overlap=R)', () => {
  // A 4 mm flat end mill: R = 2 -> stockToLeave = R/8 = 0.25, overlapMm = R = 2.
  const TOOL_ID = 'tool-seed-test'
  const seedTool = () => {
    act(() => {
      const st = useCamStore.getState()
      if (!st.toolLibrary.some(t => t.id === TOOL_ID)) {
        st.addTool({
          id: TOOL_ID, name: 'Seed 4mm Flat', type: 'flat_end_mill',
          diameter: 4, fluteLength: 20, shankDiameter: 6, overallLength: 50,
          numberOfFlutes: 2, material: 'carbide', coating: 'none',
          notes: '', feedsAndSpeeds: {},
        } as unknown as Parameters<typeof st.addTool>[0])
      }
    })
  }

  // Read the numeric <input> that belongs to a NumberField with the given label.
  // Structure: .op-field-row > .op-field-label(label) + .op-field-right > .. input
  function fieldInput(label: string): HTMLInputElement {
    const labelEl = screen.getByText(label)
    const row = labelEl.closest('.op-field-row')
    if (!row) throw new Error(`no .op-field-row for "${label}"`)
    // NumericInput now renders type="text" inputMode="decimal" (type="number"
    // silently no-ops select-on-focus). Query by inputmode, not the old type.
    const input = row.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null
    if (!input) throw new Error(`no numeric input for "${label}"`)
    return input
  }

  it('clicking a 4mm tool then opening Passes seeds stockToLeave=0.25 and overlap=2', () => {
    seedTool()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })

    // Pick the tool (new op defaults to contour_2d). Tool tab -> click the tool.
    fireEvent.click(screen.getByText('Tool'))
    act(() => { fireEvent.click(screen.getByText('Seed 4mm Flat')) })

    // Passes tab. Contour overlap moved behind the collapsed "Advanced"
    // DisclosureSection (clutter P6) - expand it, then assert it = R = 2.
    fireEvent.click(screen.getByText('Passes'))
    fireEvent.click(screen.getByTestId('disclosure-passes-advanced'))
    expect(Number(fieldInput('Contour overlap').value)).toBeCloseTo(2, 5)

    // Stock to leave is hidden in cut_at_geometry; switch to roughing_only to
    // reveal the seeded field, then assert it = R/8 = 0.25. (A tool is selected,
    // so the R/8 seed is non-zero and the roughing-strategy 0.3 seed does NOT
    // stomp it.)
    const sel = screen.getByTestId('contour-cutting-strategy') as HTMLSelectElement
    act(() => { fireEvent.change(sel, { target: { value: 'roughing_only' } }) })
    expect(Number(fieldInput('Stock to Leave - Radial').value)).toBeCloseTo(0.25, 5)

    act(() => { useCamStore.getState().closeModal() })
  })
})

// ── PHANTOM-DEFAULT REGRESSION LOCK ──────────────────────────────────────────
// The contour radial input once rendered value={passes.stockToLeave || 0.3}. The
// `|| 0.3` was display-only and never written to state, so the box LIED: it showed
// 0.3 while state was 0. This locks "the displayed value EQUALS state" so the
// phantom fallback can never come back.
describe('Stock to Leave - Radial: displayed value equals state (phantom-default lock)', () => {
  // Read the numeric <input> for a NumberField by its label.
  function fieldInput(label: string): HTMLInputElement {
    const labelEl = screen.getByText(label)
    const row = labelEl.closest('.op-field-row')
    if (!row) throw new Error(`no .op-field-row for "${label}"`)
    // NumericInput now renders type="text" inputMode="decimal" (type="number"
    // silently no-ops select-on-focus). Query by inputmode, not the old type.
    const input = row.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null
    if (!input) throw new Error(`no numeric input for "${label}"`)
    return input
  }

  it('roughing strategy seeds a REAL 0.3 (no tool), and typing 0 shows 0 (not 0.3)', () => {
    // No tool selected -> the R/8 tool seed no-ops, so state stockToLeave starts 0.
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Passes'))

    const sel = screen.getByTestId('contour-cutting-strategy') as HTMLSelectElement
    // Switch to a roughing strategy: requirement-3 seed writes a REAL 0.3 into
    // state (not a display fallback). The box must show 0.3 because STATE is 0.3.
    act(() => { fireEvent.change(sel, { target: { value: 'roughing_only' } }) })
    const radial = fieldInput('Stock to Leave - Radial')
    expect(radial.value).toBe('0.3')

    // Now type 0 and commit. State becomes 0; the box MUST show 0. With the old
    // `|| 0.3` phantom the box would snap back to "0.3" even though state is 0.
    act(() => {
      fireEvent.focus(radial)
      fireEvent.change(radial, { target: { value: '0' } })
      fireEvent.blur(radial)
    })
    expect(radial.value).toBe('0')

    act(() => { useCamStore.getState().closeModal() })
  })
})

// ── STANDARDIZED STOCK-TO-LEAVE CONTROLS ON ALL FOUR FLOOR OPS ────────────────
// contour / pocket / adaptive / face each expose BOTH "Stock to Leave - Radial"
// and "Stock to Leave - Axial" under a consistent "Stock to leave" section.
describe('Standardized Stock to Leave - Radial + Axial render on all four floor ops', () => {
  function openOpPasses(typeName: string) {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    act(() => { fireEvent.click(screen.getByText(typeName)) })  // Type tab card
    fireEvent.click(screen.getByText('Passes'))
  }

  it('2D Pocket Passes shows both standardized controls', () => {
    openOpPasses('2D Pocket')
    expect(screen.queryByText('Stock to Leave - Radial')).not.toBeNull()
    expect(screen.queryByText('Stock to Leave - Axial')).not.toBeNull()
    act(() => { useCamStore.getState().closeModal() })
  })

  it('2D Adaptive Clearing Passes shows both standardized controls', () => {
    openOpPasses('2D Adaptive Clearing')
    expect(screen.queryByText('Stock to Leave - Radial')).not.toBeNull()
    expect(screen.queryByText('Stock to Leave - Axial')).not.toBeNull()
    const floorFinishLabel = screen.getByText('Floor finish pass')
    const floorFinish = floorFinishLabel.closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(floorFinish.checked).toBe(false)
    fireEvent.click(floorFinish)
    expect(floorFinish.checked).toBe(true)
    act(() => { useCamStore.getState().closeModal() })
  })

  it('2D Face Passes shows both standardized controls', () => {
    openOpPasses('2D Face')
    expect(screen.queryByText('Stock to Leave - Radial')).not.toBeNull()
    expect(screen.queryByText('Stock to Leave - Axial')).not.toBeNull()
    act(() => { useCamStore.getState().closeModal() })
  })

  it('2D Contour Passes shows both standardized controls in a roughing strategy', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })  // defaults to contour
    fireEvent.click(screen.getByText('Passes'))
    // Hidden in cut_at_geometry; revealed once a roughing strategy is chosen.
    expect(screen.queryByText('Stock to Leave - Radial')).toBeNull()
    const sel = screen.getByTestId('contour-cutting-strategy') as HTMLSelectElement
    act(() => { fireEvent.change(sel, { target: { value: 'rough_finish_final' } }) })
    expect(screen.queryByText('Stock to Leave - Radial')).not.toBeNull()
    expect(screen.queryByText('Stock to Leave - Axial')).not.toBeNull()
    act(() => { useCamStore.getState().closeModal() })
  })
})

describe('deriveContourMode (mode-on-load from saved params)', () => {
  it('rough + finish + each_stepdown -> rough_finish_each', () => {
    expect(deriveContourMode({ stockToLeave: 0.3, finishPasses: 1 }, 'each_stepdown')).toBe('rough_finish_each')
  })
  it('rough + finish (final/undefined) -> rough_finish_final', () => {
    expect(deriveContourMode({ stockToLeave: 0.3, finishPasses: 1 }, 'final')).toBe('rough_finish_final')
    expect(deriveContourMode({ stockToLeave: 0.3, finishPasses: 1 }, undefined)).toBe('rough_finish_final')
  })
  it('rough only -> roughing_only', () => {
    expect(deriveContourMode({ stockToLeave: 0.3, finishPasses: 0 })).toBe('roughing_only')
  })
  it('finish only -> cut_at_geometry', () => {
    expect(deriveContourMode({ stockToLeave: 0, finishPasses: 1 })).toBe('cut_at_geometry')
  })
  it('legacy neither set -> cut_at_geometry (safe default)', () => {
    expect(deriveContourMode({ stockToLeave: 0, finishPasses: 0 })).toBe('cut_at_geometry')
    expect(deriveContourMode({})).toBe('cut_at_geometry')
  })
  it('round-trips with contourPassParamsForMode for every mode', () => {
    for (const mode of ['cut_at_geometry', 'roughing_only', 'rough_finish_each', 'rough_finish_final'] as const) {
      const p = contourPassParamsForMode(mode, { stockToLeave: 0.3, finishPasses: 2 })
      expect(deriveContourMode(p, p.contourFinishMode)).toBe(mode)
    }
  })
})

// @vitest-environment jsdom
//
// React-render SMOKE tests for clutter-audit item P12 (duplicates + dead
// controls), per feedback_render_gate_ui_changes (tsc + logic tests miss
// hooks-order and render wiring bugs):
//
//   P12a  Tool editor "Length below holder": the EDITABLE field lives ONLY on
//         the Cutter tab (Dimensions). The General tab's Holder section shows
//         a READ-ONLY reference that reflects live edits to the same draft
//         field (lengthBelowHolder).
//   P12b  TopToolbar Help button had no click handler (dead). Removed.
//   P12c  PostProcessModal "Import Post..." was permanently disabled. Hidden
//         until the feature exists.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store. Test scaffolding
// only (same pattern as the neighboring smoke tests).
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

const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { TopToolbar } = await import('../../components/toolbar/TopToolbar')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

// Every <NumericInput> row in the tool form is: <div.mform-row><label.mform-label>
// LABEL</label><input/></div>. Find the input paired with a given label text.
// Returns null when the row exists but carries no input (the read-only case).
function inputForLabel(label: string): HTMLInputElement | null {
  const labels = Array.from(document.querySelectorAll('.mform-row .mform-label'))
    .filter((el) => el.textContent === label)
  expect(labels.length).toBe(1) // exactly one row with this label per tab
  return labels[0].parentElement!.querySelector('input')
}

describe('P12a: Length below holder is single-sourced in the tool editor', () => {
  beforeEach(() => {
    act(() => {
      const s = useCamStore.getState()
      const libId = s.toolLibraries[0]?.id ?? 'lib-default'
      s.addTool({
        id: crypto.randomUUID(),
        name: 'P12 Smoke Tool',
        type: 'flat_end_mill' as const,
        diameter: 6,
        shankDiameter: 6,
        overallLength: 50,
        fluteLength: 18,
        shoulderLength: 0,
        numberOfFlutes: 2,
        cornerRadius: 0,
        angleFromAxisDeg: 59,
        material: 'carbide' as const,
        coating: 'none' as const,
        toolNumber: 112,
        notes: '',
        libraryId: libId,
        feedsAndSpeeds: {
          default: {
            rpm: 18000, feedRate: 1500, plungeRate: 500, depthOfCut: 1.5,
            stepover: 3, coolant: 'none' as const,
          },
        },
      })
    })
  })

  it('Cutter tab has the ONE editable field; General tab shows a read-only reference that tracks edits', () => {
    render(<ToolLibraryModal />)
    act(() => { useCamStore.getState().openModal('tool-library') })
    expect(screen.getByText('Tool Library')).not.toBeNull()

    // Select the seeded tool so the draft values are known.
    act(() => { fireEvent.click(screen.getByText('P12 Smoke Tool')) })

    // ── Cutter tab (the editor's default tab): the editable field lives here.
    act(() => { fireEvent.click(screen.getByText('Cutter')) })
    const lbhInput = inputForLabel('Length below holder')
    expect(lbhInput).not.toBeNull() // editable NumericInput present
    // No read-only readout on this tab.
    expect(screen.queryByTestId('tool-lbh-readout')).toBeNull()

    // Edit: type 42 and blur to commit (NumericInput commits on blur).
    act(() => {
      fireEvent.focus(lbhInput!)
      fireEvent.change(lbhInput!, { target: { value: '42' } })
      fireEvent.blur(lbhInput!)
    })

    // ── General tab: READ-ONLY reference only — no input in that row, and the
    // readout reflects the live Cutter edit (same draft.lengthBelowHolder).
    act(() => { fireEvent.click(screen.getByText('General')) })
    expect(inputForLabel('Length below holder')).toBeNull() // not editable here
    const readout = screen.getByTestId('tool-lbh-readout')
    expect(readout.tagName).not.toBe('INPUT')
    expect(readout.textContent).toMatch(/^42(\.0+)?\s*(mm|in)$/)

    // Round trip: back on Cutter the input still shows the committed value.
    act(() => { fireEvent.click(screen.getByText('Cutter')) })
    expect(inputForLabel('Length below holder')!.value).toMatch(/^42(\.0+)?$/)

    act(() => { useCamStore.getState().closeModal() })
  })
})

// P12b removed a DEAD Help placeholder; the hitlist rule said the control
// returns ONLY when it opens real documentation. The Help Center shipped
// (HelpCenterModal), so the test now pins the LIVE control: present AND
// actually wired to the help modal - a regression back to a dead button
// (present but opening nothing) fails the wiring assertion.
describe('P12b -> Help Center: TopToolbar Help button is live', () => {
  it('renders a Help control wired to the help modal', () => {
    render(<TopToolbar />)
    // The toolbar itself mounted (anchor: the Post Process button).
    expect(screen.getByText('Post Process')).not.toBeNull()
    const help = screen.getByTestId('toolbar-help')
    expect(help).not.toBeNull()
    act(() => { fireEvent.click(help) })
    expect(useCamStore.getState().activeModal).toBe('help')
    act(() => { useCamStore.getState().closeModal() })
  })
})

describe('P12c: PostProcessModal Import Post button hidden', () => {
  // The modal shows an empty-state guard when the project has no setups; seed
  // one minimal setup so the full body + footer render. (Same scaffolding as
  // PostProcessModalSelectOnFocus.smoke.test.tsx.)
  function seedOneSetup() {
    const wcs = {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    }
    const setup = { id: 'setup-1', name: 'Setup 1', wcs, stock: null, operations: [], notes: '' }
    act(() => {
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
      useCamStore.setState({ project: { ...s.project, setups: [setup] } } as never)
    })
  }

  // P12c hid a permanently-DISABLED Import Post placeholder; INT-11
  // (fa68f3787) later shipped the REAL import flow. The test now pins the
  // live control: present and enabled - a regression back to the disabled
  // placeholder state P12c removed fails the enabled assertion.
  it('footer renders the LIVE Import Post button (INT-11), not a disabled placeholder', () => {
    seedOneSetup()
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })

    // The footer mounted (its live buttons are present)...
    expect(screen.getByText('New / Save Post As...')).not.toBeNull()
    expect(screen.getByText('Cancel')).not.toBeNull()
    // ...and Import Post is a real enabled control, not the old placeholder.
    const importBtn = screen.getByText('Import Post...') as HTMLButtonElement
    expect(importBtn).not.toBeNull()
    expect(importBtn.disabled).toBe(false)

    act(() => { useCamStore.getState().closeModal() })
  })
})

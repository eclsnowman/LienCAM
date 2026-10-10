// @vitest-environment jsdom
//
// React-render SMOKE tests for the clutter-audit Phase 1 DisclosureSections
// (P5 Post Processor modal, P6 New Operation Passes tab, P7 Machine Library
// modal). Mirrors NestModal.smoke.test.tsx.
//
// WHY THIS EXISTS (feedback_render_gate_ui_changes): tsc + the pure-logic
// vitest suite cannot catch hooks-order bugs. Each test below mounts the real
// modal, verifies the disclosure sections render COLLAPSED by default (their
// fields absent, the summary present), then EXPANDS them and asserts the
// fields mount. The collapsed->expanded transition is exactly where a
// misplaced hook would throw "Rendered more hooks than during the previous
// render" - that render surviving is the core regression gate.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { MachineConfig } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). In-memory shim BEFORE the store import
// (same scaffolding as NestModal.smoke.test.tsx). No app change.
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

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

// ── P5: Post Processor modal ─────────────────────────────────────────────────

// The properties form only renders once at least one setup exists.
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

describe('P5 PostProcessModal disclosure sections', () => {
  it('renders all four sections collapsed by default with value summaries; fields absent', () => {
    seedOneSetup()
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })

    // All four disclosure toggles render collapsed (aria-expanded=false).
    for (const id of [
      'disclosure-output-format', 'disclosure-arcs',
      'disclosure-work-offsets', 'disclosure-program-framing',
    ]) {
      const btn = screen.getByTestId(id)
      expect(btn.getAttribute('aria-expanded')).toBe('false')
    }
    // Collapsed = the section fields are NOT mounted...
    expect(screen.queryByText('XYZ decimals')).toBeNull()
    expect(screen.queryByText('Arc tolerance')).toBeNull()
    expect(screen.queryByText('Write offsets via G10 L2')).toBeNull()
    expect(screen.queryByText('Preamble')).toBeNull()
    // ...while at-rest content (post choice, output scope, export) stays.
    expect(screen.getByText('All operations')).not.toBeNull()
    expect(screen.getByText('Output scope')).not.toBeNull()
    // Arcs summary carries live values (defaults: IJK center mode).
    expect(screen.getByTestId('disclosure-arcs').textContent).toContain('IJK')
  })

  it('expanding each section mounts its fields without a hooks-order crash', () => {
    seedOneSetup()
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })

    fireEvent.click(screen.getByTestId('disclosure-output-format'))
    expect(screen.getByText('XYZ decimals')).not.toBeNull()

    fireEvent.click(screen.getByTestId('disclosure-arcs'))
    expect(screen.getByText('Emit arcs (G2/G3)')).not.toBeNull()

    fireEvent.click(screen.getByTestId('disclosure-work-offsets'))
    expect(screen.getByText('Write offsets via G10 L2')).not.toBeNull()

    fireEvent.click(screen.getByTestId('disclosure-program-framing'))
    expect(screen.getByText('Preamble')).not.toBeNull()
    expect(screen.getByText('Postamble')).not.toBeNull()

    // Collapse one again (expanded->collapsed transition also hook-stable).
    fireEvent.click(screen.getByTestId('disclosure-output-format'))
    expect(screen.queryByText('XYZ decimals')).toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })
})

// ── P7: Machine Library modal ────────────────────────────────────────────────

function mkMachine(id: string, name = id): MachineConfig {
  return {
    id, name, type: 'gantry_router', controller: 'grbl',
    travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
  }
}

describe('P7 MachineLibraryModal disclosure sections', () => {
  beforeEach(() => {
    act(() => {
      useCamStore.setState((s) => ({
        machineLibrary: [mkMachine('m1', 'Test Router')],
        appSettings: { ...s.appSettings, defaultMachineId: null },
      }))
    })
  })

  it('General stays at rest; the five sections render collapsed with live summaries', () => {
    render(<MachineLibraryModal />)
    act(() => { useCamStore.getState().openModal('machine-config') })

    // General fields at rest.
    expect(screen.getByText('Name')).not.toBeNull()
    expect(screen.getByText('Controller')).not.toBeNull()

    for (const id of [
      'disclosure-machine-travel', 'disclosure-machine-spindle',
      'disclosure-machine-feeds', 'disclosure-machine-axis-limits',
      'disclosure-machine-notes',
    ]) {
      expect(screen.getByTestId(id).getAttribute('aria-expanded')).toBe('false')
    }
    // Collapsed fields absent.
    expect(screen.queryByText('Max RPM')).toBeNull()
    expect(screen.queryByText('Tool changer')).toBeNull()
    // Live value summaries on the collapsed headers.
    expect(screen.getByTestId('disclosure-machine-travel').textContent).toContain('800 / 600 / 100')
    expect(screen.getByTestId('disclosure-machine-spindle').textContent).toContain('24000 / 8000 / CW (M3)')
  })

  it('expanding mounts the fields without a hooks-order crash', () => {
    render(<MachineLibraryModal />)
    act(() => { useCamStore.getState().openModal('machine-config') })

    fireEvent.click(screen.getByTestId('disclosure-machine-travel'))
    expect(screen.getByText('X')).not.toBeNull()

    fireEvent.click(screen.getByTestId('disclosure-machine-spindle'))
    expect(screen.getByText('Max RPM')).not.toBeNull()

    fireEvent.click(screen.getByTestId('disclosure-machine-feeds'))
    expect(screen.getByText('Tool changer')).not.toBeNull()

    fireEvent.click(screen.getByTestId('disclosure-machine-axis-limits'))
    expect(screen.getByText('Max Cutting')).not.toBeNull()

    fireEvent.click(screen.getByTestId('disclosure-machine-notes'))
    expect(screen.getByPlaceholderText(/Machine notes/i)).not.toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })
})

// ── P6: New Operation modal, Passes tab "Advanced" ───────────────────────────

describe('P6 NewOperationModal Passes tab Advanced disclosure', () => {
  beforeEach(() => {
    // Seed the setup AND point activeSetupId at it unconditionally: the P5
    // seed above replaced project.setups, so a stale activeSetupId would make
    // the modal render null (store is a process singleton across describes).
    act(() => {
      const wcs = {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      }
      const setup = {
        id: 'setup-test', name: 'Test Setup', wcs,
        stock: { type: 'auto' }, operations: [], notes: '',
      }
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
      useCamStore.setState({
        project: { ...s.project, setups: [setup], activeSetupId: 'setup-test' },
      } as never)
    })
  })

  it('pocket: core fields at rest, Advanced collapsed with the group summary', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    act(() => { fireEvent.click(screen.getByText('2D Pocket')) })
    fireEvent.click(screen.getByText('Passes'))

    // Core fields at rest (approved P6 after-shot layout).
    expect(screen.queryByText('Stepdown')).not.toBeNull()
    expect(screen.queryByText('Stepover')).not.toBeNull()
    expect(screen.queryByText('Stock to Leave - Radial')).not.toBeNull()
    expect(screen.queryByText('Stock to Leave - Axial')).not.toBeNull()

    // Advanced collapsed: its groups are NOT mounted; the summary names them.
    const adv = screen.getByTestId('disclosure-passes-advanced')
    expect(adv.getAttribute('aria-expanded')).toBe('false')
    expect(adv.textContent).toContain('fill strategy')
    expect(screen.queryByText('Fill strategy')).toBeNull()
    expect(screen.queryByText('Ring overlap')).toBeNull()
    expect(screen.queryByText('Multiple pocket order')).toBeNull()
    expect(screen.queryByText('Finish contour pass on pocket wall')).toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })

  it('pocket: expanding Advanced mounts the moved groups; fields still work', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    act(() => { fireEvent.click(screen.getByText('2D Pocket')) })
    fireEvent.click(screen.getByText('Passes'))

    fireEvent.click(screen.getByTestId('disclosure-passes-advanced'))
    expect(screen.getByText('Fill strategy')).not.toBeNull()
    expect(screen.getByText('Ring overlap')).not.toBeNull()
    expect(screen.getByText('Multiple pocket order')).not.toBeNull()
    expect(screen.getByText('Finish contour pass on pocket wall')).not.toBeNull()

    // A field inside Advanced still drives state: toggling finish contour
    // reveals its conditional fields (behavior unchanged, placement only).
    const finish = screen.getByText('Finish contour pass on pocket wall')
      .closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement
    const wasChecked = finish.checked
    fireEvent.click(finish)
    if (!wasChecked) expect(screen.getByText('Finish passes')).not.toBeNull()

    // Collapse again - conditional children unmount cleanly.
    fireEvent.click(screen.getByTestId('disclosure-passes-advanced'))
    expect(screen.queryByText('Fill strategy')).toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })

  it('contour (default op): Advanced holds spring passes + contour overlap', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Passes'))

    // At rest: stepdown + strategy select; spring/overlap collapsed away.
    expect(screen.getByTestId('contour-cutting-strategy')).not.toBeNull()
    expect(screen.queryByText('Spring passes')).toBeNull()
    expect(screen.queryByText('Contour overlap')).toBeNull()

    fireEvent.click(screen.getByTestId('disclosure-passes-advanced'))
    expect(screen.getByText('Spring passes')).not.toBeNull()
    expect(screen.getByText('Contour overlap')).not.toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })

  it('re-opening the modal starts Advanced collapsed again (no persistence)', () => {
    render(<NewOperationModal />)
    for (let i = 0; i < 2; i++) {
      act(() => { useCamStore.getState().openModal('new-operation') })
      fireEvent.click(screen.getByText('Passes'))
      const adv = screen.getByTestId('disclosure-passes-advanced')
      expect(adv.getAttribute('aria-expanded')).toBe('false')
      fireEvent.click(adv)
      expect(adv.getAttribute('aria-expanded')).toBe('true')
      act(() => { useCamStore.getState().closeModal() })
    }
  })
})

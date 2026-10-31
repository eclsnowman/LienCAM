// @vitest-environment jsdom
//
// WO-1182 - THE CLUTTER CENSUS. Operator, 2026-09-03, at the machine: "You keep
// adding text in fields all over my clean UI. [...] Stop it from happening
// again in the future." This test is the "again": it renders every dialog and
// the Control surfaces through their real components, counts the nodes that
// are neither a label, a value nor a button (hint / helper / note / banner
// classes) plus the disabled-with-a-reason controls, and pins every count at
// the post-sweep number. Adding one turns this red. The fix is to delete the
// addition, never to raise the pin (UI-ARCHITECTURE s14, COHESION-STANDARD
// s13.1). It counts the LIVE DOM, not source text - a hint authored through a
// new class name still has to render into one of these classes to be styled
// as a hint, and a disabled control still has to carry its reason attribute.
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's localStorage is broken under vitest's node launch flags and the store
// persists on every set(). Same shim as the other modal smoke tests.
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
const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { SetupModal } = await import('../../components/modals/SetupModal')
const { OffsetsPanel } = await import('../../components/machine/OffsetsPanel')
const { OffsetsWorkspace } = await import('../../components/machine/OffsetsWorkspace')
const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { useCamStore, controlMachine } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { AVAILABLE_LANGUAGES, machineTranslationNote } = await import('../../i18n')

/** Every class the product styles as text-that-is-not-a-label-value-or-button. */
const HINT_SELECTOR = [
  '.op-hint', '.mform-help', '.mform-hint', '.op-type-desc', '.nest-hint',
  '.control-homed-hint', '.control-actions-hint', '.wcs-snap-hint',
  '.control-offsets-legend', '.control-offset-retained', '.profile-preview-help',
  '.probe-routine-picker-help', '.pendant-simulator-note', '.scope-empty-note',
  '.scope-conflict-note', '.props-nest-hint', '.sketch-confirm-hint',
  '.multibody-import-option-desc', '.control-offset-workspace-subtitle',
  '[role="note"]', '.control-transfer-lines', '.control-transfer-note',
].join(',')
const DISABLED_WITH_REASON = 'button[disabled][title], button[disabled][data-tooltip]'

function census(): { hints: number; disabled: number } {
  return {
    hints: document.body.querySelectorAll(HINT_SELECTOR).length,
    disabled: document.body.querySelectorAll(DISABLED_WITH_REASON).length,
  }
}

/** THE PIN. Post-WO-1182 numbers; every entry is a surface the operator sees.
 *  Raising a number here is the defect this file exists to catch. */
const PINNED: Record<string, { hints: number; disabled: number }> = {
  // WO-3317 (Operator answer, 2026-10-29 12:08 PM CT MC card: "Keep the hints, update the
  // test (recommended)"): the hints below are the authored ones from WO-3086 (4fd05db640:
  // the op-create reason, Post Process Expand disabled), WO-3103 (3a128bee16: the
  // heights-explained details and Reference planes), WO-3256 (063acb833f), WO-3257
  // (509745d10a: remappable CAM shortcut hints) and WO-3259 (3171065174: Settings hints).
  // The numbers are raised to what those approved landings render; the census still fails
  // on the NEXT unasked hint, which is the whole point of the file.
  'modal:settings': { hints: 6, disabled: 0 },
  'modal:post-process': { hints: 1, disabled: 3 },
  'modal:setup': { hints: 1, disabled: 0 },
  'operation:2d-contour': { hints: 15, disabled: 7 },
  'operation:2d-pocket': { hints: 16, disabled: 7 },
  'operation:drill': { hints: 15, disabled: 7 },
  'operation:bore': { hints: 15, disabled: 7 },
  'operation:2d-chamfer': { hints: 15, disabled: 7 },
  'operation:2d-face': { hints: 15, disabled: 7 },
  'operation:engrave-trace': { hints: 15, disabled: 7 },
  // WO-3250 (5b6790a0de) added the Slot (centerline) card as a new surface. Pinned at
  // creation, like every other new surface in this table.
  'operation:slot-centerline': { hints: 16, disabled: 7 },
  'operation:v-carve': { hints: 14, disabled: 6 },
  'operation:2d-adaptive-clearing': { hints: 16, disabled: 7 },
  'operation:thread-mill': { hints: 17, disabled: 6 },
  'operation:parallel-finish-3d': { hints: 14, disabled: 6 },
  'operation:waterline-finish-3d': { hints: 14, disabled: 6 },
  'operation:scallop-finish-3d': { hints: 14, disabled: 6 },
  'operation:pencil-cleanup-3d': { hints: 14, disabled: 6 },
  'operation:steep-and-shallow-3d': { hints: 14, disabled: 6 },
  'operation:adaptive-rough-3d': { hints: 15, disabled: 6 },
  'operation:operator-stop': { hints: 0, disabled: 0 },
  'operation:run-macro': { hints: 1, disabled: 1 },
  'control:offsets-panel': { hints: 0, disabled: 0 },
  'control:offsets-workspace': { hints: 1, disabled: 6 },
  // +1 disabled: the JOG header's gamepad step toggle (owner ask 2026-10-30: "an icon next to the jog wording up in its title bar"); disabled with its reason until a deadman is mapped.
  'control:probing': { hints: 0, disabled: 12 },
}

function ensureSetup(): void {
  const st = useCamStore.getState()
  if (st.project.setups.length === 0) {
    st.addSetup({
      id: 'setup-census', name: 'Census setup',
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
}

afterEach(() => {
  act(() => { useCamStore.getState().closeModal() })
  cleanup()
})

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

describe('WO-1182 clutter census - every surface stays at its post-sweep count', () => {
  const actual: Record<string, { hints: number; disabled: number }> = {}

  it('modals: Settings, Post Process, Setup', () => {
    ensureSetup()
    for (const [id, name, Component] of [
      ['settings', 'modal:settings', SettingsModal],
      ['post-process', 'modal:post-process', PostProcessModal],
      ['new-setup', 'modal:setup', SetupModal],
    ] as const) {
      render(<Component />)
      act(() => { useCamStore.getState().openModal(id) })
      actual[name] = census()
      if (name === 'modal:settings') {
        // WO-2977: WO-2329's machine-translation note (operator ruling 2026-10-01: a pilot language ships
        // "machine-translated and labelled 'corrections welcome'") is ordered text, one per such
        // language and nothing else. It is pinned to that list here; every other hint stays at the pin.
        const notes = document.body.querySelectorAll('[data-testid^="settings-language-note-"]')
        expect(notes.length).toBe(AVAILABLE_LANGUAGES.filter(code => machineTranslationNote(code) !== null).length)
        expect([...notes].every(n => n.matches(HINT_SELECTOR))).toBe(true)
        actual[name] = { ...actual[name], hints: actual[name].hints - notes.length }
      }
      act(() => { useCamStore.getState().closeModal() })
      cleanup()
    }
  })

  it('the operation dialog: every type, every tab', () => {
    ensureSetup()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    const cards = () => Array.from(document.body.querySelectorAll<HTMLElement>('.op-type-card'))
    const count = cards().length
    expect(count).toBeGreaterThan(10)
    for (let i = 0; i < count; i++) {
      const card = cards()[i]
      const name = `operation:${slug(card.querySelector('.op-type-name')?.textContent ?? `type-${i}`)}`
      fireEvent.click(card)
      const totals = { hints: 0, disabled: 0 }
      const tabs = () => Array.from(document.body.querySelectorAll<HTMLElement>('.op-modal-tab'))
      for (let t = 0; t < tabs().length; t++) {
        fireEvent.click(tabs()[t])
        const c = census()
        totals.hints += c.hints
        totals.disabled += c.disabled
      }
      actual[name] = totals
      fireEvent.click(tabs()[0])
    }
  })

  it('Control: the offsets card, the offsets workspace and the probing tab', () => {
    const machineId = controlMachine(useCamStore.getState()).id
    act(() => {
      useMachineControl.setState({
        connectionPhase: 'connected', machineState: 'idle', activeWcs: 'G54',
        offsets: { G54: [1, 2, 3] },
      })
      useCamStore.getState().setMachineWorkOffset(machineId, 'G54', { x: 1, y: 2, z: 3 }, 'sent')
    })
    render(<OffsetsPanel />)
    actual['control:offsets-panel'] = census()
    cleanup()
    render(<OffsetsWorkspace machineId={machineId} machineName="Census machine" />)
    actual['control:offsets-workspace'] = census()
    cleanup()
    render(<ProbingPanel />)
    actual['control:probing'] = census()
  })

  it('pins every surface at its post-sweep count (delete the addition, never raise the pin)', () => {
    const table = Object.entries(actual)
      .map(([name, c]) => `  '${name}': { hints: ${c.hints}, disabled: ${c.disabled} },`)
      .join('\n')
    expect(actual, `\nACTUAL CENSUS:\n${table}\n`).toEqual(PINNED)
  })
})

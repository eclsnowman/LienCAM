// @vitest-environment jsdom
//
// MACHINE-CONTROL: Work offsets panel collapse behavior (Operator 2026-07-31) -
// collapsed by DEFAULT to the active system's row so the left column keeps
// the safety cluster and tool table in view; the chevron expands to the full
// six-system table with the WCS selector chips.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

const { OffsetsPanel } = await import('../../components/machine/OffsetsPanel')
const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { setWorkOffsetValue, WORK_OFFSET_WRITE_BUSY } = await import('../../lib/machine/machineSession')

type OffsetReceipt = { ok: boolean; reason: string | null; offset: { x: number; y: number; z: number } | null }

/** Take the machine's single offset-write slot for real - through the session,
 *  not by poking a flag - and hand back the way to land its receipt. */
async function heldOffsetWrite(): Promise<() => Promise<void>> {
  let settle!: (receipt: OffsetReceipt) => void
  const controller = {
    setWorkOffset: () => new Promise<OffsetReceipt>((resolve) => { settle = resolve }),
    refreshState: () => {},
  }
  // The axes of one synchronous pass join one intent, so the send is on the
  // microtask that closes the pass - the SLOT is taken synchronously.
  await act(async () => {
    expect(setWorkOffsetValue('G55', 'X', 12, controller as never)).toBe(true)
    await Promise.resolve()
  })
  return async () => {
    await act(async () => {
      settle({ ok: true, reason: null, offset: { x: 12, y: 5, z: -50 } })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

beforeEach(() => {
  useCamStore.setState({ machineWorkOffsets: {} })
  useUiPrefs.setState({ machineOffsetsCollapsed: true })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G55',
    offsets: { G54: [1, 2, 3], G55: [4, 5, -50] },
  })
})

afterEach(() => cleanup())

describe('OffsetsPanel collapse', () => {
  it('collapsed by default: only the ACTIVE system row, no chips, no meta', () => {
    render(<OffsetsPanel />)
    const table = screen.getByTestId('control-offsets-table')
    expect(table.textContent).toContain('G55')
    expect(table.textContent).not.toContain('G54')
    expect(screen.queryByTestId('control-wcs-g54')).toBeNull() // chips hidden
    expect(screen.getByTestId('control-offset-g55-z')).toBeTruthy() // still editable
    expect(screen.queryByText(/TLO/)).toBeNull()
    expect(screen.queryByTestId('control-offsets-legend')).toBeNull()
  })

  it('WO-1182: one number per axis - the controller value, editable; no PC value, no legend, no sentence', () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(machineId, 'G55', { x: 9 }, 'sent')
    render(<OffsetsPanel />)

    const input = screen.getByTestId('control-offset-g55-x') as HTMLInputElement
    expect(input.disabled).toBe(false)
    expect(input.className).toContain('control-offset-input')
    expect(screen.queryByTestId('control-offset-stored-g55-x')).toBeNull()
    expect(screen.queryByTestId('control-offsets-legend')).toBeNull()
    expect(screen.getByTestId('control-offsets-table').textContent).not.toContain('PC')
    const pair = input.closest('[data-offset-value-pair]')
    expect(pair?.hasAttribute('data-wired')).toBe(true)
    expect(pair?.getAttribute('data-tooltip')).toBeNull()
  })

  it('chevron expands to all six systems and collapses back', () => {
    render(<OffsetsPanel />)
    fireEvent.click(screen.getByTestId('control-offsets-toggle'))
    expect(useUiPrefs.getState().machineOffsetsCollapsed).toBe(false)
    const table = screen.getByTestId('control-offsets-table')
    for (const wcs of ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']) {
      expect(table.textContent).toContain(wcs)
      expect(screen.getByTestId(`control-wcs-${wcs.toLowerCase()}`)).toBeTruthy()
    }
    fireEvent.click(screen.getByTestId('control-offsets-toggle'))
    expect(screen.queryByTestId('control-wcs-g54')).toBeNull()
  })

  it('collapsed with no reported WCS yet shows a plain placeholder row', () => {
    act(() => useMachineControl.setState({ activeWcs: null }))
    render(<OffsetsPanel />)
    expect(screen.getByTestId('control-offsets-table').textContent).toContain('WCS?')
  })

  it('shows the established-value states as the existing provenance marker only - never a sentence', () => {
    const machineId = useCamStore.getState().project.machine.id
    render(<OffsetsPanel />)

    const cases = [
      ['sent', 'data-wired'],
      ['not-sent', 'data-not-sent'],
      ['bridge-differs', 'data-not-applied'],
      ['adopted-from-profile', 'data-not-sent'],
    ] as const
    for (const [state, marker] of cases) {
      act(() => {
        useCamStore.getState().setMachineWorkOffset(machineId, 'G55', { x: 9 }, state)
      })
      const pair = screen.getByTestId('control-offset-g55-x').closest('[data-offset-value-pair]')
      expect(pair?.hasAttribute(marker)).toBe(true)
      expect(pair?.getAttribute('data-tooltip')).toBeNull()
      expect(pair?.textContent).not.toContain('PC')
    }
  })

  it('shows an empty unknown state on the existing WCS label', () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.getState().setMachineWorkOffset(machineId, 'G55', {}, 'unknown')
    render(<OffsetsPanel />)

    const label = screen.getByText('G55')
    expect(label.hasAttribute('data-not-applied')).toBe(true)
    expect(label.getAttribute('data-tooltip')).toBeNull()
    expect(screen.queryByTestId('control-offset-stored-g55-x')).toBeNull()
  })

  it('marks only the active WCS in the DRO header', () => {
    const machineId = useCamStore.getState().project.machine.id
    act(() => {
      useCamStore.getState().setMachineWorkOffset(machineId, 'G54', { x: 1 }, 'bridge-differs')
      useCamStore.getState().setMachineWorkOffset(machineId, 'G55', { x: 2 }, 'not-sent')
    })
    render(<ControlPage />)

    const marker = screen.getByTestId('control-active-wcs')
    expect(marker.hasAttribute('data-not-sent')).toBe(true)
    expect(marker.hasAttribute('data-not-applied')).toBe(false)

    act(() => useMachineControl.setState({ activeWcs: 'G54' }))
    expect(marker.hasAttribute('data-not-sent')).toBe(false)
    expect(marker.hasAttribute('data-not-applied')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// WO-1042: ONE in-flight offset write per machine. The session refuses a second
// one, so a live control that could only produce a console refusal is the
// defect - every offset control goes dead until the receipt lands.
// ---------------------------------------------------------------------------
describe('WO-1042: offset controls while a write is in flight', () => {
  it('the offset cells go dead, aria-disabled, and say why', async () => {
    render(<OffsetsPanel />)
    expect((screen.getByTestId('control-offset-g55-x') as HTMLInputElement).disabled).toBe(false)

    const land = await heldOffsetWrite()
    const cell = screen.getByTestId('control-offset-g55-x') as HTMLInputElement
    expect(cell.disabled).toBe(true)
    expect(cell.parentElement?.getAttribute('aria-disabled')).toBe('true')
    expect(cell.parentElement?.getAttribute('data-tooltip')).toBe(WORK_OFFSET_WRITE_BUSY)
    expect(WORK_OFFSET_WRITE_BUSY).toContain('waiting for the bridge to confirm')

    await land()
    expect((screen.getByTestId('control-offset-g55-x') as HTMLInputElement).disabled).toBe(false)
  })

  it('the DRO zero chips and Zero all go dead too - the slot is one per machine', async () => {
    render(<ControlPage />)
    const zeroX = () => screen.getByTestId('control-zero-x') as HTMLButtonElement
    const zeroAll = () => screen.getByTestId('control-zero-all') as HTMLButtonElement
    expect(zeroX().disabled).toBe(false)
    expect(zeroAll().disabled).toBe(false)

    const land = await heldOffsetWrite()
    expect(zeroX().disabled).toBe(true)
    expect(zeroX().getAttribute('aria-disabled')).toBe('true')
    expect(zeroX().getAttribute('data-tooltip')).toBe(WORK_OFFSET_WRITE_BUSY)
    expect(zeroAll().disabled).toBe(true)
    expect(zeroAll().getAttribute('aria-disabled')).toBe('true')

    await land()
    expect(zeroX().disabled).toBe(false)
    expect(zeroAll().disabled).toBe(false)
  })
})

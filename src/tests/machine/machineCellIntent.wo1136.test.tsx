// @vitest-environment jsdom
//
// WO-1136: one machine cell has two deliberate jobs. Its own placeholder and
// native title must name the job selected by the value the operator sees.

import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  // CNCViewport has private members, so a jsdom stub cannot be structurally
  // assignable to its constructor type. The export key remains checked here.
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  } as never,
}))

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => Array.from(mem.keys())[index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } satisfies Storage,
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')

function machineDro(axis: 'x' | 'y' | 'z'): HTMLInputElement {
  return screen.getByTestId(`control-dro-machine-${axis}`) as HTMLInputElement
}

function commit(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(async () => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  useUiPrefs.setState({ machineGotoSkipConfirm: false })
  useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  await vi.advanceTimersByTimeAsync(1400)
})

afterEach(async () => {
  cleanup()
  act(() => { getMachineController().emergencyStop() })
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  vi.useRealTimers()
})

it('names the live set-or-move job in the cell and records one datum set', async () => {
  const view = render(<ControlPage />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1400) })

  const dashed = machineDro('x')
  expect(dashed.value).toBe('---')
  expect(dashed.placeholder).toBe('Typing sets X position.')
  expect(dashed.title).toBe('Typing sets X position.')
  expect(dashed.dataset.tooltip).toBe('Typing sets X position.')

  // WO-2712: datum entry and the later move sit inside the sample's
  // stated X -406..0 frame; precision and SET-to-MOVE intent stay identical.
  commit(dashed, '-123.456')
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })

  const numbered = machineDro('x')
  expect(numbered.value).toBe('-123.46')
  expect(numbered.placeholder).toBe('Typing moves X to this coordinate.')
  expect(numbered.title).toBe('Typing moves X to this coordinate.')
  expect(numbered.dataset.tooltip).toBe('Typing moves X to this coordinate.')
  expect(useMachineControl.getState().consoleLines.filter((line) =>
    line.text === 'Set X machine position to -123.46 mm.',
  )).toHaveLength(1)

  // NumCell keys its input by the shown coordinate. A normal move therefore
  // replaces the input without changing the live MOVE intent; the replacement
  // must retain both operator-facing affordances.
  useUiPrefs.setState({ machineGotoSkipConfirm: true })
  commit(numbered, '-130.000')
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })

  const moved = machineDro('x')
  expect(moved.value).toBe('-130.00')
  expect(moved.title).toBe('Typing moves X to this coordinate.')
  expect(moved.dataset.tooltip).toBe('Typing moves X to this coordinate.')

  // Console recording belongs to the datum commit, not the render path.
  for (let pass = 0; pass < 10; pass += 1) view.rerender(<ControlPage />)
  expect(useMachineControl.getState().consoleLines.filter((line) =>
    line.text === 'Set X machine position to -123.46 mm.',
  )).toHaveLength(1)
})

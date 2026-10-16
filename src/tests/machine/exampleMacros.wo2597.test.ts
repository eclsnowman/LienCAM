// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (i: number) => Array.from(memory.keys())[i] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
} })

const { EXAMPLE_MACHINES, createExampleMachine } = await import('../../lib/machine/exampleMachines')
const { createSampleMachine } = await import('../../lib/machine/sampleMachine')
const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { MacroEditor } = await import('../../components/machine/MacroEditor')
const { connectMachine, disconnectMachine, getMachineController, sendMdiLine,
  __resetEstopInterlockForTest, setWorkOffsetValue } = await import('../../lib/machine/machineSession')
const { activeMacroAsk, answerMacroAsk, activeMacroRun, checkMacroBody,
  boundMacro, __resetMacroRuntimeForTest } = await import('../../lib/machine/macros/macroRuntime')

const names = ['Example - Part swap', 'Example - Spindle warm-up', 'Example - Part trace']
const ids = ['example-part-swap', 'example-spindle-warm-up', 'example-part-trace']
const consoleText = () => useMachineControl.getState().consoleLines.map(row => row.text).join('\n')

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
})
afterEach(async () => {
  cleanup()
  __resetMacroRuntimeForTest()
  const disconnecting = disconnectMachine()
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(100)
  await disconnecting
  vi.useRealTimers()
})

describe('WO-2597 shipped macro content', () => {
  for (const example of EXAMPLE_MACHINES) {
    it(`${example.name} ships the three approved hidden, described, parseable examples`, () => {
      const machine = createExampleMachine(example)
      expect(machine.macros?.map(m => m.name)).toEqual(names)
      expect(machine.macros?.map(m => m.mCode)).toEqual([300, 301, 302])
      for (const macro of machine.macros!) {
        expect(macro.hidden).toBe(true)
        expect(macro.body.split('\n')[0]).toMatch(/^\/\/ .+/)
        expect(checkMacroBody(macro.body)).toMatchObject({ ok: true })
      }
    })

    it(`${example.name} lists examples in the real editor, unchecked and absent from the real panel`, () => {
      useCamStore.getState().setProjectMachine(createExampleMachine(example))
      render(createElement(MacroPanel))
      for (const id of ids) expect(screen.queryByTestId(`control-user-macro-${id}`)).toBeNull()
      render(createElement(MacroEditor, { open: true, onClose: () => {} }))
      for (const id of ids) {
        expect(screen.getByTestId(`macro-editor-item-${id}`)).toBeTruthy()
        fireEvent.click(screen.getByTestId(`macro-editor-item-${id}-edit`))
        expect((screen.getByTestId('macro-editor-shown') as HTMLInputElement).checked).toBe(false)
      }
    })
  }

  it('creates fresh editable macro records without changing the sample or catalog', () => {
    const catalog = structuredClone(EXAMPLE_MACHINES)
    const first = createExampleMachine(EXAMPLE_MACHINES[0])
    const second = createExampleMachine(EXAMPLE_MACHINES[0])
    first.macros![0].hidden = false
    first.macros![0].body = 'changed'
    expect(second.macros![0].hidden).toBe(true)
    expect(second.macros![0].body).not.toBe('changed')
    expect(createSampleMachine().macros).toBeUndefined()
    expect(EXAMPLE_MACHINES).toEqual(catalog)
  })
})

async function answerAll(values: Array<number | null>): Promise<void> {
  for (const value of values) {
    await vi.advanceTimersByTimeAsync(10)
    const ask = activeMacroAsk()
    expect(ask, consoleText()).not.toBeNull()
    // The dialog submits text; the production ask() API parses that text.
    expect(answerMacroAsk(ask!.id, value === null ? null : String(value))).toBe(true)
  }
}

describe('WO-2597 examples through the production MDI route on the desk simulator', () => {
  for (const example of EXAMPLE_MACHINES) {
    it(`${example.name} stays off while hidden and runs all three after the operator shows them`, async () => {
      vi.useFakeTimers()
      const machine = createExampleMachine(example)
      // Explicit desk setup: no claim that these are a manufacturer's home facts.
      machine.homeConvention = {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', machineZeroAt: 'max' },
      }
      useCamStore.getState().setProjectMachine(machine)
      const connecting = connectMachine('simulator', 115200)
      await vi.advanceTimersByTimeAsync(300)
      await connecting
      __resetEstopInterlockForTest()
      const controller = getMachineController()
      controller.home()
      await vi.advanceTimersByTimeAsync(2000)
      for (const axis of ['X', 'Y', 'Z'] as const) {
        setWorkOffsetValue('G54', axis, 0)
        await vi.advanceTimersByTimeAsync(50)
      }
      useMachineControl.getState().clearConsole()
      for (const code of [300, 301, 302]) {
        expect(boundMacro(code)).toBeNull()
        sendMdiLine(`M${code}`)
        await vi.advanceTimersByTimeAsync(10)
        expect(activeMacroRun()).toBeNull()
        expect(activeMacroAsk()).toBeNull()
      }
      expect(consoleText()).toContain('show it on the panel to turn it back on')
      useCamStore.getState().setProjectMachine({ ...machine,
        macros: machine.macros!.map(macro => ({ ...macro, hidden: false })),
      })
      const sent: string[] = []
      const original = controller.sendCommand.bind(controller)
      vi.spyOn(controller, 'sendCommand').mockImplementation(text => {
        sent.push(text)
        return original(text)
      })

      expect(sendMdiLine('M300')).toBe(true)
      const backY = machine.travel.y - 5
      await answerAll([-5, 5, backY])
      await vi.advanceTimersByTimeAsync(30000)
      expect(sent.indexOf('G21 G90 G53 G0 Z-5'), consoleText() + JSON.stringify(sent)).toBeLessThan(sent.indexOf(`G21 G90 G53 G0 X5 Y${backY}`))
      expect(sent).toContain('M0')
      expect(useMachineControl.getState().mpos).toMatchObject({ x: 5, y: backY, z: -5 })
      if (useMachineControl.getState().machineState === 'hold') {
        controller.cycleResume()
        await vi.advanceTimersByTimeAsync(100)
      }
      expect(activeMacroRun(), consoleText()).toBeNull()

      const low = machine.minSpindleRpm ?? 1000
      const high = machine.maxSpindleRpm ?? 6000
      expect(sendMdiLine('M301')).toBe(true)
      await answerAll([low, high])
      await vi.advanceTimersByTimeAsync(100000)
      expect(sent).toEqual(expect.arrayContaining([`M3 S${low}`, `M3 S${(low + high) / 2}`, `M3 S${high}`, 'M5']))
      expect(activeMacroRun(), consoleText()).toBeNull()
      expect(consoleText()).toContain('Spindle warm-up complete.')

      sent.length = 0
      expect(sendMdiLine('M302')).toBe(true)
      await answerAll([-5, 5, 15, 5, 15])
      // Large profiles start at the back park; retain their real rapid rates.
      await vi.advanceTimersByTimeAsync(30000)
      expect(sent, consoleText()).toEqual(['M5', 'G21 G90 G53 G0 Z-5',
        'G21 G90 G0 X5 Y5', 'G21 G90 G0 X15 Y5', 'G21 G90 G0 X15 Y15',
        'G21 G90 G0 X5 Y15', 'G21 G90 G0 X5 Y5'])
      expect(useMachineControl.getState().mpos).toMatchObject({ x: 5, y: 5, z: -5 })
      expect(activeMacroRun(), consoleText()).toBeNull()
      expect(consoleText()).toContain('Part outline traced at clearance height.')
    })
  }
})

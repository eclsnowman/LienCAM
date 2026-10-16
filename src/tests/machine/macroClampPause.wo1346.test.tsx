// @vitest-environment jsdom
//
// WO-1346 - Operator's posted M2001 uses the existing park + clamp flow. The
// compact fixtures drive the complete boundary; his real Fusion file pins the
// production reader's line number and operator wording without simulating a
// 110,000-move cut in a unit test.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  beginClampPause,
  cancelGuidedToolChange,
  connectMachine,
  continueClampPause,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  loadMachineProgram,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const { currentOperatorTransport, executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

type MachineMacro = import('../../types').MachineMacro

const MACHINE_ID = 'wo-1346-machine'
const PARK = { id: 'clamp-park', label: 'Clamp park', x: 8, y: 9 }
/** WO-1743 outcome 2: the import adds no built-in binding of its own, so a
 *  fixture that runs the clamp pause opts into it as its own macro data -
 *  the same record an operator gets by adding this macro in the Macros
 *  panel. M2001 then runs it like any other bound macro. */
const CLAMP_PAUSE_MACRO: MachineMacro = {
  id: 'clamp-pause-m2001', name: 'Clamp pause', mCode: 2001, body: 'clampPause()',
}
const M2001_PROGRAM = [
  'G21 G90 G54',
  'G0 X0 Y0 Z2',
  'M2001',
  'M0',
  'G0 X4 Y0 Z2',
  'M30',
  '',
].join('\n')

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((entry) => entry.text).join('\n')
}

function selectFixtureMachine(): void {
  const machine = useCamStore.getState().project.machine
  // WO-1652: M2001 runs the machine's own "Clamp pause" macro. WO-1743:
  // nothing gives it to a record any more - this fixture carries it itself.
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-1346 fixture',
    // WO-1644: M2001 is a UCCNC user macro (the word table's macro range), so
    // the fixture declares the controller that runs it.
    controller: 'uccnc',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    macros: [CLAMP_PAUSE_MACRO],
    travel: { x: 1000, y: 1000, z: 400 },
    rapidRate: 60000,
    // WO-1702: Safe Z is one field on the machine record - typed here since
    // this fixture has no controller definition to state it in a profile.
    safeZMachine: 5,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 200 },
    },
  })
}

function configurePark(enabled: boolean): void {
  useMachineActions.setState({
    byMachine: enabled
      ? {
          [MACHINE_ID]: {
            overrides: {},
            custom: [],
            parks: [PARK],
            toolChangeParkId: PARK.id,
          },
        }
      : {},
    macroArrangementByMachine: {},
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('WO-1346 M2001 clamp pause', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    selectFixtureMachine()
    configurePark(true)
    const connecting = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connecting
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await advance(2000)
    for (const axis of ['X', 'Y', 'Z'] as const) {
      setWorkOffsetValue('G54', axis, 0)
      await advance(50)
    }
  })

  afterEach(async () => {
    cancelGuidedToolChange()
    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting
    vi.useRealTimers()
  })

  it('parks, answers the clamp job, then holds separately at the adjacent M0', async () => {
    expect(loadGcodeTextToolpathProgram('m2001.nc', M2001_PROGRAM)).toEqual({ ok: true, reason: null })
    expect(consoleText()).toContain(
      'The file calls M2001 on line 3 (this machine\'s macro "Clamp pause") - the program holds there and runs it.',
    )

    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)

    const paused = useMachineControl.getState()
    expect(paused.job.phase).toBe('paused')
    expect(paused.toolChange?.mode).toBe('clampPause')
    expect(paused.toolChange?.step).toBe('awaiting-swap')
    expect(paused.toolChange?.message).toContain('Screw down the material')
    expect(paused.mpos?.x).toBeCloseTo(PARK.x, 1)
    expect(paused.mpos?.y).toBeCloseTo(PARK.y, 1)
    expect(paused.mpos?.z).toBeCloseTo(5, 1)
    expect(consoleText()).toContain(
      '"m2001.nc" reached M2001 on line 3: running this machine\'s macro "Clamp pause".',
    )

    // WO-2773 (Operator 2026-10-13, "A - Continue on both"): the card's Continue is
    // the one door at the parked clamp pause, as on the guided tool-change
    // card; CYCLE START is dark (was live from the WO-2437 fix round).
    expect(currentOperatorTransport()).toMatchObject({ action: 'none', cycleStartEnabled: false })
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(useMachineControl.getState().toolChange).toMatchObject({
      mode: 'clampPause',
      step: 'awaiting-swap',
    })
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(PARK.x, 1)

    expect(continueClampPause()).toBe(true)
    expect(useMachineControl.getState().toolChange).toBeNull()
    await advance(10_000)
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(useMachineControl.getState().toolChange).toBeNull()
    expect(consoleText()).toContain('stopped at the M0 on line 4')
    const held = getMachineController().status().machinePos
    await advance(1000)
    expect(getMachineController().status().machinePos).toEqual(held)
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(4, 1)
  })

  it('does not traverse XY when the geometry controller stops below safe Z', async () => {
    const ctrl = getMachineController()
    Object.defineProperty(ctrl, 'capabilities', {
      configurable: true,
      value: { ...ctrl.capabilities, gcodeText: false },
    })
    vi.spyOn(ctrl, 'jogToMachineZ').mockReturnValue(true)
    const jogToWorkXY = vi.spyOn(ctrl, 'jogToWorkXY')

    expect(loadGcodeTextToolpathProgram('short-retract.nc', M2001_PROGRAM)).toEqual({ ok: true, reason: null })
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)

    expect(jogToWorkXY).not.toHaveBeenCalled()
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(useMachineControl.getState().toolChange).toMatchObject({
      mode: 'clampPause',
      step: 'failed',
    })
    const safeZLines = useMachineControl.getState().consoleLines.filter(({ text }) =>
      text.startsWith('The park stopped because the retract did not reach safe Z'),
    )
    expect(safeZLines).toEqual([expect.objectContaining({
      severity: 'error',
      text:
        'The park stopped because the retract did not reach safe Z at G54 Z 5.00 mm (machine Z 5.00 mm); '
        + 'the tool is at G54 Z 2.00 mm (machine Z 2.00 mm). XY was not commanded.',
    })])

    expect(await executeOperatorCycleStart()).toBe(false)
    expect(jogToWorkXY).not.toHaveBeenCalled()
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(useMachineControl.getState().toolChange).toMatchObject({
      mode: 'clampPause',
      step: 'failed',
    })
  })

  it('keeps an unknown macro on the existing generic hold', async () => {
    const program = M2001_PROGRAM.replace('M2001', 'M2999').replace('M0\n', '')
    expect(loadGcodeTextToolpathProgram('unknown.nc', program)).toEqual({ ok: true, reason: null })
    expect(consoleText()).toContain('a macro this app cannot run (M2999 on line 3)')

    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(5000)
    expect(useMachineControl.getState().toolChange).toBeNull()
    expect(consoleText()).toContain(
      'stopped at the M2999 macro call on line 3, which this app cannot run',
    )
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(5000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
  })

  it('holds with the missing configured park as the reason', async () => {
    configurePark(false)
    expect(loadGcodeTextToolpathProgram('no-park.nc', M2001_PROGRAM)).toEqual({ ok: true, reason: null })
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(5000)

    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(useMachineControl.getState().toolChange).toBeNull()
    expect(consoleText()).toContain('no park macro marked for this; make one in the Macros panel')
    expect(consoleText()).toContain('program stays held')
  })

  it('does not let a disconnected M2001 pause consume the next manual clamp Continue', async () => {
    expect(loadGcodeTextToolpathProgram('m2001-disconnect.nc', M2001_PROGRAM)).toEqual({ ok: true, reason: null })
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')

    const disconnecting = disconnectMachine()
    await advance(100)
    await disconnecting
    expect(useMachineControl.getState().toolChange).toBeNull()

    const reconnecting = connectMachine('simulator', 115200)
    await advance(300)
    await reconnecting
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await advance(2000)
    for (const axis of ['X', 'Y', 'Z'] as const) {
      setWorkOffsetValue('G54', axis, 0)
      await advance(50)
    }

    const ordinary = ['G21', 'G90', ...Array.from({ length: 20 }, (_, i) => `G1 X${i + 1} F60`), 'M30'].join('\n')
    expect(loadMachineProgram('manual-clamp.nc', ordinary).lines).toHaveLength(23)
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(3000)
    expect(useMachineControl.getState().job.phase).toBe('streaming')
    const resumeLine = Math.max(2, useMachineControl.getState().job.ackedSourceLine)
    const began = beginClampPause({ resumeLine, park: PARK, safeZMachine: 5 })
    await advance(20_000)
    expect(await began).toBe(true)
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')

    expect(continueClampPause()).toBe(true)
    expect(useMachineControl.getState().toolChange).toMatchObject({
      mode: 'clampPause',
      step: 'ready',
    })
  })

  it("loads Operator's real Fusion file with M2001 recognized at line 110354", () => {
    const text = readFileSync(
      join(process.cwd(), 'src/tests/fixtures/foreign-gcode/fusion-liencnc-v2-sample.nc'),
      'utf8',
    )
    expect(loadGcodeTextToolpathProgram('fusion-liencnc-v2-sample.nc', text)).toEqual({ ok: true, reason: null })
    expect(consoleText()).toContain(
      'The file calls M2001 on line 110354 (this machine\'s macro "Clamp pause") - the program holds there and runs it.',
    )
  })
})

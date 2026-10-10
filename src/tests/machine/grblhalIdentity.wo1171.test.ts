import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineConfig } from '../../types'
import {
  backendFor,
  controllerDisplayName,
  isGrblFamily,
  resolveDeclaredController,
  UNDECLARED_CONTROLLER_REASON,
} from '../../lib/machine/machineChoice'
import { controllerSurface } from '../../lib/machine/controllerSurface'
import { builtinDefaultLines } from '../../lib/machine/machineActions'
import { checkJobAgainstMachine } from '../../lib/machine/transferCheck'
import { transferCheckJobFromProgram } from '../../lib/machine/programContext'
import {
  controlMachine,
  persistMerge,
  persistMigrate,
  persistPartialize,
  PERSIST_STORE_VERSION,
  useCamStore,
} from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import * as session from '../../lib/machine/machineSession'

const grblhalMachine: MachineConfig = {
  id: 'wo1171-grblhal',
  name: 'grblHAL Router',
  type: 'gantry_router',
  controller: 'grblhal',
  travel: { x: 400, y: 300, z: 80 },
  rapidRate: 5000,
  maxSpindleRpm: 24000,
  minSpindleRpm: 8000,
  spindleDirection: 'cw',
  toolChanger: 'manual',
  coolant: false,
  notes: '',
}

const grblMachine: MachineConfig = { ...grblhalMachine, id: 'wo1171-grbl', controller: 'grbl' }

let previousLibrary: MachineConfig[]
let previousProjectMachine: MachineConfig

beforeEach(() => {
  vi.useFakeTimers()
  previousLibrary = useCamStore.getState().machineLibrary
  previousProjectMachine = useCamStore.getState().project.machine
  useCamStore.setState((state) => ({
    machineLibrary: [...previousLibrary, grblhalMachine],
    project: { ...state.project, machine: grblhalMachine },
    control: { activeMachineId: grblhalMachine.id, sessionMachine: null },
  }))
  useMachineControl.setState({ consoleLines: [], connectionPhase: 'disconnected', connectionKind: null })
})

afterEach(async () => {
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    const pending = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
  }
  useCamStore.setState((state) => ({
    machineLibrary: previousLibrary,
    project: { ...state.project, machine: previousProjectMachine },
    control: { activeMachineId: null, sessionMachine: null },
  }))
  vi.useRealTimers()
})

describe('WO-1171 grblHAL identity and dispatch', () => {
  it('resolves the closed identity, names it, and keeps unknown strings refused', () => {
    expect(resolveDeclaredController(grblhalMachine)).toMatchObject({
      ok: true,
      controller: 'grblhal',
      dialect: { id: 'grblhal', label: 'grblHAL' },
    })
    expect(controllerDisplayName('grblhal')).toBe('grblHAL')
    expect(isGrblFamily('grbl')).toBe(true)
    expect(isGrblFamily('grblhal')).toBe(true)
    expect(isGrblFamily('linuxcnc')).toBe(false)
    expect(backendFor('grbl')).toBe('grbl')
    expect(backendFor('grblhal')).toBe('grbl')
    expect(resolveDeclaredController({ ...grblhalMachine, controller: 'mach4' as never })).toEqual({
      ok: false,
      reason: UNDECLARED_CONTROLLER_REASON,
    })
  })

  it('declares the same surface and built-in capabilities as GRBL', () => {
    expect(controllerSurface(grblhalMachine)).toEqual({
      ...controllerSurface(grblMachine),
      controller: 'grblhal',
      postFlavour: 'grblhal',
    })
    for (const action of ['spindleCw', 'spindleCcw', 'spindleOff', 'coolantMist', 'coolantFlood', 'coolantOff'] as const) {
      expect(builtinDefaultLines('grblhal', action)).toEqual(builtinDefaultLines('grbl', action))
    }
  })

  it('round-trips a saved machine through the production persistence boundary', () => {
    const written = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))
    const migrated = persistMigrate(written, PERSIST_STORE_VERSION)
    const reloaded = persistMerge(migrated, useCamStore.getState())
    expect(reloaded.machineLibrary.find((machine) => machine.id === grblhalMachine.id)?.controller)
      .toBe('grblhal')
  })

  it('pins the declared identity in a simulator session and reports the temporary backend truth', async () => {
    const pending = session.connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(300)
    await pending

    expect(controlMachine(useCamStore.getState()).controller).toBe('grblhal')
    expect(useMachineControl.getState().consoleLines.map((line) => line.text))
      .toContainEqual(expect.stringContaining('grblHAL (declared) via GRBL 1.1 protocol'))
  })

  it('gives GRBL and grblHAL the same transfer verdict for the same program and travel', () => {
    const job = transferCheckJobFromProgram(
      'G21 G90 G54\nM3 S12000\nG1 X40 Y20 Z-2 F500\nM30\n',
      grblMachine,
    )
    const grblVerdict = checkJobAgainstMachine(job, grblMachine, null)
    const grblhalVerdict = checkJobAgainstMachine(job, grblhalMachine, null)
    expect(grblhalVerdict).toEqual(grblVerdict)
  })
})

// @vitest-environment jsdom
//
// WO-1670 - PARKS AND SAFE Z COME FROM THE MACHINE DEFINITION, NEVER RETYPED.
// WO-1681 - A PARK IS A MACRO TYPE, NOT A SEPARATE LIST.
//
// The mechanism: a park is a macro whose body is the built-in "go to machine
// position" step (Z first by default), on the SAME model as every other
// macro (WO-1680) - so it can carry other steps, and a user makes as many or
// as few as they want. The Macros panel, `G30 Pn` and a typed bound M-code
// all reach the one macro list. Safe Z still comes from the definition - a
// UCCNC profile's `Generalsettings.SafeZ`.
//
// The convenience: importing a UCCNC profile with its macro files beside it
// offers every `G53 Z` then `G53 X Y` macro as a position macro bound to its
// M-code. Fixtures: Operator's own M200-M203 (and M2001, which is more than a
// park) as read off machine PC on 2026-09-17, copied into
// src/tests/evidence/WO-1670/macros/.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const {
  machineParks,
  machineReferencePositions,
  machineSafeZ,
  withMachineSafeZ,
  positionMacroBody,
} = await import('../../types')
type MachineConfig = import('../../types').MachineConfig
type MachineMacro = import('../../types').MachineMacro
const { buildParkSequence, machineParkList, machineSafeZValue } = await import('../../lib/machine/machineActions')
const { importUccncProfile, previewLocalUccncProfile, parksFromUccncMacros } = await import('../../lib/machine/uccncProfileImport')
const { persistMerge, persistPartialize, useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { activeMacroRun } = await import('../../lib/machine/macros/macroRuntime')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')

const ROOT = process.cwd()
const PRO = readFileSync(join(ROOT, 'docs/machine/profiles/LienCNCV2.pro'), 'utf8')
const MACRO_DIR = join(ROOT, 'src/tests/evidence/WO-1670/macros')
const MACROS = readdirSync(MACRO_DIR).map((name) => ({
  name: `Macro_LienCNCV2/${name}`,
  text: readFileSync(join(MACRO_DIR, name), 'utf8'),
}))

function positionMacro(id: string, label: string, x: number, y: number, z: number, mCode: number | null): MachineMacro {
  return {
    id,
    name: label,
    ...(mCode === null ? {} : { mCode }),
    body: positionMacroBody({ x, y, z, zFirst: true }),
  }
}

describe('import: Operator\'s .pro with his macro folder beside it', () => {
  it('keeps every macro body raw and separately derives his four exact G30 points', () => {
    const preview = previewLocalUccncProfile(null, 'LienCNCV2.pro', PRO, MACROS)
    expect(preview.readable).toBe(true)
    expect(preview.parkMacros?.map((m) => m.mCode)).toEqual([200, 201, 202, 203, 2001, 20002])
    for (const macro of preview.parkMacros ?? []) {
      const source = MACROS.find((file) => file.name.endsWith(`/M${macro.mCode}.txt`))
      expect(macro.body).toBe(source?.text)
    }
    expect(preview.referencePositions).toEqual({
      1: { x: 738, y: 724.5, z: 128 },
      2: { x: 738, y: 50, z: 128 },
      3: { x: 50, y: 50, z: 128 },
      4: { x: 50, y: 724.5, z: 128 },
    })
    expect(machineReferencePositions({
      macros: preview.parkMacros,
      referencePositions: preview.referencePositions,
    })).toEqual(preview.referencePositions)
    expect(machineParkList({
      macros: preview.parkMacros,
      referencePositions: preview.referencePositions,
    }, undefined).map((park) => [park.label, park.x, park.y, park.z])).toEqual([
      ['G30 P1', 738, 724.5, 128],
      ['G30 P2', 738, 50, 128],
      ['G30 P3', 50, 50, 128],
      ['G30 P4', 50, 724.5, 128],
    ])
    expect(preview.parkNote).toContain('Macros: 6 imported')
    expect(preview.parkNote).toContain('Parks: 4 imported')
  })

  it('M2001 moves to a corner and then stops for the operator - more than a park, so not offered', () => {
    const parks = parksFromUccncMacros(MACROS)
    expect(parks.map((p) => p.mCode)).not.toContain(2001)
    expect(parks.map((p) => p.mCode)).not.toContain(20002)
  })

  it('a plain G-code macro body is read the same way', () => {
    const parks = parksFromUccncMacros([
      { name: 'M300.txt', text: '(front left)\nG00 G53 Z110\nG00 G53 X10 Y20\n' },
      { name: 'M301.txt', text: 'G00 G53 X5 Y5\nG00 G53 Z100\n' },
      { name: 'M302.txt', text: 'M8\n' },
    ])
    expect(parks.map((p) => [p.mCode, p.x, p.y, p.z, p.zFirst])).toEqual([
      [300, 10, 20, 110, true],
      [301, 5, 5, 100, false],
    ])
  })

  it('the same .pro WITHOUT the folder: zero position macros, nothing refused', () => {
    const preview = previewLocalUccncProfile(null, 'LienCNCV2.pro', PRO)
    expect(preview.readable).toBe(true)
    expect(preview.error).toBeNull()
    expect(preview.parkMacros).toEqual([])
    expect(preview.referencePositions).toBeUndefined()
    expect(preview.parkNote).toContain('no macros were imported')
    expect(preview.parkNote).toContain('no parks were imported')
  })

  it('a second profile, which states no safe Z and brings no macros: no parks, no safe Z invented', () => {
    const other = readFileSync(join(ROOT, 'src/tests/evidence/WO-915/scratch-profile.pro'), 'utf8')
    expect(other).not.toMatch(/SafeZ=/)
    const preview = previewLocalUccncProfile(null, 'scratch-profile.pro', other, [])
    expect(preview.parkMacros ?? []).toEqual([])
    expect(preview.referencePositions).toBeUndefined()
    const definition = importUccncProfile(other).definition
    expect(machineSafeZ({ controllerDefinition: definition ?? undefined })).toBeNull()
  })

  it('keeps imported points through save, reload, and switching away and back', () => {
    useCamStore.getState().newProject()
    const preview = previewLocalUccncProfile(null, 'LienCNCV2.pro', PRO, MACROS)
    const base = useCamStore.getState().project.machine
    const imported: MachineConfig = {
      ...base,
      id: 'wo1670-imported',
      name: 'Imported parks',
      macros: preview.parkMacros,
      referencePositions: preview.referencePositions,
    }
    const other: MachineConfig = {
      ...base,
      id: 'wo1670-other',
      name: 'Other machine',
      macros: [],
      referencePositions: undefined,
    }
    useCamStore.setState({ machineLibrary: [imported, other] })
    useCamStore.getState().setProjectMachine(other)
    expect(machineReferencePositions(useCamStore.getState().project.machine)).toBeUndefined()
    useCamStore.getState().setProjectMachine(imported)
    expect(machineReferencePositions(useCamStore.getState().project.machine)).toEqual(preview.referencePositions)

    const saved = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState()))) as unknown
    const reloaded = persistMerge(saved, useCamStore.getState())
    const restored = reloaded.machineLibrary.find((machine) => machine.id === imported.id)!
    expect(machineReferencePositions(restored)).toEqual(preview.referencePositions)
    expect(restored.macros?.map((macro) => macro.body)).toEqual(preview.parkMacros?.map((macro) => macro.body))
  })
})

describe('safe Z is the definition\'s, never retyped', () => {
  it('Operator\'s imported profile states 120 and that is the machine\'s safe Z', () => {
    const definition = importUccncProfile(PRO).definition!
    expect(machineSafeZ({ controllerDefinition: definition })).toEqual({ z: 120, from: 'profile' })
    // The macro / Safe Z readers get it with nothing stored beside the wiring.
    expect(machineSafeZValue({ controllerDefinition: definition }, undefined)).toBe(120)
  })

  it('editing it writes the profile\'s own setting - still one value', () => {
    const definition = importUccncProfile(PRO).definition!
    const machine = { controller: 'uccnc', controllerDefinition: definition } as MachineConfig
    const edited = withMachineSafeZ(machine, 125)
    expect(machineSafeZ(edited)).toEqual({ z: 125, from: 'profile' })
    expect(edited.safeZMachine).toBeUndefined()
  })

  it('a hand-made definition with no profile carries a typed safe Z', () => {
    const edited = withMachineSafeZ({} as MachineConfig, 90)
    expect(machineSafeZ(edited)).toEqual({ z: 90, from: 'typed' })
  })
})

describe('one macro list: button, G30 Pn and a bound M-code', () => {
  const macros = [positionMacro('a', 'Front', 20, 10, 80, 300), positionMacro('b', 'Back', 40, 90, 85, null)]

  it('a park moves Z first, then X Y, both in machine coordinates', () => {
    const front = { id: 'a', label: 'Front', x: 20, y: 10, z: 80 }
    expect(buildParkSequence(front, null)).toEqual({
      ok: true,
      lines: ['G21 G90 G53 G0 Z80', 'G21 G90 G53 G0 X20 Y10'],
    })
  })

  it('G30 P1 and P2 are the first two position macros', () => {
    expect(machineReferencePositions({ macros })).toEqual({
      1: { x: 20, y: 10, z: 80 },
      2: { x: 40, y: 90, z: 85 },
    })
  })

  it('a machine with G30 points and no macro of its own offers the G30 points as parks', () => {
    const offered = machineParks({ referencePositions: { 1: { x: 738, y: 724.5, z: 128 }, 3: { x: 50, y: 50, z: 128 } } })
    expect(offered.map((p) => [p.label, p.x, p.y, p.z])).toEqual([
      ['G30 P1', 738, 724.5, 128],
      ['G30 P3', 50, 50, 128],
    ])
  })

  it('the definition\'s position macros win over parks stored beside the wiring', () => {
    const stored = { overrides: {}, custom: [], parks: [{ id: 'old', label: 'Old', x: 1, y: 1 }] }
    expect(machineParkList({ macros }, stored).map((p) => p.id)).toEqual(['a', 'b'])
    expect(machineParkList({}, stored).map((p) => p.id)).toEqual(['old'])
  })
})

describe('end to end on the simulator: a hand-made definition', () => {
  const HAND_MADE_ID = 'wo1670-hand-made'

  function selectHandMadeMachine(): void {
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      id: HAND_MADE_ID,
      name: 'Hand-made parks',
      controller: 'grbl',
      controllerDefinition: undefined,
      unsentSettings: undefined,
      travel: { x: 738, y: 724, z: 130 },
      rapidRate: 60000,
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', machineZeroAt: 'max' },
      },
      macros: [
        positionMacro('front', 'Front', 20, 10, -2, 300),
        positionMacro('back', 'Back', 40, 90, -3, null),
      ],
      safeZMachine: -1,
    })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    useMachineActions.setState({ byMachine: {} })
    useCamStore.getState().newProject()
    selectHandMadeMachine()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    act(() => { __resetEstopInterlockForTest() })
  })

  afterEach(async () => {
    cleanup()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('the Macros panel shows exactly the definition\'s position macros', () => {
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    expect(screen.getByTestId('control-user-macro-front').textContent).toContain('Front')
    expect(screen.getByTestId('control-user-macro-back').textContent).toContain('Back')
  })

  it('typed M300 runs the "Front" position macro: Z first, then X Y', async () => {
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    getMachineController().sendCommand('G10 L2 P1 X100 Y100 Z-50')
    await vi.advanceTimersByTimeAsync(50)

    expect(sendMdiLine('M300')).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    const s = useMachineControl.getState()
    expect(s.mpos?.x).toBeCloseTo(20, 1)
    expect(s.mpos?.y).toBeCloseTo(10, 1)
    expect(s.mpos?.z).toBeCloseTo(-2, 1)
  })

  it('an M-code nobody bound runs no macro', () => {
    expect(activeMacroRun()).toBeNull()
    sendMdiLine('M301')
    expect(activeMacroRun()).toBeNull()
  })
})

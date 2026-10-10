// @vitest-environment jsdom
//
// WO-1731 - STATED MACHINE FACTS USE LIENCAM'S OWN KEYS.
//
// Today the four facts this order names (safe Z, home back-off, homing,
// switchless) must read as stated from TWO definitions with no source edit
// between them:
//
//   1. Operator's import (`createLienCncMachine`'s source: his own
//      LienCNCV2.pro through `importUccncProfile`). Every fact reads exactly
//      as it read before this order - the UCCNC key names are now resolved as
//      IMPORT ALIASES behind the app-owned question, and the import's records
//      (named fields, `stated` UCCNC keys, the `Generalsettings.SafeZ`
//      settings entry) are untouched, so the bridge's `StatedKeys` lookup and
//      WO-1037's catalogue partition keep answering from them.
//   2. A hand-built GRBL machine stating safe Z, back-off, homing and
//      switchless BY HAND, through the app-owned keys
//      (`liencam.safeZ` in its own controller's settings vocabulary,
//      `liencam.homing.X.backOff`, `liencam.homing.X.direction`,
//      `liencam.homing.X.homeInput`). Before this order each of those read
//      "not stated" for want of a UCCNC key name; a GRBL machine can never
//      carry one.
//
// The negative controls are the safety half: absence stays absence. A hand-
// built machine that states nothing through the app keys must NOT read as
// switchless or as stating a back-off just because its fields hold defaults.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AXIS_NAMES,
  UNASSIGNED_PIN,
  axisHomingIsStated,
  axisHomeBackOffStatementKey,
  axisHomeInputStatementKey,
  createDefaultControllerDefinition,
  definitionStatesKey,
  homeBackOffProvenance,
  LIENCAM_SAFE_Z_KEY,
  machineHasNoHomeSwitches,
  machineSafeZ,
  UCCNC_SAFE_Z_KEY,
  uccncAxisHomeBackOffKey,
  withAxisHomeBackOffStated,
  withAxisHomeInputStated,
  withAxisHomingStated,
  withControllerSetting,
  withMachineSafeZ,
  type ControllerDefinition,
  type MachineConfig,
} from '../../types'
import { importUccncProfile } from '../../lib/machine/uccncProfileImport'
import { exportUccncProfile } from '../../lib/machine/uccncProfileExport'
import { buildSettingsIndex } from '../../lib/machine/settingsIndex'
import {
  withDefinitionAxisHomingEdited,
  withDefinitionAxisPinEdited,
} from '../../components/machine/definition/useMachineDefinitionPanel'
import {
  PERSIST_STORE_VERSION,
  persistMerge,
  persistMigrate,
  persistPartialize,
  useCamStore,
} from '../../store'

const PRO = readFileSync(join(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'), 'utf8')

const ericsDefinition = (): ControllerDefinition => importUccncProfile(PRO).definition!

/** Operator's machine as the import leaves it. The seed
 *  (`createLienCncMachine`) re-derives exactly this from the same file. */
const ericsMachine = (): MachineConfig => ({
  controller: 'uccnc',
  controllerDefinition: ericsDefinition(),
} as MachineConfig)

const grblMachine = (definition: ControllerDefinition): MachineConfig => ({
  controller: 'grbl',
  controllerDefinition: definition,
} as MachineConfig)

/** The exact Zustand persist pipeline a browser refresh runs. */
const reloadThroughProductionStore = (machine: MachineConfig): MachineConfig => {
  const current = useCamStore.getState()
  const live = {
    ...current,
    machineLibrary: [machine],
    project: { ...current.project, machine },
    appSettings: { ...current.appSettings, liencncSeeded: true },
  }
  const written = JSON.parse(JSON.stringify(persistPartialize(live)))
  const migrated = persistMigrate(written, PERSIST_STORE_VERSION)
  return persistMerge(migrated, live).machineLibrary.find((entry) => entry.id === machine.id)!
}

describe('WO-1731 definition 1: Operator\'s import reads every fact as it read before', () => {
  it('safe Z reads as stated, from the profile, at the profile\'s number', () => {
    const machine = ericsMachine()
    expect(machineSafeZ(machine)).toEqual({ z: 120, from: 'profile' })
    expect(definitionStatesKey(machine.controllerDefinition, 'uccnc', LIENCAM_SAFE_Z_KEY)).toBe(true)
    // The alias is where it lives: the All-settings row edits it and the
    // export emits it, so the import must keep carrying the value there.
    expect(definitionStatesKey(machine.controllerDefinition, 'uccnc', UCCNC_SAFE_Z_KEY)).toBe(true)
    expect((machine.controllerDefinition!.settings ?? []).some(
      (entry) => entry.controller === 'uccnc' && entry.key === LIENCAM_SAFE_Z_KEY,
    )).toBe(false)
  })

  it('an edit of a profile-stated safe Z still lands in the profile\'s own entry', () => {
    const edited = withMachineSafeZ(ericsMachine(), 145)
    expect(machineSafeZ(edited)).toEqual({ z: 145, from: 'profile' })
    // The typed field stays empty: one value, one place (WO-1702).
    expect(edited.safeZMachine ?? null).toBe(null)
  })

  it('home back-off reads as stated for every axis his profile wrote, both call shapes', () => {
    const def = ericsDefinition()
    for (const axis of ['X', 'Y', 'Z'] as const) {
      // His profile says `Homebackoff=0` on every axis: a stated zero.
      expect(homeBackOffProvenance(def, axis, 'uccnc'), `${axis} asked app-owned`).toBe('machine')
      expect(homeBackOffProvenance(def, axis), `${axis} legacy call shape`).toBe('machine')
      expect(
        definitionStatesKey(def, 'uccnc', axisHomeBackOffStatementKey(axis)),
        `${axis} app-owned statement`,
      ).toBe(true)
      // The bridge still finds the UCCNC key it looks up (WO-1051's pin).
      expect(definitionStatesKey(def, 'uccnc', uccncAxisHomeBackOffKey(axis)), `${axis} alias`).toBe(true)
    }
  })

  it('homing reads as stated for his axes through the app question', () => {
    const machine = ericsMachine()
    expect(axisHomingIsStated(machine, 'X', 'direction')).toBe(true)
    expect(axisHomingIsStated(machine, 'X', 'homingValue')).toBe(true)
    expect(definitionStatesKey(
      machine.controllerDefinition, 'uccnc', 'liencam.homing.X.direction',
    )).toBe(true)
    expect(definitionStatesKey(
      machine.controllerDefinition, 'uccnc', 'liencam.homing.X.homingValue',
    )).toBe(true)
  })

  it('his switched machine is NOT switchless, and a machine without a controller still says nothing', () => {
    const machine = ericsMachine()
    expect(machineHasNoHomeSwitches(machine)).toBe(false)
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(definitionStatesKey(
        machine.controllerDefinition, 'uccnc', axisHomeInputStatementKey(axis),
      )).toBe(true)
    }
    const noController = { controllerDefinition: machine.controllerDefinition } as MachineConfig
    expect(machineHasNoHomeSwitches(noController)).toBe(false)
  })

  it('keeps one editable safe-Z value and the raw export/profile-only records coherent', () => {
    const before = ericsDefinition()
    const beforeProfileOnly = before.profileOnlySettings
    const edited = withMachineSafeZ(ericsMachine(), 145)
    const after = edited.controllerDefinition!
    expect(machineSafeZ(edited)).toEqual({ z: 145, from: 'profile' })
    expect(after.profileOnlySettings).toEqual(beforeProfileOnly)
    expect((after.settings ?? []).some(
      (entry) => entry.controller === 'uccnc' && entry.key === LIENCAM_SAFE_Z_KEY,
    )).toBe(false)
    expect(exportUccncProfile(after).text).toMatch(/(?:^|\r?\n)SafeZ=145(?:\r?\n|$)/)
  })
})

describe('WO-1731 definition 2: a hand-built GRBL machine states each fact by hand', () => {
  it('safe Z stated in the definition (not typed on the record) reads as stated', () => {
    const def: ControllerDefinition = {
      ...createDefaultControllerDefinition(AXIS_NAMES),
      settings: withControllerSetting([], 'grbl', LIENCAM_SAFE_Z_KEY, { kind: 'number', value: -30 }),
    }
    const machine = grblMachine(def)
    expect(machineSafeZ(machine)).toEqual({ z: -30, from: 'app' })
    // And an edit of a stated safe Z lands back in the same entry.
    const edited = withMachineSafeZ(machine, -25)
    expect(machineSafeZ(edited)).toEqual({ z: -25, from: 'app' })
    expect(edited.safeZMachine ?? null).toBe(null)
  })

  it('a first safe Z edit creates the fresh definition fact', () => {
    const edited = withMachineSafeZ(
      grblMachine(createDefaultControllerDefinition(AXIS_NAMES)),
      -30,
    )
    expect(definitionStatesKey(edited.controllerDefinition, 'grbl', LIENCAM_SAFE_Z_KEY)).toBe(true)
    expect(machineSafeZ(edited)).toEqual({ z: -30, from: 'app' })
    expect(edited.safeZMachine ?? null).toBe(null)
  })

  it('ordinary Machine edits state every fresh fact and survive the production reload', () => {
    const current = useCamStore.getState().project.machine
    let edited: MachineConfig = {
      ...current,
      id: 'wo1731-fresh-grbl',
      name: 'Fresh GRBL router',
      controller: 'grbl',
      controllerDefinition: createDefaultControllerDefinition(AXIS_NAMES),
      safeZMachine: undefined,
    }
    edited = withMachineSafeZ(edited, -30)
    edited = {
      ...edited,
      controllerDefinition: withDefinitionAxisHomingEdited(
        edited.controllerDefinition!, 'grbl', 'X', { direction: 'negative', backOff: 7.5 },
      ),
    }
    for (const axis of ['X', 'Y', 'Z'] as const) {
      edited = {
        ...edited,
        controllerDefinition: withDefinitionAxisPinEdited(
          edited.controllerDefinition!, 'grbl', axis, 'homePin', { ...UNASSIGNED_PIN },
        ),
      }
    }

    const reloaded = reloadThroughProductionStore(edited)
    expect(machineSafeZ(reloaded)).toEqual({ z: -30, from: 'app' })
    expect(homeBackOffProvenance(reloaded.controllerDefinition, 'X', 'grbl')).toBe('machine')
    expect(axisHomingIsStated(reloaded, 'X', 'direction')).toBe(true)
    expect(machineHasNoHomeSwitches(reloaded)).toBe(true)
    expect(reloaded.controllerDefinition?.homing.perAxis.X).toMatchObject({
      direction: 'negative', backOff: 7.5,
    })
  })

  it('home back-off stated by hand reads as the machine\'s, and absence still reads as default', () => {
    const stated = withAxisHomeBackOffStated(createDefaultControllerDefinition(AXIS_NAMES), 'grbl', 'X')
    expect(homeBackOffProvenance(stated, 'X', 'grbl')).toBe('machine')
    // Y states nothing: its `backOff` is this software's default, whatever
    // number sits in the field.
    expect(homeBackOffProvenance(stated, 'Y', 'grbl')).toBe('default')
    // Stating it twice does not duplicate the record.
    expect(withAxisHomeBackOffStated(stated, 'grbl', 'X').stated).toEqual(stated.stated)
    expect(axisHomeBackOffStatementKey('X')).toBe('liencam.homing.X.backOff')
  })

  it('homing stated by hand reads as stated under the machine\'s own controller', () => {
    const def = withAxisHomingStated(createDefaultControllerDefinition(AXIS_NAMES), 'grbl', 'X', ['direction'])
    expect(axisHomingIsStated(grblMachine(def), 'X', 'direction')).toBe(true)
    expect(axisHomingIsStated(grblMachine(def), 'X', 'homingValue')).toBe(false)
  })

  it('switchless stated by hand reads switchless; stating OTHER things does not', () => {
    const base = withAxisHomingStated(createDefaultControllerDefinition(AXIS_NAMES), 'grbl', 'X', ['direction'])
    // Non-empty `stated` with no home input addressed: the WO-1144 shape.
    // A machine whose homing is stated but whose home inputs are not must
    // not claim the switchless mode.
    expect(machineHasNoHomeSwitches(grblMachine(base))).toBe(false)
    let switchless = base
    for (const axis of ['X', 'Y', 'Z'] as const) {
      switchless = withAxisHomeInputStated(switchless, 'grbl', axis)
    }
    expect(machineHasNoHomeSwitches(grblMachine(switchless))).toBe(true)
    // Wire one home pin and the mode closes again - the pins still decide.
    const wired: ControllerDefinition = {
      ...switchless,
      axes: switchless.axes.map((axis) => axis.axis === 'Z'
        ? { ...axis, homePin: { port: 1, pin: 5, negate: null } }
        : axis),
    }
    expect(machineHasNoHomeSwitches(grblMachine(wired))).toBe(false)
    expect(axisHomeInputStatementKey('Z')).toBe('liencam.homing.Z.homeInput')
  })

  it('a bare hand-built definition states none of the four facts', () => {
    const machine = grblMachine(createDefaultControllerDefinition(AXIS_NAMES))
    expect(machineSafeZ(machine)).toBeNull()
    expect(homeBackOffProvenance(machine.controllerDefinition, 'X', 'grbl')).toBe('default')
    expect(axisHomingIsStated(machine, 'X', 'direction')).toBe(false)
    // (A definition with NOTHING stated at all is the WO-985 blank-wiring
    // case and keeps its own established meaning; the control above is the
    // stated-something machine.)
  })
})

describe('WO-1731: the settings index asks the definition, not the controller name', () => {
  it('a GRBL machine\'s own-stated safe Z is a row like any other setting', () => {
    const def: ControllerDefinition = {
      ...createDefaultControllerDefinition(AXIS_NAMES),
      settings: withControllerSetting([], 'grbl', LIENCAM_SAFE_Z_KEY, { kind: 'number', value: -30 }),
    }
    const rows = buildSettingsIndex(grblMachine(def))
    const row = rows.find((r) => r.key === LIENCAM_SAFE_Z_KEY)
    expect(row?.value).toBe('-30')
    expect(row?.controller).toBe('grbl')
  })

  it('a controller with no catalogue at all still indexes what its definition states', () => {
    const def: ControllerDefinition = {
      ...createDefaultControllerDefinition(AXIS_NAMES),
      settings: withControllerSetting([], 'linuxcnc', LIENCAM_SAFE_Z_KEY, { kind: 'number', value: 60 }),
    }
    const machine = { controller: 'linuxcnc', controllerDefinition: def } as MachineConfig
    const rows = buildSettingsIndex(machine)
    expect(rows.find((r) => r.key === LIENCAM_SAFE_Z_KEY)?.value).toBe('60')
  })

  it('Operator\'s import indexes exactly the catalogue - the alias adds no second row', () => {
    const rows = buildSettingsIndex(ericsMachine())
    expect(rows.some((r) => r.key === UCCNC_SAFE_Z_KEY)).toBe(true)
    expect(rows.some((r) => r.key === LIENCAM_SAFE_Z_KEY)).toBe(false)
  })
})

it.each(['grbl', 'grblhal', 'linuxcnc', 'generic'] as const)(
  'a UCCNC back-off alias does not state the fact for %s',
  (controller) => {
    const definition = ericsDefinition()
    expect(homeBackOffProvenance(definition, 'X', 'uccnc')).toBe('machine')
    expect(homeBackOffProvenance(definition, 'X', controller)).toBe('default')
    const carried = { ...ericsMachine(), controller } as MachineConfig
    expect(machineSafeZ(carried)).toBeNull()
    const stated = withAxisHomeBackOffStated(definition, controller, 'X')
    expect(homeBackOffProvenance(stated, 'X', controller)).toBe('machine')
    const edited = withMachineSafeZ(carried, 42)
    expect(machineSafeZ(edited)).toEqual({ z: 42, from: 'app' })
    expect(definitionStatesKey(
      edited.controllerDefinition, controller, LIENCAM_SAFE_Z_KEY,
    )).toBe(true)
  },
)

// @vitest-environment jsdom
//
// WO-1695: PLASMA/LASER/KNIFE-ONLY SETTINGS HIDE ON A ROUTER, KEPT NOT DELETED.
//
// COHESION-STANDARD s18 (Operator, 2026-09-18): "we have oddities like having to
// type in true/false... torch height control. If it is not a plasma those
// don't apply. Can we find a better way to organize the fields and smartly
// hide what does not apply by having a few machine type filters at the top."
//
// Drives the real `AllSettingsTable` against Operator's imported UCCNC profile
// (a router - the .pro format has no `kind` key, so importing it never states
// one) with `kind` left absent, set to `'router'`, and set to `'plasma'`.
// Which rows are plasma/laser/knife-only comes from the real
// `buildSettingsIndex`, never a hardcoded list - only the representative test
// IDs below are literal, and a `beforeAll`-style existence check would just
// duplicate `settingsIndex.wo1685.test.ts`'s own catalogue coverage.

import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { MachineConfig, MachineKind } from '../../types'
import { AllSettingsTable } from '../../components/machine/definition/AllSettingsTable'
import { createSettingSource } from '../../components/machine/definition/DefinitionFields'
import {
  UCCNC_CATALOGUE_CONTROLLER,
  importUccncProfile,
  uccncProfileOnlySettings,
  uccncSettingField,
} from '../../lib/machine/uccncProfileImport'
import { exportUccncProfile } from '../../lib/machine/uccncProfileExport'
import { buildSettingsIndex } from '../../lib/machine/settingsIndex'

afterEach(() => { cleanup() })

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILE_PATH = resolve(HERE, '../../..', 'docs/machine/profiles/LienCNCV2.pro')
const PROFILE_TEXT = readFileSync(PROFILE_PATH, 'utf8')

const THC_KEY = 'IOsetupsettings.THCenable'
const LASER_KEY = 'IOsetupsettings.Laseroutputportnumber'
// Laser-only, but not a `Laseroutput*` name and not in the Laserengraveplugin
// group - the charge pump's own laser-waveform mode (WO-1695 audit round 1:
// this key escaped the first pass's `Laseroutput*`/group check).
const LASER_CHARGE_PUMP_KEY = 'IOsetupsettings.Chargepumplasermodeon'
const KNIFE_KEY = 'axessettingscontrolA.Dragknifeenabled'

function Harness({ initial, initialSearch = '' }: { initial: MachineConfig; initialSearch?: string }) {
  const [draft, setDraft] = useState(initial)
  // Mounting straight into a narrow search, rather than the full ~1650-row
  // "everything" view and then filtering, is what keeps this suite fast -
  // jsdom lays out every unfiltered row once before any filter narrows it.
  const [search, setSearch] = useState(initialSearch)
  const editDraft = (mut: (m: MachineConfig) => MachineConfig) => { setDraft(mut) }
  const unsent = createSettingSource({
    definition: draft.controllerDefinition ?? null,
    unsent: draft.unsentSettings,
    controller: draft.controller,
    catalogue: UCCNC_CATALOGUE_CONTROLLER,
    field: uccncSettingField,
    patch: (mut) => {
      editDraft((m) => (m.controllerDefinition ? { ...m, controllerDefinition: mut(m.controllerDefinition) } : m))
    },
    pending: {},
    setPending: () => {},
    reportAbsent: () => {},
    reportRefused: () => {},
    owner: draft,
    hideEmpty: false,
    unused: () => false,
  })
  return (
    <>
      <input aria-label="settings search" value={search} onChange={(e) => { setSearch(e.target.value) }} />
      <AllSettingsTable
        draft={draft}
        source={initial}
        unsent={unsent}
        editDraft={editDraft}
        settingSearch={search}
      />
    </>
  )
}

function uccncMachine(kind?: MachineKind): MachineConfig {
  const imported = importUccncProfile(PROFILE_TEXT)
  const machine: MachineConfig = {
    id: 'wo1695-uccnc', name: 'Sample CNC V2', type: 'gantry_router', controller: 'uccnc',
    travel: imported.travel!, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
    controllerDefinition: imported.definition!,
  }
  return kind === undefined ? machine : { ...machine, kind }
}

const rowTestId = (key: string) => `machine-def-all-settings-row-uccnc-${key}`

describe('WO-1695 - buildSettingsIndex tags THC, laser-output and drag-knife rows plasma/laser/knife-only', () => {
  it('a router (kind absent) does not make any of them visible', () => {
    const index = buildSettingsIndex(uccncMachine())
    expect(index.find((r) => r.key === THC_KEY)?.visible).toBe(false)
    expect(index.find((r) => r.key === LASER_KEY)?.visible).toBe(false)
    expect(index.find((r) => r.key === LASER_CHARGE_PUMP_KEY)?.visible).toBe(false)
    expect(index.find((r) => r.key === KNIFE_KEY)?.visible).toBe(false)
  })

  it('a plasma machine makes THC visible but not laser or drag-knife', () => {
    const index = buildSettingsIndex(uccncMachine('plasma'))
    expect(index.find((r) => r.key === THC_KEY)?.visible).toBe(true)
    expect(index.find((r) => r.key === LASER_KEY)?.visible).toBe(false)
    expect(index.find((r) => r.key === LASER_CHARGE_PUMP_KEY)?.visible).toBe(false)
    expect(index.find((r) => r.key === KNIFE_KEY)?.visible).toBe(false)
  })

  it('a laser machine makes the laser output and charge-pump laser mode visible but not THC or drag-knife', () => {
    const index = buildSettingsIndex(uccncMachine('laser'))
    expect(index.find((r) => r.key === THC_KEY)?.visible).toBe(false)
    expect(index.find((r) => r.key === LASER_KEY)?.visible).toBe(true)
    expect(index.find((r) => r.key === LASER_CHARGE_PUMP_KEY)?.visible).toBe(true)
    expect(index.find((r) => r.key === KNIFE_KEY)?.visible).toBe(false)
  })

  it('a knife machine makes the drag-knife setting visible but not THC or laser', () => {
    const index = buildSettingsIndex(uccncMachine('knife'))
    expect(index.find((r) => r.key === THC_KEY)?.visible).toBe(false)
    expect(index.find((r) => r.key === LASER_KEY)?.visible).toBe(false)
    expect(index.find((r) => r.key === LASER_CHARGE_PUMP_KEY)?.visible).toBe(false)
    expect(index.find((r) => r.key === KNIFE_KEY)?.visible).toBe(true)
  })

  it('every other-kind row stays in the index with its value - hidden is not deleted', () => {
    const index = buildSettingsIndex(uccncMachine())
    const thcRow = index.find((r) => r.key === THC_KEY)
    expect(thcRow).toBeDefined()
    expect(thcRow!.visible).toBe(false)
    expect(thcRow!.value).not.toBeNull()
  })
})

describe('WO-1695 - a router draws no THC, laser or drag-knife controls anywhere in the All settings panel', () => {
  // WO-1780: this case used to demand the WHOLE "thc" search be empty. WO-1761
  // added the imported file's own keys as read-only rows under the distinct
  // `uccnc-profile` identity, and four `Appearancesetupsettings.*pathcolor`
  // values match "thc" as plain text ("pa-thc-olor"). Those are raw profile
  // diagnostics, not controls - Operator asked to see them and they stay. What the
  // kind rule must still guarantee is that NO controller (`uccnc`-identity)
  // THC row is drawn, and that the profile rows that DO appear are exactly the
  // ones the imported file carries, each read-only and marked not-used. The
  // expected population is derived from `uccncProfileOnlySettings` on the real
  // fixture - never a magic count - so a real THC control leaking onto a
  // router fails the controller-identity assertion below.
  const profileThcKeys = (): string[] => {
    const def = uccncMachine().controllerDefinition
    // The table's search rule is key/name/group/meaning contains the needle,
    // case-insensitive. A profile row's name is its key and its group is its
    // section, so the full `Section.Key` test subsumes both; its meaning
    // ('Not used by LienCAM.') carries no 'thc'.
    return uccncProfileOnlySettings(def)
      .map((s) => `${s.section}.${s.key}`)
      .filter((key) => key.toLowerCase().includes('thc'))
  }

  it.each([undefined, 'router' as const])('kind %s draws no THC control, only the read-only profile rows matching the search', (kind) => {
    const expected = profileThcKeys()
    // A vacuous population would make "no controls" unprovable; the fixture
    // really carries these four appearance-color keys.
    expect(expected.length).toBeGreaterThan(0)

    render(<Harness initial={uccncMachine(kind)} initialSearch="thc" />)
    expect(screen.queryByTestId(rowTestId(THC_KEY))).toBeNull()

    const rowPrefix = (identity: string) => `machine-def-all-settings-row-${identity}-`
    const drawn = screen.getAllByTestId(/^machine-def-all-settings-row-/).map((el) => el.getAttribute('data-testid')!)
    // The leak proof: every controller-identity row drawn under this search.
    // A broken kind filter would put `...-row-uccnc-IOsetupsettings.THC...`
    // here and fail this line.
    const controlRows = drawn.filter((id) =>
      id.startsWith(rowPrefix('uccnc')) && !id.startsWith(rowPrefix('uccnc-profile')))
    expect(controlRows).toEqual([])
    // And separately: the profile-only rows are exactly the fixture's own
    // matching keys - nothing hidden, nothing invented.
    expect(drawn.filter((id) => id.startsWith(rowPrefix('uccnc-profile'))).sort())
      .toEqual(expected.map((key) => `${rowPrefix('uccnc-profile')}${key}`).sort())

    for (const key of expected) {
      const row = screen.getByTestId(`${rowPrefix('uccnc-profile')}${key}`)
      expect(row.getAttribute('data-row-source')).toBe('profile')
      expect(row.getAttribute('data-liencam-use')).toBe('not-used')
      // Read-only: a value span, and no editor of any kind on the row.
      expect(row.querySelector(`[data-testid="machine-def-all-settings-value-uccnc-profile-${key}"]`)).toBeTruthy()
      expect(row.querySelector('input, select, textarea')).toBeNull()
    }
    // The table is not empty under this search, so no empty-state line.
    expect(screen.queryByTestId('machine-def-all-settings-empty')).toBeNull()
  })

  it('a search that matches nothing at all still draws the empty-state line', () => {
    render(<Harness initial={uccncMachine()} initialSearch="zznomatchzz" />)
    expect(screen.getByTestId('machine-def-all-settings-empty').textContent).toBe('No setting matches "zznomatchzz".')
  })

  it.each([undefined, 'router' as const])('kind %s hides the laser output', (kind) => {
    render(<Harness initial={uccncMachine(kind)} initialSearch="laseroutput" />)
    expect(screen.queryByTestId(rowTestId(LASER_KEY))).toBeNull()
  })

  it.each([undefined, 'router' as const])('kind %s hides the charge pump laser-mode setting', (kind) => {
    render(<Harness initial={uccncMachine(kind)} initialSearch="chargepumplasermodeon" />)
    expect(screen.queryByTestId(rowTestId(LASER_CHARGE_PUMP_KEY))).toBeNull()
  })

  it.each([undefined, 'router' as const])('kind %s hides the drag-knife control', (kind) => {
    render(<Harness initial={uccncMachine(kind)} initialSearch="knife" />)
    expect(screen.queryByTestId(rowTestId(KNIFE_KEY))).toBeNull()
  })
})

describe('WO-1695 - a plasma machine draws the THC controls', () => {
  it('shows the THC row and lets it be edited, same as any other UCCNC row', () => {
    render(<Harness initial={uccncMachine('plasma')} initialSearch="thc" />)
    expect(screen.getByTestId(rowTestId(THC_KEY))).toBeTruthy()
    const box = screen.getByLabelText(THC_KEY) as HTMLInputElement
    const first = box.getAttribute('value')
    act(() => { fireEvent.click(box) })
    expect(box.getAttribute('value')).not.toBe(first)
  })

  it('still hides the laser output - kind is plasma, not laser', () => {
    render(<Harness initial={uccncMachine('plasma')} initialSearch="laseroutput" />)
    expect(screen.queryByTestId(rowTestId(LASER_KEY))).toBeNull()
  })

  it('still hides the charge pump laser-mode setting - kind is plasma, not laser', () => {
    render(<Harness initial={uccncMachine('plasma')} initialSearch="chargepumplasermodeon" />)
    expect(screen.queryByTestId(rowTestId(LASER_CHARGE_PUMP_KEY))).toBeNull()
  })

  it('still hides the drag-knife control - kind is plasma, not knife', () => {
    render(<Harness initial={uccncMachine('plasma')} initialSearch="knife" />)
    expect(screen.queryByTestId(rowTestId(KNIFE_KEY))).toBeNull()
  })
})

describe('WO-1695 - hidden is not deleted: the .pro export carries every THC key with its stored value', () => {
  it('a router-kind machine (absent, "router") exports the same THC values as a plasma-kind machine', () => {
    const router = uccncMachine()
    const routerExplicit = uccncMachine('router')
    const plasma = uccncMachine('plasma')

    const routerExport = exportUccncProfile(router.controllerDefinition).text
    const routerExplicitExport = exportUccncProfile(routerExplicit.controllerDefinition).text
    const plasmaExport = exportUccncProfile(plasma.controllerDefinition).text

    // kind is not a .pro key (types/index.ts): stating it changes nothing
    // about what a machine can export, only what the panel draws.
    expect(routerExplicitExport).toBe(routerExport)
    expect(plasmaExport).toBe(routerExport)

    const index = buildSettingsIndex(router)
    const statedThcRows = index.filter((r) => r.key.startsWith('IOsetupsettings.THC') && r.value !== null)
    expect(statedThcRows.length).toBeGreaterThan(0)
    for (const row of statedThcRows) {
      const name = row.key.slice('IOsetupsettings.'.length)
      expect(routerExport).toMatch(new RegExp(`^${name}=`, 'm'))
    }
  })
})

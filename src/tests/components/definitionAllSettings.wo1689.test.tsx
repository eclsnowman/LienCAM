// @vitest-environment jsdom
//
// WO-1689: EVERY CONTROLLER SETTING LIVES IN ONE SEARCHABLE TABLE.
//
// Drives the real `AllSettingsTable` against the real UCCNC catalogue (Operator's
// imported profile) and a GRBL router's stated `$`-settings - the same two
// fixtures WO-1685's own suite measures `buildSettingsIndex` against. A
// minimal harness stands in for the panel: real `createSettingSource` (WO-1039),
// real `editDraft`, no mock of either write path.
//
// THE WO's OWN NUMBERS FOR THE "thc" SEARCH (39 controls, 9 checkboxes) DO NOT
// MATCH THE REAL CATALOGUE. Counted straight from `UCCNC_SETTING_FIELDS`
// (decide-and-log, see this file's Worker result): the 29 keys containing
// "thc" are all scalar (none is `tuple`, none is pin-owned), so they draw
// exactly one control per row - 29, not 39 - and 11 of those 29 are
// `kind: 'boolean'` - not 9. Both numbers are asserted here DERIVED FROM THE
// CATALOGUE, never hardcoded, so this suite cannot go stale the way a copied
// literal would.

import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { MachineConfig, MachineKind } from '../../types'
import { AllSettingsTable } from '../../components/machine/definition/AllSettingsTable'
import { createSettingSource } from '../../components/machine/definition/DefinitionFields'
import {
  UCCNC_CATALOGUE_CONTROLLER,
  UCCNC_SETTING_FIELDS,
  importUccncProfile,
  uccncSettingField,
  uccncProfileOnlySettings,
} from '../../lib/machine/uccncProfileImport'
import { exportUccncProfile } from '../../lib/machine/uccncProfileExport'
import { recordGrblSettings, GRBL_SETTINGS, type GrblSettingsRecord } from '../../lib/machine/grbl/settings'
import { buildSettingsIndex } from '../../lib/machine/settingsIndex'

afterEach(() => { cleanup() })

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILE_PATH = resolve(HERE, '../../..', 'docs/machine/profiles/LienCNCV2.pro')
const PROFILE_TEXT = readFileSync(PROFILE_PATH, 'utf8')

/** A minimal stand-in for `useMachineDefinitionPanel`'s draft/source/unsent/
 *  editDraft, wired the same way the real hook wires them - see `patch` below,
 *  which is `useMachineDefinitionPanel.patchDefinition` verbatim. */
function Harness({ initial, onDraft }: { initial: MachineConfig; onDraft?: (m: MachineConfig) => void }) {
  const [draft, setDraft] = useState(initial)
  const [search, setSearch] = useState('')
  useEffect(() => { onDraft?.(draft) }, [draft, onDraft])

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

// WO-1695: kind absent means router (WO-1686), and a router hides THC - so
// this suite's THC fixture states `kind: 'plasma'` wherever it needs those
// rows to be visible. The Physical .pro has no `kind` key either way.
function uccncMachine(kind?: MachineKind): MachineConfig {
  const imported = importUccncProfile(PROFILE_TEXT)
  const machine: MachineConfig = {
    id: 'wo1689-uccnc', name: 'Sample CNC V2', type: 'gantry_router', controller: 'uccnc',
    travel: imported.travel!, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
    controllerDefinition: imported.definition!,
  }
  return kind === undefined ? machine : { ...machine, kind }
}

function grblMachine(grblSettings: GrblSettingsRecord): MachineConfig {
  return recordGrblSettings({
    id: 'wo1689-grbl', name: 'Shapeoko', type: 'gantry_router', controller: 'grbl',
    travel: { x: 400, y: 400, z: 100 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
  }, grblSettings)
}

const rowTestId = (controller: 'uccnc' | 'uccnc-profile' | 'grbl', key: string) =>
  `machine-def-all-settings-row-${controller}-${key}`

// Ground truth, from the catalogue and imported profile - not copied counts.
const thcFields = UCCNC_SETTING_FIELDS.filter((f) => f.key.toLowerCase().includes('thc'))
const thcBooleanCount = thcFields.filter((f) => f.kind === 'boolean').length
// WO-1761 shows every imported profile key too. Four appearance keys match
// this deliberately plain substring search because "pathcolor" contains
// "thc"; they are read-only profile facts, not extra THC controls.
const thcProfileOnly = uccncProfileOnlySettings(uccncMachine().controllerDefinition)
  .filter((setting) => `${setting.section}.${setting.key}`.toLowerCase().includes('thc'))

describe('WO-1689 - searching "thc" on Operator\'s UCCNC machine', () => {
  it('the catalogue has 29 "thc" keys, all scalar - the ground truth this suite measures against', () => {
    expect(thcFields).toHaveLength(29)
    expect(thcFields.every((f) => f.kind !== 'tuple')).toBe(true)
    expect(thcFields.every((f) => f.ownedBy === null)).toBe(true)
    expect(thcProfileOnly.map((setting) => `${setting.section}.${setting.key}`)).toEqual([
      'Appearancesetupsettings.Viewerundonepathcolor',
      'Appearancesetupsettings.Viewerdonepathcolor',
      'Appearancesetupsettings.Viewerrapidpathcolor',
      'Appearancesetupsettings.radiusoffsetpathcolor',
    ])
  })

  it('shows one row per catalogue key, one control per row, and a checkbox for each boolean key', () => {
    // WO-1695: THC is plasma-only and this router profile hides it by
    // default (kind absent = router, WO-1686). This test's own purpose is
    // the row/control shape, not kind-visibility, so it states `kind:
    // 'plasma'` to keep the 29 rows on-screen - see the router-hides
    // counterpart added below.
    render(<Harness initial={uccncMachine('plasma')} />)
    act(() => { fireEvent.change(screen.getByLabelText('settings search'), { target: { value: 'thc' } }) })

    const rows = thcFields.map((f) => screen.getByTestId(rowTestId('uccnc', f.key)))
    expect(rows).toHaveLength(29)

    const controls = rows.flatMap((row) => [...row.querySelectorAll('input, select')])
    expect(controls).toHaveLength(thcFields.length)

    const checkboxes = controls.filter((el) => el.getAttribute('type') === 'checkbox')
    expect(checkboxes).toHaveLength(thcBooleanCount)

    const profileRows = thcProfileOnly.map((setting) => screen.getByTestId(rowTestId(
      'uccnc-profile', `${setting.section}.${setting.key}`,
    )))
    expect(profileRows).toHaveLength(4)
    expect(profileRows.every((row) => row.querySelector('input, select') === null)).toBe(true)
    expect(profileRows.every((row) => row.getAttribute('data-liencam-use') === 'not-used')).toBe(true)

    expect(screen.getByTestId('machine-def-all-settings-count').textContent)
      .toBe(`${thcFields.length + thcProfileOnly.length} settings`)
  })

  it('on a router the 29 controls stay hidden while matching profile facts remain visible', () => {
    render(<Harness initial={uccncMachine()} />)
    act(() => { fireEvent.change(screen.getByLabelText('settings search'), { target: { value: 'thc' } }) })

    for (const f of thcFields) {
      expect(screen.queryByTestId(rowTestId('uccnc', f.key))).toBeNull()
    }
    for (const setting of thcProfileOnly) {
      expect(screen.getByTestId(rowTestId(
        'uccnc-profile', `${setting.section}.${setting.key}`,
      ))).toBeTruthy()
    }
    expect(screen.getByTestId('machine-def-all-settings-count').textContent)
      .toBe(`${thcProfileOnly.length} settings`)
    expect(screen.queryByTestId('machine-def-all-settings-empty')).toBeNull()

    // Hidden from the panel, but buildSettingsIndex (WO-1695) still carries
    // every stated THC value - the record is untouched by display filtering.
    const index = buildSettingsIndex(uccncMachine())
    const statedThc = thcFields.filter((f) => index.find((r) => r.key === f.key)?.value !== null)
    expect(statedThc.length).toBeGreaterThan(0)
    for (const f of statedThc) {
      const row = index.find((r) => r.key === f.key)
      expect(row?.visible).toBe(false)
      expect(row?.value).not.toBeNull()
    }
  })

  it('editing a boolean writes True/False, the controller\'s own spelling', () => {
    // WO-1695: same reasoning as above - state plasma so the THC row is on
    // the panel; this test's purpose is the write path, not visibility.
    render(<Harness initial={uccncMachine('plasma')} />)
    act(() => { fireEvent.change(screen.getByLabelText('settings search'), { target: { value: 'thc' } }) })

    const box = screen.getByLabelText('IOsetupsettings.THCenable') as HTMLInputElement
    act(() => { fireEvent.click(box) })
    const first = box.getAttribute('value')
    expect(['True', 'False']).toContain(first)

    act(() => { fireEvent.click(box) })
    const second = box.getAttribute('value')
    expect(['True', 'False']).toContain(second)
    expect(second).not.toBe(first)
  })
})

describe('WO-1689 - a GRBL router', () => {
  it('shows 36 rows with names and units from the settings index', () => {
    const catalogued = Object.keys(GRBL_SETTINGS).map(Number)
    expect(catalogued).toHaveLength(34)
    const grblSettings: GrblSettingsRecord = {}
    for (const id of catalogued) grblSettings[id] = String(id)
    grblSettings[33] = '0'
    grblSettings[34] = '0'

    render(<Harness initial={grblMachine(grblSettings)} />)

    const rows = screen.getAllByTestId(/^machine-def-all-settings-row-grbl-/)
    expect(rows).toHaveLength(36)

    const named = within(screen.getByTestId(rowTestId('grbl', '$0')))
    expect(named.getAllByText('Step pulse time')).toHaveLength(2) // Setting column and "What it does"
    expect(named.getByText('us')).toBeTruthy()

    const unnamed = screen.getByTestId(rowTestId('grbl', '$33'))
    expect(unnamed.textContent).toContain('$33')
  })
})

describe('WO-1689 - wired into the real panel, not just the harness', () => {
  // The composition root (`MachineDefinitionPanel.tsx`) is outside this
  // order's owned paths, but the outcome ("one table under the All settings
  // tab") is unreachable without a render branch there - see this file's
  // Worker result for the decide-and-log call. This proves that branch really
  // renders `AllSettingsTable` with real panel state, not just that the
  // isolated harness above works.
  const mem = new Map<string, string>()
  const memStorage: Storage = {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key) => mem.get(key) ?? null,
    key: (index) => [...mem.keys()][index] ?? null,
    removeItem: (key) => { mem.delete(key) },
    setItem: (key, value) => { mem.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

  it('the "All settings" tab shows real rows, and the bar search box lands there from another tab', async () => {
    const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
    const { useCamStore } = await import('../../store')
    // WO-1695: THC is plasma-only and hidden on a router (kind absent). This
    // test's purpose is proving the real panel wires the tab and search bar,
    // not kind-visibility, so it states plasma to keep the 29 rows on-screen.
    const machine = uccncMachine('plasma')
    act(() => {
      useCamStore.setState({
        machineLibrary: [machine],
        project: { ...useCamStore.getState().project, machine },
        consoleEvents: [],
      })
    })
    render(<MachineDefinitionPanel />)

    // Starts on Overview; typing in the bar's search box lands on All
    // settings without a click.
    expect(screen.getByTestId('machine-def-tab-overview').getAttribute('aria-selected')).toBe('true')
    act(() => {
      fireEvent.change(screen.getByTestId('machine-def-bar-search'), { target: { value: 'thc' } })
    })
    expect(screen.getByTestId('machine-def-tab-allSettings').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('machine-def-all-settings-table')).toBeTruthy()
    const catalogueRows = thcFields.map((field) => screen.getByTestId(rowTestId('uccnc', field.key)))
    const profileRows = thcProfileOnly.map((setting) => screen.getByTestId(rowTestId(
      'uccnc-profile', `${setting.section}.${setting.key}`,
    )))
    expect(catalogueRows).toHaveLength(29)
    expect(profileRows).toHaveLength(4)
    // No placeholder for the tab this order actually filled in.
    expect(screen.queryByTestId('machine-def-section-placeholder-allSettings')).toBeNull()
  })
})

describe('WO-1689 - the .pro export is content-identical before and after', () => {
  it('browsing, searching and filtering writes nothing to the definition', () => {
    const before = exportUccncProfile(importUccncProfile(PROFILE_TEXT).definition).text
    let latest: MachineConfig | null = null

    render(<Harness initial={uccncMachine()} onDraft={(m) => { latest = m }} />)
    act(() => { fireEvent.change(screen.getByLabelText('settings search'), { target: { value: 'spindle' } }) })
    act(() => {
      fireEvent.change(screen.getByTestId('machine-def-all-settings-group'), { target: { value: 'General' } })
    })
    act(() => {
      fireEvent.change(screen.getByTestId('machine-def-all-settings-show'), { target: { value: 'stated' } })
    })

    expect(latest).not.toBeNull()
    const after = exportUccncProfile(latest!.controllerDefinition).text
    expect(after).toBe(before)
  })
})

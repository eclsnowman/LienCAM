// @vitest-environment jsdom
//
// WO-1761 - All settings shows the whole imported file, clearly separates
// UCCNC-only values, filters to LienCAM's catalogue, and owns an obvious
// scroll path.

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { MachineConfig } from '../../types'
import { AllSettingsTable } from '../../components/machine/definition/AllSettingsTable'
import { createSettingSource } from '../../components/machine/definition/DefinitionFields'
import {
  PERSIST_STORE_VERSION,
  persistMerge,
  persistMigrate,
  persistPartialize,
  useCamStore,
} from '../../store'
import {
  UCCNC_CATALOGUE_CONTROLLER,
  UCCNC_SETTING_FIELDS,
  importUccncProfile,
  uccncProfileOnlySettings,
  uccncSettingField,
} from '../../lib/machine/uccncProfileImport'
import { exportUccncProfile } from '../../lib/machine/uccncProfileExport'

afterEach(() => { cleanup() })

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILE_TEXT = readFileSync(resolve(HERE, '../../..', 'docs/machine/profiles/LienCNCV2.pro'), 'utf8')

function machineFromProfile(text: string, id = 'wo1761'): MachineConfig {
  const imported = importUccncProfile(text)
  return {
    id,
    name: imported.profileName ?? 'Imported UCCNC machine',
    type: 'gantry_router',
    kind: 'router',
    controller: 'uccnc',
    travel: imported.travel ?? { x: 0, y: 0, z: 0 },
    rapidRate: 5000,
    maxSpindleRpm: 24000,
    minSpindleRpm: 8000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
    controllerDefinition: imported.definition ?? undefined,
    unsentSettings: imported.unsent,
  }
}

/** The exact Zustand persist pipeline a browser refresh runs. */
function reloadThroughProductionStore(machine: MachineConfig): MachineConfig {
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

function Harness({ initial }: { initial: MachineConfig }) {
  const [draft, setDraft] = useState(initial)
  const unsent = createSettingSource({
    definition: draft.controllerDefinition ?? null,
    unsent: draft.unsentSettings,
    controller: draft.controller,
    catalogue: UCCNC_CATALOGUE_CONTROLLER,
    field: uccncSettingField,
    patch: (mut) => {
      setDraft((machine) => machine.controllerDefinition
        ? { ...machine, controllerDefinition: mut(machine.controllerDefinition) }
        : machine)
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
    <AllSettingsTable
      draft={draft}
      source={initial}
      unsent={unsent}
      editDraft={setDraft}
      settingSearch=""
    />
  )
}

const rowId = (key: string) => `machine-def-all-settings-row-uccnc-profile-${key}`

/** Independently read every Section.Key=Value from the fixture. */
function fileValues(text: string): { section: string; key: string; value: string }[] {
  const values: { section: string; key: string; value: string }[] = []
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header) { section = header[1].trim(); continue }
    const eq = line.indexOf('=')
    if (section !== '' && eq > 0) {
      values.push({ section, key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() })
    }
  }
  return values
}

describe('WO-1761 - Operator\'s imported profile', () => {
  it('keeps every non-catalogue file value and renders every one of its 17 sections read-only', () => {
    const machine = machineFromProfile(PROFILE_TEXT)
    const catalogue = new Set(UCCNC_SETTING_FIELDS.map((field) => field.key.toLowerCase()))
    const expected = fileValues(PROFILE_TEXT)
      .filter((entry) => !catalogue.has(`${entry.section}.${entry.key}`.toLowerCase()))
      .map((entry) => ({ controller: 'uccnc', ...entry }))
    const kept = uccncProfileOnlySettings(machine.controllerDefinition)

    expect(kept).toEqual(expected)
    expect(new Set(kept.map((entry) => entry.section))).toHaveLength(17)

    render(<Harness initial={machine} />)
    const group = screen.getByTestId('machine-def-all-settings-group')
    for (const section of new Set(kept.map((entry) => entry.section))) {
      act(() => { fireEvent.change(group, { target: { value: section } }) })
      const expectedRows = kept.filter((entry) => entry.section === section)
      const rows = screen.getAllByTestId(/^machine-def-all-settings-row-uccnc-profile-/)
      expect(rows).toHaveLength(expectedRows.length)
      expect(rows.every((row) => row.getAttribute('data-liencam-use') === 'not-used')).toBe(true)
      expect(rows.every((row) => row.textContent?.includes('Not used by LienCAM'))).toBe(true)
      expect(rows.every((row) => row.querySelector('input, select, textarea') === null)).toBe(true)
    }
  })

  it('keeps the unused sections through production save/reload and a definition edit clone', () => {
    const imported = machineFromProfile(PROFILE_TEXT, 'wo1761-persisted')
    const before = uccncProfileOnlySettings(imported.controllerDefinition)
    const reloaded = reloadThroughProductionStore(imported)
    expect(uccncProfileOnlySettings(reloaded.controllerDefinition)).toEqual(before)

    let editedDefinition = reloaded.controllerDefinition!
    const source = createSettingSource({
      definition: editedDefinition,
      unsent: reloaded.unsentSettings,
      controller: reloaded.controller,
      catalogue: UCCNC_CATALOGUE_CONTROLLER,
      field: uccncSettingField,
      patch: (mut) => { editedDefinition = mut(editedDefinition) },
      pending: {},
      setPending: () => {},
      reportAbsent: () => {},
      reportRefused: () => {},
      owner: reloaded,
      hideEmpty: false,
      unused: () => false,
    })
    expect(source.read('Generalsettings.Lookaheadlines')).toBe('300')
    source.write('Generalsettings.Lookaheadlines', '301')
    expect(editedDefinition).not.toBe(reloaded.controllerDefinition)
    expect(uccncProfileOnlySettings(editedDefinition)).toEqual(before)
    expect(editedDefinition.settings?.some((setting) =>
      setting.key.toLowerCase() === 'hotkeysettings.keycode1')).toBe(false)
    const exported = fileValues(exportUccncProfile(
      editedDefinition,
      { profileName: reloaded.name },
    ).text)
    expect(exported.find((entry) =>
      entry.section === 'Hotkeysettings' && entry.key === 'Keycode1')?.value).toBe('0')
    expect(before.find((entry) =>
      entry.section === 'Hotkeysettings' && entry.key === 'Keycode1')?.value).toBe('39')

    render(<Harness initial={{ ...reloaded, controllerDefinition: editedDefinition }} />)
    act(() => {
      fireEvent.change(screen.getByTestId('machine-def-all-settings-group'), {
        target: { value: 'Hotkeysettings' },
      })
    })
    expect(screen.getByTestId(rowId('Hotkeysettings.Keycode1')).textContent).toContain('39')
  })

  it('shows exact screen-set and hotkey values, then the filter removes only non-catalogue rows and reports both totals', () => {
    const machine = machineFromProfile(PROFILE_TEXT)
    render(<Harness initial={machine} />)

    const group = screen.getByTestId('machine-def-all-settings-group')
    act(() => { fireEvent.change(group, { target: { value: 'Screensetsettings' } }) })
    expect(screen.getByTestId(rowId('Screensetsettings.mainscreenfilename')).textContent)
      .toContain('LienCNCV2 (3Axis)')
    act(() => { fireEvent.change(group, { target: { value: 'Hotkeysettings' } }) })
    expect(screen.getByTestId(rowId('Hotkeysettings.Keycode1')).textContent).toContain('39')

    const total = screen.getAllByTestId(/^machine-def-all-settings-row-uccnc-profile-/).length
    act(() => { fireEvent.click(screen.getByTestId('machine-def-all-settings-used-only')) })
    expect(screen.queryByTestId(rowId('Hotkeysettings.Keycode1'))).toBeNull()
    expect(screen.getByTestId('machine-def-all-settings-count').textContent)
      .toBe(`0 of ${total} settings shown`)

    act(() => { fireEvent.click(screen.getByTestId('machine-def-all-settings-used-only')) })
    expect(screen.getByTestId(rowId('Hotkeysettings.Keycode1'))).toBeTruthy()
  })

  it('uses a permanent scrollbar track and stable gutter on the table viewport', () => {
    render(<Harness initial={machineFromProfile(PROFILE_TEXT)} />)
    const viewport = screen.getByTestId('machine-def-all-settings-viewport') as HTMLElement
    const scrollbar = screen.getByTestId('machine-def-all-settings-scrollbar') as HTMLElement
    expect(viewport.style.overflowY).toBe('scroll')
    expect(viewport.style.scrollbarGutter).toBe('stable')
    expect(viewport.style.scrollbarColor).not.toBe('')
    expect(scrollbar.getAttribute('role')).toBe('scrollbar')
    expect(scrollbar.style.width).toBe('12px')
    Object.defineProperty(viewport, 'clientHeight', { value: 480, configurable: true })
    Object.defineProperty(viewport, 'scrollHeight', { value: 1200, configurable: true })
    act(() => { fireEvent.keyDown(scrollbar, { key: 'ArrowDown' }) })
    expect(viewport.scrollTop).toBe(30)
  })
})

describe('WO-1761 - a profile without UCCNC-only sections', () => {
  it('does not invent empty placeholder sections', () => {
    const profile = [
      '[axessettingscontrolX]', 'Axisenabled=True',
      '[axessettingscontrolY]', 'Axisenabled=True',
      '[axessettingscontrolZ]', 'Axisenabled=True',
      '[Generalsettings]', 'Profilename=Catalogue only',
    ].join('\n')
    const machine = machineFromProfile(profile, 'wo1761-catalogue-only')
    expect(uccncProfileOnlySettings(machine.controllerDefinition)).toEqual([])

    render(<Harness initial={machine} />)
    expect(screen.queryByTestId(/^machine-def-all-settings-row-uccnc-profile-Screensetsettings\./)).toBeNull()
    expect([...screen.getByTestId('machine-def-all-settings-group').querySelectorAll('option')]
      .map((option) => option.textContent)).not.toContain('Screensetsettings')
  })
})

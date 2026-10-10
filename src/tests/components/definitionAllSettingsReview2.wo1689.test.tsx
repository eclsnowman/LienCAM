// @vitest-environment jsdom
//
// WO-1689 REVIEW 2 (safety path, fresh after the blur/Enter fix).
//
// Pins the three properties the fix has to hold beyond "records on blur":
// Enter followed by the blur that comes after it records ONCE; held text is
// keyed by setting id, so a filter that unmounts the row mid-edit cannot move
// the text onto another setting; and an unchanged value records nothing.

import { describe, expect, it, afterEach } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { MachineConfig } from '../../types'
import { AllSettingsTable } from '../../components/machine/definition/AllSettingsTable'
import { createSettingSource } from '../../components/machine/definition/DefinitionFields'
import { UCCNC_CATALOGUE_CONTROLLER, uccncSettingField } from '../../lib/machine/uccncProfileImport'
import { recordGrblSettings, type GrblSettingsRecord } from '../../lib/machine/grbl/settings'

afterEach(() => { cleanup() })

function grblMachine(settings: GrblSettingsRecord): MachineConfig {
  return recordGrblSettings({
    id: 'wo1689-review2-grbl', name: 'Shapeoko', type: 'gantry_router', controller: 'grbl',
    travel: { x: 400, y: 400, z: 100 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
  }, settings)
}

function Harness({ initial, search, record }: {
  initial: MachineConfig
  search: string
  record: { edits: number; latest: MachineConfig | null }
}) {
  const [draft, setDraft] = useState(initial)
  record.latest = draft
  const editDraft = (mut: (m: MachineConfig) => MachineConfig) => {
    record.edits += 1
    setDraft(mut)
  }
  const unsent = createSettingSource({
    definition: draft.controllerDefinition ?? null,
    unsent: draft.unsentSettings,
    controller: draft.controller,
    catalogue: UCCNC_CATALOGUE_CONTROLLER,
    field: uccncSettingField,
    patch: () => {},
    pending: {},
    setPending: () => {},
    reportAbsent: () => {},
    reportRefused: () => {},
    owner: draft,
    hideEmpty: false,
    unused: () => false,
  })
  return (
    <AllSettingsTable draft={draft} source={initial} unsent={unsent} editDraft={editDraft} settingSearch={search} />
  )
}

describe('WO-1689 review 2 - GRBL boxes record once, on the right setting', () => {
  it('Enter then blur records $30 exactly once', () => {
    const record = { edits: 0, latest: null as MachineConfig | null }
    render(<Harness initial={grblMachine({ 30: '24000', 31: '8000' })} search="" record={record} />)
    const box = screen.getByLabelText('$30') as HTMLInputElement
    act(() => { fireEvent.change(box, { target: { value: '18000' } }) })
    act(() => { fireEvent.keyDown(box, { key: 'Enter' }) })
    act(() => { fireEvent.blur(box) })
    expect(record.edits).toBe(1)
    expect(record.latest!.maxSpindleRpm).toBe(18000)
  })

  it('blurring an unchanged box (or one retyped to its own value) records nothing', () => {
    const record = { edits: 0, latest: null as MachineConfig | null }
    render(<Harness initial={grblMachine({ 30: '24000' })} search="" record={record} />)
    const box = screen.getByLabelText('$30') as HTMLInputElement
    act(() => { fireEvent.blur(box) })
    act(() => { fireEvent.change(box, { target: { value: ' 24000 ' } }) })
    act(() => { fireEvent.blur(box) })
    expect(record.edits).toBe(0)
  })

  it('a filter that unmounts a half-typed row never lands the text on another setting', () => {
    const record = { edits: 0, latest: null as MachineConfig | null }
    const initial = grblMachine({ 30: '24000', 31: '8000' })
    const { rerender } = render(<Harness initial={initial} search="" record={record} />)
    act(() => { fireEvent.change(screen.getByLabelText('$30'), { target: { value: '12' } }) })

    // The row for $30 leaves the window; $31 stays and shows its own value.
    rerender(<Harness initial={initial} search="$31" record={record} />)
    expect(screen.queryByLabelText('$30')).toBeNull()
    const other = screen.getByLabelText('$31') as HTMLInputElement
    expect(other.value).toBe('8000')
    act(() => { fireEvent.blur(other) })
    expect(record.edits).toBe(0)
    expect(record.latest!.maxSpindleRpm).toBe(24000)
    expect(record.latest!.minSpindleRpm).toBe(8000)
  })
})

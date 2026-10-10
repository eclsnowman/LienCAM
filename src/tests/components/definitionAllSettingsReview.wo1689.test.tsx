// @vitest-environment jsdom
//
// WO-1689 REVIEW (safety path) - proving test.
//
// A GRBL box on the All settings tab writes EVERY KEYSTROKE through
// `recordGrblSettings`, which derives named machine fields ($30 -> the
// spindle maximum, $130..132 -> travel and soft limits, $3 -> direction pin
// polarity) from the text. A browser fires one change per keystroke, so
// backspacing "24000" out of $30 records "2400", "240", "24", "2" and then
// "". The empty text derives nothing, so the spindle maximum is left at the
// LAST PREFIX - 2 RPM - and `resolveSpindle` then clamps every posted S word
// to 2. `GrblSettingsTable` (the existing editor) commits once, on blur/Enter,
// so the same clear leaves the spindle maximum at 24000.

import { describe, expect, it, afterEach } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { MachineConfig } from '../../types'
import { AllSettingsTable } from '../../components/machine/definition/AllSettingsTable'
import { createSettingSource } from '../../components/machine/definition/DefinitionFields'
import { UCCNC_CATALOGUE_CONTROLLER, uccncSettingField } from '../../lib/machine/uccncProfileImport'
import { recordGrblSettings, type GrblSettingsRecord } from '../../lib/machine/grbl/settings'

afterEach(() => { cleanup() })

function Harness({ initial, onDraft }: { initial: MachineConfig; onDraft: (m: MachineConfig) => void }) {
  const [draft, setDraft] = useState(initial)
  useEffect(() => { onDraft(draft) }, [draft, onDraft])
  const editDraft = (mut: (m: MachineConfig) => MachineConfig) => { setDraft(mut) }
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
    <AllSettingsTable draft={draft} source={initial} unsent={unsent} editDraft={editDraft} settingSearch="" />
  )
}

function grblMachine(settings: GrblSettingsRecord): MachineConfig {
  return recordGrblSettings({
    id: 'wo1689-review-grbl', name: 'Shapeoko', type: 'gantry_router', controller: 'grbl',
    travel: { x: 400, y: 400, z: 100 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
  }, settings)
}

/** Backspace a box one character at a time, the way a browser reports it. */
function backspaceToEmpty(box: HTMLInputElement) {
  for (let text = box.value; text.length > 0;) {
    text = text.slice(0, -1)
    act(() => { fireEvent.change(box, { target: { value: text } }) })
  }
}

describe('WO-1689 review - clearing a GRBL box does not leave a half-typed value in a named field', () => {
  it('backspacing $30 (spindle max) to empty keeps the spindle maximum it had', () => {
    let latest: MachineConfig | null = null
    const initial = grblMachine({ 30: '24000', 31: '8000', 130: '400', 131: '400', 132: '100' })
    expect(initial.maxSpindleRpm).toBe(24000)
    render(<Harness initial={initial} onDraft={(m) => { latest = m }} />)

    backspaceToEmpty(screen.getByLabelText('$30') as HTMLInputElement)

    // GrblSettingsTable commits "" once and keeps 24000. Here it is 2.
    expect(latest!.maxSpindleRpm).toBe(24000)
  })

  it('backspacing $130 (X max travel) to empty keeps the X travel it had', () => {
    let latest: MachineConfig | null = null
    render(<Harness initial={grblMachine({ 130: '400', 131: '400', 132: '100' })} onDraft={(m) => { latest = m }} />)

    backspaceToEmpty(screen.getByLabelText('$130') as HTMLInputElement)

    expect(latest!.travel.x).toBe(400)
  })
})

describe('WO-1689 fix - a GRBL box records the whole value once, on blur or Enter', () => {
  it('typing 18000 into $30 records nothing until blur, then the spindle maximum is 18000', () => {
    let latest: MachineConfig | null = null
    render(<Harness initial={grblMachine({ 30: '24000' })} onDraft={(m) => { latest = m }} />)
    const box = screen.getByLabelText('$30') as HTMLInputElement

    backspaceToEmpty(box)
    for (const text of ['1', '18', '180', '1800', '18000']) {
      act(() => { fireEvent.change(box, { target: { value: text } }) })
    }
    expect(box.value).toBe('18000')
    expect(latest!.maxSpindleRpm).toBe(24000)

    act(() => { fireEvent.blur(box) })
    expect(latest!.grblSettings?.[30]).toBe('18000')
    expect(latest!.maxSpindleRpm).toBe(18000)
  })

  it('Enter records $130 and the X travel follows', () => {
    let latest: MachineConfig | null = null
    render(<Harness initial={grblMachine({ 130: '400', 131: '400', 132: '100' })} onDraft={(m) => { latest = m }} />)
    const box = screen.getByLabelText('$130') as HTMLInputElement

    act(() => { fireEvent.change(box, { target: { value: '650' } }) })
    expect(latest!.travel.x).toBe(400)
    act(() => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(latest!.travel.x).toBe(650)
    expect(box.value).toBe('650')
  })
})

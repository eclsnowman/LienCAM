// @vitest-environment jsdom
//
// WO-1684 review (safety path): can a per-kind control write a value the
// controller reads differently from what the operator saw? Drives the real
// SettingBox against the real catalogue and parser; the source is a minimal
// stand-in that records every write and keeps what parses.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { SettingBox, type SettingSource } from '../../components/machine/definition/DefinitionFields'
import {
  uccncSettingField, parseUccncSettingValue, formatUccncSettingValue, axisDriveAppKey,
} from '../../lib/machine/uccncProfileImport'

afterEach(() => { cleanup() })

/** Writes land as the store would keep them: the typed value re-formatted,
 *  and unparseable text kept only as pending (never stored). */
function Harness({ settingKey, initial, log }: {
  settingKey: string; initial: string | null; log: { written: string[]; stored: (string | null)[] }
}) {
  const [pending, setPending] = useState<string | null>(initial)
  const field = uccncSettingField(settingKey)
  const source = {
    catalogued: true,
    ownedElsewhere: () => false,
    textOnly: () => false,
    unused: () => false,
    hideEmpty: false,
    read: () => pending,
    has: () => pending !== null,
    hasPrefix: () => false,
    invalid: () => pending !== null && pending !== '' && field !== undefined
      && !parseUccncSettingValue(field, pending).ok,
    reportAbsent: () => {},
    describe: () => field,
    // WO-1728: the driven answer is the production raw-key to app-key mapping,
    // not a list this fixture copies. None of this suite's keys are axis drive
    // settings, so every box here keeps its not-driven provenance and the
    // kind/write expectations below are untouched.
    driven: (key: string) => axisDriveAppKey(key) !== undefined,
    write: (_key: string, text: string) => {
      log.written.push(text)
      setPending(text)
      const parsed = field ? parseUccncSettingValue(field, text) : null
      log.stored.push(parsed && parsed.ok ? formatUccncSettingValue(parsed.value) : null)
    },
  } as unknown as SettingSource
  return <SettingBox label="" settingKey={settingKey} settings={source} />
}

function mount(settingKey: string, initial: string | null) {
  const log = { written: [] as string[], stored: [] as (string | null)[] }
  const view = render(<Harness settingKey={settingKey} initial={initial} log={log} />)
  return { log, root: view.container }
}

describe('WO-1684 review - what the operator sees is what the controller reads', () => {
  it('1. boolean writes UCCNC True/False, the same text the parser takes', () => {
    const key = 'Generalsettings.Constantvelocitymode'
    expect(uccncSettingField(key)?.kind).toBe('boolean')
    const { log, root } = mount(key, 'True')
    const box = root.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(true)
    act(() => { fireEvent.click(box) })
    act(() => { fireEvent.click(box) })
    expect(log.written).toEqual(['False', 'True'])
    expect(log.stored).toEqual(['False', 'True'])
  })

  it('2. enum keeps an unlisted stated value selected and writes options verbatim', () => {
    const key = 'Probing.Simple'
    const field = uccncSettingField(key)
    expect(field?.kind).toBe('tuple')
    const { log, root } = mount(key, 'Q,5')
    const select = root.querySelector('select') as HTMLSelectElement
    expect(select.value, 'unlisted axis must stay shown, not become X').toBe('Q')
    act(() => { fireEvent.change(select, { target: { value: 'B' } }) })
    expect(log.written).toEqual(['B,5'])
  })

  it('2b. a stated EMPTY enum part is not shown as the first option', () => {
    const key = 'Probing.Simple'
    const field = uccncSettingField(key)!
    // The parser accepts an empty enum part, so this is a storable value.
    expect(parseUccncSettingValue(field, ',5').ok).toBe(true)
    const { root } = mount(key, ',5')
    const select = root.querySelector('select') as HTMLSelectElement
    expect(select.value, 'the controller holds "", the operator must not see X').toBe('')
  })

  it('3. a tuple edit keeps every untouched part byte-for-byte', () => {
    const key = 'Probing.Simple'
    const { log, root } = mount(key, 'Z,9.75')
    const num = root.querySelectorAll('input')[0] as HTMLInputElement
    expect(num.value).toBe('9.75')
    act(() => { fireEvent.change(num, { target: { value: '9.50' } }) })
    expect(log.written).toEqual(['Z,9.50'])
    const select = root.querySelector('select') as HTMLSelectElement
    act(() => { fireEvent.change(select, { target: { value: 'Y' } }) })
    expect(log.written[1]).toBe('Y,9.50')
  })

  it('4. a half-typed number never reaches the store as a number', () => {
    const key = 'Generalsettings.Linearerror'
    expect(uccncSettingField(key)?.kind).toBe('number')
    const { log, root } = mount(key, '0.03')
    const box = root.querySelector('input') as HTMLInputElement
    for (const text of ['-', '.', '1e', 'abc', '0.0.3']) {
      act(() => { fireEvent.change(box, { target: { value: text } }) })
    }
    expect(log.stored).toEqual([null, null, null, null, null])
    expect(box.value).toBe('0.0.3')
    expect(box.getAttribute('aria-invalid')).toBe('true')
  })
})

// @vitest-environment jsdom
//
// WO-1038 - THE `.pro` EXPORT, AND THE RULER IT IS.
//
// ADR-0044 requirement 5 is the primary one and requirement 4 falls out of it:
//
//   5. A definition built entirely in our UI, with no `.pro` behind it, must
//      emit a profile carrying EVERY feature a UCCNC-authored `.pro` carries.
//   4. Import a `.pro`, export it back, and every setting it carried must come
//      back with the same MEANING AND VALUE - not the same bytes.
//
// SO THIS SUITE IS A MEASUREMENT BEFORE IT IS A REGRESSION TEST. Operator,
// 2026-08-26: *"Thats how I can gauge that we have all the required element in
// our UI to support all the capabilities UCCNC possesses."* The number it
// publishes is asserted here and written to `src/tests/evidence/WO-1038/` so
// it can be read without running anything.
//
// WHAT THE NUMBERS ARE, MEASURED 2026-08-26 ON OPERATOR'S OWN `LienCNCV2.pro`:
//
//   ROUND TRIP        1680 of 1680 machine-configuration keys, 0 value
//                     mismatches. Requirement 4 passes today.
//   FROM SCRATCH      1680 gaps of 1680. Requirement 5 fails today, and the
//                     failure is REPORTED rather than papered over - the work
//                     order permits landing with a non-zero gap provided the
//                     number is published, because it is measuring a model
//                     WO-1037 and WO-1039 build, not one this order fixes.
//
// WHY FROM-SCRATCH READS THE FULL WIDTH, and it is a finding rather than a
// bug in the exporter. A blank definition's `axes[X].maxVelocity` is 6000
// because `createDefaultAxisDefinition` put it there, NOT because anybody said
// so, and `ControllerDefinition.stated` is empty for exactly that reason -
// *"the fields are populated, their provenance is not"* (types/index.ts).
// Emitting those 216 named-field values would write this software's defaults
// into a file Operator loads into UCCNC and sets his machine from. That is
// `4dcf9701` - the invented home back-off - in a new container, and it reached
// his machine once already. The gauge reports them as
// `named-field-unstated`: present in the UI, missing only their provenance.
// WO-1039 - the editor that writes a user's value into
// `ControllerDefinition.settings`, where presence IS the statement - is what
// moves the number, and it can only move down.
//
// AND WHAT ZERO WOULD MEAN IF IT EVER READ ZERO (ADR-0044, "THE GAUGE HAS A
// BLIND SPOT"): "our definition can express everything a `.pro` expresses",
// and nothing more. NOT "we are a UCCNC replacement" - Operator's Modbus spindle
// is 72 profile keys we would count as covered describing a spindle we still
// could not turn, because that capability is delivered by a UCCNC PLUGIN.
//
// NOT PROVEN HERE AND NOT CLAIMED: whether UCCNC actually loads the file. That
// needs UCCNC. This asserts structural conformance and the gap count, which is
// exactly what the work order scopes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { proExportSummary } from '../../lib/machine/operatorMessages'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { MachineConfig } from '../../types'
import {
  createDefaultControllerDefinition,
  DEFAULT_AXIS_MAX_VELOCITY,
} from '../../types'
import {
  UCCNC_SETTING_FIELDS,
  importUccncProfile,
  parseUccncSettingValue,
  uccncSettingField,
} from '../../lib/machine/uccncProfileImport'
import {
  CONFIG_SECTION_NAMES,
  exportUccncProfile,
  formatProfileGap,
  measureProfileGap,
  parseProfileKeys,
} from '../../lib/machine/uccncProfileExport'

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). Same in-memory shim the other modal
// suites use, installed BEFORE the store import. No app change.
const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } as Storage,
})

const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const {
  PERSIST_STORE_VERSION,
  persistMerge,
  persistMigrate,
  persistPartialize,
  useCamStore,
} = await import('../../store')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const PROFILE = resolve(ROOT, 'docs/machine/profiles/LienCNCV2.pro')
const EVIDENCE = resolve(HERE, '../evidence/WO-1038')

const profileText = readFileSync(PROFILE, 'utf8')

const missingBoardIssue = [{
  key: 'Statistics.UCdevicetype',
  message: 'expected a positive DeviceInfo type or board name, found nothing',
}]

/**
 * The architect's saved-clear reproduction, through every production boundary:
 * Controller-area select -> panel Save -> Zustand's persist serializer,
 * migration and merge -> a newly mounted surface. JSON is deliberately in the
 * middle because that is the boundary that drops an `undefined` property.
 */
function clearBoardSaveAndReload(machine: MachineConfig): MachineConfig {
  act(() => {
    useCamStore.setState((state) => ({
      machineLibrary: [machine],
      project: { ...state.project, machine },
      consoleEvents: [],
      activeModal: null,
    }))
  })
  render(createElement(MachineDefinitionPanel))
  act(() => { fireEvent.click(screen.getByTestId('machine-def-tab-controller')) })
  const board = screen.getByTestId('machine-def-controller-board-select') as HTMLSelectElement
  expect(board.value).toBe('19')
  act(() => { fireEvent.change(board, { target: { value: '' } }) })
  act(() => { fireEvent.click(screen.getByTestId('machine-def-panel-save')) })

  const saved = useCamStore.getState().machineLibrary.find((entry) => entry.id === machine.id)!
  expect(saved.controllerBoard).toBeUndefined()

  const serialized = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))
  const migrated = persistMigrate(serialized, PERSIST_STORE_VERSION)
  const reloaded = persistMerge(migrated, useCamStore.getState())
  const restored = reloaded.machineLibrary.find((entry) => entry.id === machine.id)!
  expect('controllerBoard' in restored).toBe(false)

  cleanup()
  act(() => {
    useCamStore.setState({
      machineLibrary: reloaded.machineLibrary,
      project: reloaded.project,
      consoleEvents: [],
      activeModal: null,
    })
  })
  return restored
}

function verifyEvidence(name: string, text: string): void {
  const evidencePath = resolve(EVIDENCE, name)
  if (process.env.WRITE_EVIDENCE !== undefined) {
    mkdirSync(EVIDENCE, { recursive: true })
    writeFileSync(evidencePath, text, 'utf8')
  } else {
    const expected = readFileSync(evidencePath, 'utf8').replace(/\r\n/g, '\n')
    expect(expected).toBe(text)
  }
}

/** Every `Section.Key` a file states, with its verbatim text, lower-cased so
 *  the two ends agree the way a case-insensitive `.pro` does. */
function keyValues(text: string): Map<string, string> {
  const out = new Map<string, string>()
  let section: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[') && line.endsWith(']')) section = line.slice(1, -1)
    else if (section && line.includes('=')) {
      const at = line.indexOf('=')
      out.set(`${section}.${line.slice(0, at)}`.toLowerCase(), line.slice(at + 1))
    }
  }
  return out
}

/**
 * SAME MEANING AND VALUE - the comparison ADR-0044 requirement 4 actually
 * asks for. Both sides go through the catalogue's own parser, so `0` and
 * `0.0000` are the same fact, a tuple compares element by element, and
 * `True`/`true`/`1` are one boolean. Bytes, ordering, whitespace and numeric
 * spelling are NOT facts about a machine and are not compared.
 */
function sameFact(key: string, theirs: string, ours: string): boolean {
  if (theirs === ours) return true
  const field = uccncSettingField(key)
  if (!field) return false
  const a = parseUccncSettingValue(field, theirs)
  const b = parseUccncSettingValue(field, ours)
  return a.ok && b.ok && JSON.stringify(a.value) === JSON.stringify(b.value)
}

const configSections = new Set(CONFIG_SECTION_NAMES.map((name) => name.toLowerCase()))

/** Their machine-configuration keys, which is what the gauge is about. Runtime
 *  state and UCCNC's own application preferences are excluded BY ADR-0044
 *  Amendment 1, not by convenience. */
function theirConfigKeyValues(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of keyValues(text)) {
    if (configSections.has(key.slice(0, key.lastIndexOf('.')))) out.set(key, value)
  }
  return out
}

describe('WO-1038: import a .pro, export it back, and nothing about the machine changed', () => {
  it('every machine-configuration key returns with the same meaning and value', () => {
    const imported = importUccncProfile(profileText)
    expect(imported.definition).not.toBeNull()

    const written = exportUccncProfile(imported.definition, { profileName: imported.profileName })
    const ours = keyValues(written.text)
    const theirs = theirConfigKeyValues(profileText)

    const missing: string[] = []
    const mismatched: string[] = []
    for (const [key, value] of theirs) {
      const back = ours.get(key)
      if (back === undefined) missing.push(key)
      else if (!sameFact(key, value, back)) mismatched.push(`${key}: "${value}" -> "${back}"`)
    }

    // Named, never counted: a failure here must say WHICH key so the next
    // session reads a defect and not a number.
    expect(missing).toEqual([])
    expect(mismatched).toEqual([])
    expect(theirs.size).toBe(1680)
  })

  it('refuses a machine name carrying a line break - it could write a section that came from nowhere', () => {
    // Reachable through the product: machine-library JSON import accepts any
    // truthy name, and handleExportPro passes it straight in. A CR/LF after
    // the name would start a new INI line the loader reads as a real key.
    const imported = importUccncProfile(profileText)
    const poisoned = 'Safe name\r\n[IOsetupsettings]\r\nEstopportnumber=7'
    expect(() => exportUccncProfile(imported.definition, { profileName: poisoned }))
      .toThrow(/line break/)
    // And the honest name still writes exactly one identity line.
    const clean = exportUccncProfile(imported.definition, { profileName: 'Safe name' }).text
    expect(clean.match(/^Profilename=/gm)).toHaveLength(1)
    expect(clean).not.toMatch(/Estopportnumber=7/)
  })

  it('content-identical, NOT byte-identical - a respelled number is the same fact', () => {
    // `Velocity=9000` respelled as `9000.0000`. Operator withdrew byte-identity by
    // name ("Byte identical was wrong wording. Content identical is the
    // goal."), so this asserts the export gives the VALUE back and is free to
    // spell it differently.
    const respelled = profileText.replace('Velocity=9000', 'Velocity=9000.0000')
    expect(respelled).not.toBe(profileText)

    const imported = importUccncProfile(respelled)
    const written = exportUccncProfile(imported.definition)
    const back = keyValues(written.text).get('axessettingscontrolx.velocity')

    expect(back).toBe('9000')
    expect(sameFact('axessettingscontrolX.Velocity', '9000.0000', back!)).toBe(true)
    expect(written.text).not.toBe(respelled)
  })

  it('UCCNC counts a drive enable delay in 10 ms steps and it comes back in them', () => {
    // THE 10x TRAP, both ends. The importer multiplies by 10 into
    // milliseconds; the exporter is the only place that divides back.
    const raised = profileText.replace('Enabledelay=0', 'Enabledelay=25')
    const imported = importUccncProfile(raised)
    expect(imported.definition!.axes.find((a) => a.axis === 'X')!.enableDelayMs).toBe(250)

    const written = exportUccncProfile(imported.definition)
    expect(keyValues(written.text).get('axessettingscontrolx.enabledelay')).toBe('25')
  })

  it('a key the profile never stated is ABSENT and REPORTED, never a default', () => {
    // Requirement 5's whole safety case in one key. `Softlimitpositive`
    // removed: `axes[X].softLimitMax` still reads 0 - that is the field's
    // default and motion code depends on it existing - but the export must
    // not write that 0 back out as though the machine had asked for it.
    // The strip is LINE-ENDING-INDEPENDENT (WO-1805): a git checkout may
    // hand this file LF or CRLF, and the control below must fail on both
    // platforms for the right reason - the key really gone - not because
    // the pattern silently matched nothing.
    const stripped = profileText.replace(/Softlimitpositive=738\r?\n/, '')
    expect(stripped).not.toBe(profileText)

    const imported = importUccncProfile(stripped)
    expect(imported.definition!.axes.find((a) => a.axis === 'X')!.softLimitMax).toBe(0)

    const written = exportUccncProfile(imported.definition)
    expect(keyValues(written.text).has('axessettingscontrolx.softlimitpositive')).toBe(false)

    const reported = written.absent.find(
      (entry) => entry.key === 'axessettingscontrolX.Softlimitpositive',
    )
    expect(reported).toBeDefined()
    expect(reported!.reason).toBe('not-stated')

    // And the negative limit, which the file DOES state, is still there - a
    // blanket refusal would pass the assertion above and prove nothing.
    expect(keyValues(written.text).get('axessettingscontrolx.softlimitnegative')).toBe('0')
  })

  it('the exported document is INI-shaped: every section a header, every key one line', () => {
    const written = exportUccncProfile(importUccncProfile(profileText).definition)
    expect(written.text.endsWith('\r\n')).toBe(true)
    // UCCNC's OWN SPELLING, INCLUDING THE UGLY BITS. `[ModbusEZ] HZ Range` has
    // a space in it and `[Plugins_enabled] Console.dll` has a dot; a pattern
    // that refused them would be refusing this machine's real keys, so the
    // shape asserted here is the file's - a header, or `key=value` on one
    // line - and nothing narrower.
    for (const line of written.text.split('\r\n')) {
      if (line === '') continue
      expect(line).toMatch(/^(\[[^\]]+\]|[^=[][^=]*=.*)$/)
    }
    // Every section in the file carries its keys - config from the definition,
    // state and preference from the baseline. A header with no keys under it
    // is only correct where the empty LIST is the statement, and that is the
    // two plugin sections and nothing else (see the baseline suite below).
    const sections = parseProfileKeys(written.text)
    const empty = [...sections].filter(([, keys]) => keys.length === 0).map(([name]) => name)
    expect(empty).toEqual(['Plugins_enabled', 'Plugins_callstartup'])
  })
})

// --- THE STATE AND PREFERENCE BLOCK ---------------------------------------
//
// ADR-0044 Amendment 1: *"An exported profile emits whatever valid values
// UCCNC needs to load, and the UI never presents them."* Those ~633 keys are
// NOT machine capabilities and NOT part of the gap count - so the danger is
// not that they are missing, it is that they quietly become a claim. These
// tests hold both ends: the block is COMPLETE against a real UCCNC-written
// profile, and it CANNOT touch the measurement.
//
// STILL NOT CLAIMED: that UCCNC opens the result. That needs UCCNC and a
// human, and the work order puts it out of scope. What is asserted here is
// structural conformance - the same sections, the same keys, values UCCNC
// itself wrote.
describe('WO-1038: runtime state and UCCNC preferences - filled in, and counted in nothing', () => {
  /** The sections of Operator's profile that are neither machine configuration nor
   *  this software's business - the ones Amendment 1 puts outside the bar. */
  const theirs = parseProfileKeys(profileText)
  const configSections = new Set(CONFIG_SECTION_NAMES.map((n) => n.toLowerCase()))

  it('emits every state and preference section UCCNC writes, with UCCNC\'s own keys', () => {
    const written = exportUccncProfile(createDefaultControllerDefinition())
    const ours = parseProfileKeys(written.text)

    // Their file's non-configuration sections, and ours must carry all of
    // them. A section we dropped would be a hole in a file UCCNC has to read.
    const theirState = [...theirs.keys()].filter((n) => !configSections.has(n.toLowerCase()))
    for (const section of theirState) expect(ours.has(section)).toBe(true)

    // AND THE KEYS INSIDE THEM, key for key. The two plugin sections are the
    // named exception: their key set is one entry per DLL in the USER'S
    // plugins folder, so software that has never seen that folder cannot
    // state it. The empty list is the whole statement - nothing enabled.
    const perInstall = new Set(['Plugins_enabled', 'Plugins_callstartup'])
    for (const section of theirState) {
      if (perInstall.has(section)) {
        expect(ours.get(section)).toEqual([])
        continue
      }
      expect([...(ours.get(section) ?? [])].sort())
        .toEqual([...(theirs.get(section) ?? [])].sort())
    }

    // The published width of the block, so a change to it is a deliberate
    // edit here: 271 keys of live runtime state and 362 of UCCNC's own
    // application preferences, less the 54 per-install plugin entries.
    expect(written.stateKeys.length).toBe(271 + 362 - 54)
  })

  it('every value it writes is one UCCNC itself wrote, or the zero of a machine that has not run', () => {
    const written = exportUccncProfile(createDefaultControllerDefinition())
    const oursByKey = keyValues(written.text)
    const theirsByKey = keyValues(profileText)

    // THIS IS THE VALIDITY CLAIM, AND IT IS ASSERTED RATHER THAN ASSUMED.
    // A value is allowed to be here only if UCCNC wrote that same value for
    // that same key, or it is the neutral `0`/empty of a key whose meaning
    // fixes it on a machine that has not run yet. Anything else would be this
    // software inventing a value - the one move the whole module refuses.
    const notFromUccnc: string[] = []
    for (const key of written.stateKeys) {
      const value = oursByKey.get(key.toLowerCase())!
      if (value === '0' || value === '') continue
      if (theirsByKey.get(key.toLowerCase()) === value) continue
      notFromUccnc.push(`${key}=${value}`)
    }
    // Exactly one, and it is named in the module: a profile's own screenset
    // filename points at a file on THAT machine, so carrying Operator's would
    // point somebody else's UCCNC at a screenset it does not have.
    expect(notFromUccnc).toEqual(['Screensetsettings.mainscreenfilename=Default'])

    // The two keys that name something other than runtime noise, checked
    // against a definition that states NOTHING (WO-1805). `Softwareversion`
    // names the writer: this software is not a build of UCCNC, so it is
    // present and EMPTY. `UCdevicetype` names the machine - and a blank
    // definition has no board, so it too stays EMPTY rather than guessing
    // 19, a BoardID, or a board from the exporting app. A machine that DOES
    // state a board carries it out; `controllerBoardExport.wo1805.test.ts`
    // holds that half.
    expect(oursByKey.get('statistics.ucdevicetype')).toBe('')
    expect(oursByKey.get('statistics.softwareversion')).toBe('')

    // And the live values are zero, not Operator's. His machine sits at X738 with
    // a G54 zero at 81.2275; a file we wrote must not say so about anybody.
    expect(oursByKey.get('machinecoords.machinecoordsx')).toBe('0')
    expect(oursByKey.get('workoffset_g54.workoffsetx')).toBe('0')
    expect(theirsByKey.get('machinecoords.machinecoordsx')).toBe('738')
  })

  it('the block is STATIC except the one modelled machine identity it must carry', () => {
    // Amendment 1 struck the verbatim carrier by name, because text carried
    // through untouched looks like coverage while proving none. So the block
    // an import produces and the block a blank definition produces are the
    // SAME BYTES - with exactly one exception, and the exception is only
    // legitimate because WO-1732 modelled the board as a machine fact: the
    // export carries the DECODED DeviceInfo type, not Operator's raw text, and
    // the exported machine is not the exporting application (WO-1805).
    // Everything else in the block still cannot be a channel for anything
    // of anybody's, and this test names the difference line by line.
    const fromImport = exportUccncProfile(importUccncProfile(profileText).definition)
    const fromScratch = exportUccncProfile(createDefaultControllerDefinition())
    expect(fromImport.stateKeys).toEqual(fromScratch.stateKeys)

    const block = (text: string): string =>
      text.slice(text.indexOf('[Tooltablevalues]'))
    const importedLines = block(fromImport.text).split('\r\n')
    const scratchLines = block(fromScratch.text).split('\r\n')
    expect(importedLines.length).toBe(scratchLines.length)
    const differing = importedLines.filter((line, i) => line !== scratchLines[i])
    expect(differing).toEqual(['UCdevicetype=19'])
    expect(scratchLines).toContain('UCdevicetype=')
  })

  it('writes the block down so it can be read without running anything', () => {
    const written = exportUccncProfile(createDefaultControllerDefinition())
    const ours = parseProfileKeys(written.text)
    const theirsByKey = keyValues(profileText)
    const oursByKey = keyValues(written.text)

    const out = [
      'UCCNC .pro EXPORT - THE RUNTIME-STATE AND APPLICATION-PREFERENCE BLOCK',
      '='.repeat(72),
      'ADR-0044 Amendment 1: these are NOT machine capabilities, the UI never',
      'presents them, they are NOT part of the gap count - and the file still',
      'has to carry them for UCCNC to load it. Written from a definition built',
      'from nothing, so nothing here comes from any imported profile.',
      '',
      `keys written                               : ${written.stateKeys.length}`,
      `machine-configuration keys (the gauge)     : ${written.emitted.length}`,
      '',
      'PER SECTION - "from UCCNC" means UCCNC itself wrote that exact value for',
      'that exact key in docs/machine/profiles/LienCNCV2.pro. "neutral" means the',
      '0 or empty of a key whose meaning fixes it on a machine that has not run.',
      '-'.repeat(72),
    ]
    for (const [section, keys] of ours) {
      if (!keys.some((k) => written.stateKeys.includes(`${section}.${k}`))) continue
      let fromUccnc = 0
      let neutral = 0
      for (const key of keys) {
        const value = oursByKey.get(`${section}.${key}`.toLowerCase())
        if (theirsByKey.get(`${section}.${key}`.toLowerCase()) === value) fromUccnc++
        else if (value === '0' || value === '') neutral++
      }
      out.push(`${String(keys.length).padStart(6)}  ${section.padEnd(26)} `
        + `${String(fromUccnc).padStart(4)} from UCCNC, ${String(neutral).padStart(4)} neutral`)
    }
    out.push('',
      'THE TWO SECTIONS WITH NO KEYS, and why the empty list is the statement:',
      '  Plugins_enabled / Plugins_callstartup - one key per DLL in the USER OWNED',
      '  plugins folder. Software that has never seen that folder cannot state',
      '  it, and an empty list is exactly "nothing enabled".',
      '',
      'THE ONE VALUE THAT CAME OUT OF NO PROFILE:',
      '  Screensetsettings.mainscreenfilename=Default - a screenset filename',
      '  names a file on THAT machine, so carrying one out of a profile would',
      '  point a different install at a screenset it does not have.',
      '',
      'NOT CLAIMED: that UCCNC opens the result. That needs UCCNC and a human,',
      'and this order puts it out of scope.')

    verifyEvidence('state-block.txt', out.join('\n') + '\n')

    // The evidence is only worth writing if it is the same file every run.
    expect(written.stateKeys.length).toBe(579)
  })

  it('none of it can reach the gap count', () => {
    // THE MEASUREMENT IS THE POINT OF THIS ORDER, so the 633-line block that
    // fills the file must be incapable of moving it. State keys never enter
    // `emitted`, and the gauge only ever looks at `emitted`.
    const written = exportUccncProfile(importUccncProfile(profileText).definition)
    const emitted = new Set(written.emitted.map((k) => k.toLowerCase()))
    for (const key of written.stateKeys) expect(emitted.has(key.toLowerCase())).toBe(false)

    // The published numbers, re-read from the other side with the block in
    // place: the full round trip still covers 1680 of 1680, and a blank
    // definition still reads the full-width gap. Filling the file changed
    // neither, which is exactly what "it is an instrument" has to mean.
    expect(measureProfileGap(profileText, importUccncProfile(profileText).definition).gapCount)
      .toBe(0)
    expect(measureProfileGap(profileText, createDefaultControllerDefinition()).gapCount)
      .toBe(1680)
  })
})

describe('WO-1038: THE GAUGE - what a from-scratch definition cannot yet say', () => {
  it('publishes the gap count against a UCCNC-authored profile, non-zero and all', () => {
    const report = measureProfileGap(profileText, createDefaultControllerDefinition(), {
      profileLabel: 'docs/machine/profiles/LienCNCV2.pro (Operator\'s machine)',
    })

    // The denominator is his machine-configuration keys and nothing else.
    expect(report.theirConfigKeys).toBe(1680)
    // Nothing is silently excluded: a section this software cannot classify
    // would be a gap that never reaches the count.
    expect(report.unclassifiedSections).toEqual([])

    // THE PUBLISHED NUMBER, 2026-08-26. It is the full width because a blank
    // definition states nothing - see this file's header. Asserted exactly so
    // WO-1039 moving it is a deliberate edit here, with the new number
    // written down beside the old one.
    expect(report.gapCount).toBe(1680)
    expect(report.covered).toBe(0)
    expect(report.byKind).toEqual({
      // The catalogue names every key in his profile. WO-1037's claim, and
      // this suite re-measures it from the other side.
      unmodelled: 0,
      // Presented and edited in our UI today; only provenance is missing.
      'named-field-unstated': 216,
      // Would live in ControllerDefinition.settings, which a hand-built
      // definition leaves empty until WO-1039 fills it.
      'settings-unstated': 1464,
      unrepresentable: 0,
    })
    expect(report.byKind['named-field-unstated'] + report.byKind['settings-unstated'])
      .toBe(report.gapCount)

    // Every gap is NAMED, never a bare count.
    expect(report.gaps).toHaveLength(report.gapCount)
    expect(report.gaps.every((gap) => gap.key.includes('.') && gap.detail.length > 0)).toBe(true)

    // The blank definition really does hold this software's default for the
    // key it declines to write - the refusal is about PROVENANCE, not about
    // an empty field.
    const blank = createDefaultControllerDefinition()
    expect(blank.axes.find((a) => a.axis === 'X')!.maxVelocity).toBe(DEFAULT_AXIS_MAX_VELOCITY)
    expect(report.gaps.some((gap) => gap.key === 'axessettingscontrolX.Velocity'
      && gap.kind === 'named-field-unstated')).toBe(true)

    verifyEvidence('gap-from-scratch.txt', formatProfileGap(report))
  })

  it('an imported definition closes the gap to zero, which is what makes it a ruler', () => {
    const imported = importUccncProfile(profileText)
    const report = measureProfileGap(profileText, imported.definition, {
      profileName: imported.profileName,
      profileLabel: 'docs/machine/profiles/LienCNCV2.pro (round trip)',
    })
    expect(report.gapCount).toBe(0)
    expect(report.covered).toBe(1680)
    expect(report.extraKeys).toEqual([])

    verifyEvidence('gap-round-trip.txt', formatProfileGap(report))
  })

  it('the model split the definition carries - meaning, unnamed slots, identity', () => {
    // The ruler's VOCABULARY (scope added to this order 2026-08-26T23:30Z),
    // asserted from the catalogue rather than from a hand-kept list.
    const identity = UCCNC_SETTING_FIELDS.filter((f) => f.ownedBy === 'MachineConfig.name')
    expect(identity.map((f) => f.key)).toEqual(['Generalsettings.Profilename'])

    const unnamed = UCCNC_SETTING_FIELDS
      .filter((f) => (f.parts ?? []).some((p) => !p.named))
    expect(unnamed.map((f) => f.key)).toEqual([
      'Probing.Blower', 'Probing.FixedProbePos', 'Probing.MobileProbePos',
    ])
    // 37 slots whose TYPE and POSITION are facts and whose MEANING is not.
    // Counted, not guessed at - a typed-but-unnamed slot is modelled, and it
    // is not the same thing as a key we cannot name at all.
    expect(unnamed.reduce(
      (total, f) => total + (f.parts ?? []).filter((p) => !p.named).length, 0,
    )).toBe(37)

    // And nothing in his profile is outside the catalogue.
    expect(importUccncProfile(profileText).unmodelled).toEqual([])
  })
})

describe('WO-1038: the export is offered beside the JSON export, and it is a download', () => {
  const clicks: { download: string; blob: Blob }[] = []
  let lastBlob: Blob | null = null

  beforeEach(() => {
    clicks.length = 0
    lastBlob = null
    // jsdom has no object-URL machinery. Hold the Blob that went past so the
    // assertion is about WHAT WAS DOWNLOADED, not about a call being made.
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => { lastBlob = blob; return 'blob:wo1038' },
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      if (lastBlob) clicks.push({ download: this.download, blob: lastBlob })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  it('writes a .pro the importer reads back, and says what it left out', async () => {
    const imported = importUccncProfile(profileText)
    const machine: MachineConfig = {
      id: 'wo1038', name: 'Sample CNC V2', type: 'gantry_router', controller: 'uccnc',
      travel: imported.travel!, rapidRate: 5000,
      maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
      toolChanger: 'manual', coolant: false, notes: '',
      controllerDefinition: imported.definition!,
      // WO-1805: the COMPLETE known definition - Operator's profile states its
      // board, and the machine record carries that fact. The export must
      // read back with no issues: the board line names this machine, not
      // the exporting app, and a machine whose profile said AXBB does not
      // export as an empty identity.
      controllerBoard: imported.controllerBoard ?? undefined,
    }
    act(() => {
      useCamStore.setState({
        machineLibrary: [machine],
        project: { ...useCamStore.getState().project, machine },
        consoleEvents: [],
      })
    })
    render(createElement(MachineLibraryModal))
    act(() => { useCamStore.getState().openModal('machine-config') })

    act(() => { fireEvent.click(screen.getByTestId('machine-export-pro')) })

    expect(clicks).toHaveLength(1)
    // A DOWNLOAD, NEVER A PATH (ADR-0044 requirement 1). The browser hands the
    // bytes to the user; nothing here can write over the file it imported.
    expect(clicks[0].download).toBe('Sample_CNC_V2.pro') // WO-2358 profile-name scrub.

    // The bytes are a profile our own importer reads back with the machine
    // intact - the round trip, driven from the button a person presses.
    const reread = importUccncProfile(await clicks[0].blob.text())
    expect(reread.definition).not.toBeNull()
    expect(reread.issues).toEqual([])
    expect(reread.definition!.axes.find((a) => a.axis === 'X')!.softLimitMax).toBe(738)
    expect(reread.profileName).toBe('Sample CNC V2')

    // And the reading is not swallowed by a successful-looking download: the
    // console says how many settings this machine states and how many a UCCNC
    // profile can carry that it does not.
    const said = useCamStore.getState().consoleEvents.map((e) => e.message).join(' ')
    expect(said).toContain('Sample_CNC_V2.pro')
    expect(said).toContain('1681 settings this machine states')
    // The summary is the shared constant (WO-1916): the 579-value runtime
    // clause left the console line, so the guard is that the line is exactly
    // proExportSummary and says what was left out.
    const absent = Number(/(\d+) more it has not stated/.exec(said)?.[1])
    expect(Number.isInteger(absent)).toBe(true)
    expect(said).toContain(proExportSummary('Sample_CNC_V2', 1681, absent))
  })

  // WO-1805: the button must export what THIS machine declares now, not what
  // the profile once said. Both cases ride on Operator's imported definition, whose
  // archived `Statistics.UCdevicetype` row reads AXBB (19) - the stale identity
  // a naive export would carry out unchanged.
  const ericsDefinition = () => importUccncProfile(profileText).definition!

  it('the library button ships a board re-declared after import, beating the archived row', async () => {
    const machine: MachineConfig = {
      id: 'wo1805-modal-changed', name: 'Sample CNC V2', type: 'gantry_router', controller: 'uccnc',
      travel: { x: 738, y: 724.5, z: 129.2 }, rapidRate: 5000,
      maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
      toolChanger: 'manual', coolant: false, notes: '',
      controllerDefinition: ericsDefinition(),
      // The operator re-declared the machine as a UC100 after import.
      controllerBoard: { deviceType: 1 },
    }
    act(() => {
      useCamStore.setState({
        machineLibrary: [machine],
        project: { ...useCamStore.getState().project, machine },
        consoleEvents: [],
      })
    })
    render(createElement(MachineLibraryModal))
    act(() => { useCamStore.getState().openModal('machine-config') })
    act(() => { fireEvent.click(screen.getByTestId('machine-export-pro')) })

    expect(clicks).toHaveLength(1)
    const reread = importUccncProfile(await clicks[0].blob.text())
    // The CURRENT fact, not the archived AXBB (19).
    expect(reread.controllerBoard).toEqual({ deviceType: 1 })
    expect(reread.issues.filter((i) => i.key === 'Statistics.UCdevicetype')).toEqual([])
  })

  it('the library button keeps a saved and persisted clear missing, never resurrecting the archived row', async () => {
    const machine: MachineConfig = {
      id: 'wo1805-modal-cleared', name: 'Sample CNC V2', type: 'gantry_router', controller: 'uccnc',
      travel: { x: 738, y: 724.5, z: 129.2 }, rapidRate: 5000,
      maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
      toolChanger: 'manual', coolant: false, notes: '',
      controllerDefinition: ericsDefinition(),
      // This complete imported record genuinely starts as the AXBB-E its
      // archived Statistics row names. The production editor clears it below.
      controllerBoard: { deviceType: 19 },
    }
    const restored = clearBoardSaveAndReload(machine)
    render(createElement(MachineLibraryModal))
    act(() => { useCamStore.getState().openModal('machine-config') })
    act(() => { fireEvent.click(screen.getByTestId('machine-export-pro')) })

    expect('controllerBoard' in restored).toBe(false)
    expect(clicks).toHaveLength(1)
    const reread = importUccncProfile(await clicks[0].blob.text())
    // Empty, and reported honestly as missing - NOT the archived AXBB (19).
    expect(reread.controllerBoard).toBeNull()
    expect(reread.issues.filter((i) => i.key === 'Statistics.UCdevicetype'))
      .toEqual(missingBoardIssue)
  })

  it('offers .pro export only for a UCCNC machine', async () => {
    // This modal edits GRBL and LinuxCNC machines too, and a NEW machine
    // starts as GRBL. A `.pro` is a UCCNC profile: writing a GRBL machine
    // through the UCCNC catalogue would be false affordance, so the action is
    // absent rather than occupying the footer as a disabled ghost.
    const machine: MachineConfig = {
      id: 'wo1038-grbl', name: 'Shapeoko', type: 'gantry_router', controller: 'grbl',
      travel: { x: 400, y: 400, z: 100 }, rapidRate: 5000,
      maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
      toolChanger: 'manual', coolant: false, notes: '',
      controllerDefinition: createDefaultControllerDefinition(),
    }
    act(() => {
      useCamStore.setState({
        machineLibrary: [machine],
        project: { ...useCamStore.getState().project, machine },
        consoleEvents: [],
      })
    })
    render(createElement(MachineLibraryModal))
    act(() => { useCamStore.getState().openModal('machine-config') })

    expect(screen.queryByTestId('machine-export-pro')).toBeNull()
    expect(clicks).toHaveLength(0)
    expect(useCamStore.getState().consoleEvents).toEqual([])

    // The UCCNC machine beside it is untouched by the gate: this refuses the
    // wrong controller, it does not refuse the feature.
    act(() => {
      useCamStore.setState({
        machineLibrary: [{ ...machine, controller: 'uccnc' }],
        project: {
          ...useCamStore.getState().project,
          machine: { ...machine, controller: 'uccnc' },
        },
      })
    })
    cleanup()
    render(createElement(MachineLibraryModal))
    act(() => { useCamStore.getState().openModal('machine-config') })
    const live = screen.getByTestId('machine-export-pro') as HTMLButtonElement
    expect(live.disabled).toBe(false)
    act(() => { fireEvent.click(live) })
    expect(clicks).toHaveLength(1)
    expect(clicks[0].download).toBe('Shapeoko.pro')
  })
})

// WO-1805 - the SECOND real button. The Controller area (Definition > Controller
// tab) exports through `ControllerArea.handleExportPro`, a different call site
// than the library modal's. Both must hand the exporter the machine's CURRENT
// declared board, so a board re-declared after import ships and an explicit
// clear exports missing rather than resurrecting the profile's archived row.
// This drives the production panel, editor, Save and export button - not a
// hand-supplied option or a component with hand-built props.
describe('WO-1805: the Controller-area export button carries the current declared board', () => {
  let capturedBlob: Blob | undefined

  beforeEach(() => {
    capturedBlob = undefined
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => { capturedBlob = blob; return 'blob:wo1805-area' },
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  const areaMachine = (deviceType: number): MachineConfig => ({
    id: 'wo1805-area', name: 'Sample CNC V2', type: 'gantry_router', controller: 'uccnc',
    travel: { x: 738, y: 724.5, z: 129.2 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
    controllerDefinition: importUccncProfile(profileText).definition!,
    controllerBoard: { deviceType },
  })

  async function exportFromArea(machine: MachineConfig) {
    act(() => {
      useCamStore.setState({
        machineLibrary: [machine],
        project: { ...useCamStore.getState().project, machine },
        consoleEvents: [],
        activeModal: null,
      })
    })
    render(createElement(MachineDefinitionPanel))
    act(() => { fireEvent.click(screen.getByTestId('machine-def-tab-controller')) })
    act(() => { fireEvent.click(screen.getByTestId('machine-def-controller-export')) })
    expect(capturedBlob).toBeDefined()
    return importUccncProfile(await capturedBlob!.text())
  }

  it('ships a board re-declared after import, beating the archived row', async () => {
    const reread = await exportFromArea(areaMachine(1))
    expect(reread.controllerBoard).toEqual({ deviceType: 1 })
    expect(reread.issues.filter((i) => i.key === 'Statistics.UCdevicetype')).toEqual([])
  })

  it('keeps a saved and persisted clear missing, never resurrecting the archived row', async () => {
    const restored = clearBoardSaveAndReload(areaMachine(19))
    const reread = await exportFromArea(restored)
    expect('controllerBoard' in restored).toBe(false)
    expect(reread.controllerBoard).toBeNull()
    expect(reread.issues.filter((i) => i.key === 'Statistics.UCdevicetype'))
      .toEqual(missingBoardIssue)
  })
})

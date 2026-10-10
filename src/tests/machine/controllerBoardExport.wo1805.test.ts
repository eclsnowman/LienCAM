// WO-1805 - THE EXPORTED MACHINE IS NOT THE EXPORTING APPLICATION.
//
// WO-1732 made the declared board a machine fact (`MachineConfig.controller
// Board`, decoded once at the profile boundary), and the export was still
// writing an empty `Statistics.UCdevicetype` on purpose - a design written
// when nothing modelled the board at all. A machine that was told what board
// it is must not lose that identity by passing through an export, and an
// edit made after import is the CURRENT fact. This file proves the bounded
// repair at the helper seam: the production exporter writes the identity,
// the production importer reads it back, and a machine that states nothing
// stays honestly empty - never a guessed 19, never a BoardID, never a board
// read from the machine's name or from this app.
//
// IT DELIBERATELY IMPORTS ONLY SYMBOLS THAT EXIST ON OLD MAIN
// (`exportUccncProfile`, `importUccncProfile`, the shared board helpers,
// `createDefaultControllerDefinition`), so the negative control - this file
// run against the pre-repair exporter - fails on LOST/EMPTY IDENTITY, not on
// compilation. The extra `controllerBoard` option is simply ignored there.
//
// The download route itself is held by `profileRoundTrip.wo1038.test.ts`,
// which keeps its real-button, no-issues assertion for the complete known
// definition.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createDefaultControllerDefinition } from '../../types'
import { uccncBoardName } from '../../lib/machine/controllerBoard'
import { importUccncProfile } from '../../lib/machine/uccncProfileImport'
import { exportUccncProfile, measureProfileGap } from '../../lib/machine/uccncProfileExport'

const PROFILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'),
  'utf8',
)

/** The profile with its board row replaced (or removed when `null`) - the
 *  same line-ending-independent fixture the import suite builds. */
const withDeviceType = (value: string | null): string => {
  const without = PROFILE.replace(/^UCdevicetype=.*(?:\r?\n)?/mi, '')
  return value === null
    ? without
    : without.replace('[Statistics]', `[Statistics]\nUCdevicetype=${value}`)
}

/** One key's verbatim value in an exported text, section-scoped. */
const exportedValue = (text: string, section: string, key: string): string | undefined => {
  let current = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[') && line.endsWith(']')) { current = line.slice(1, -1); continue }
    const eq = line.indexOf('=')
    if (current.toLowerCase() === section.toLowerCase() && eq > 0
      && line.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) {
      return line.slice(eq + 1)
    }
  }
  return undefined
}

const boardLine = (text: string): string | undefined =>
  exportedValue(text, 'Statistics', 'UCdevicetype')

describe('WO-1805: the export carries the machine\'s declared board identity', () => {
  it('sends Operator\'s AXBB-E back as its DeviceInfo type, and the importer reads it', () => {
    const imported = importUccncProfile(PROFILE)
    expect(imported.controllerBoard).toEqual({ deviceType: 19 })

    // No option handed in - the definition's own stated identity carries it.
    const written = exportUccncProfile(imported.definition, { profileName: imported.profileName })
    expect(boardLine(written.text)).toBe('19')

    const reread = importUccncProfile(written.text)
    expect(reread.controllerBoard).toEqual({ deviceType: 19 })
    expect(reread.issues).toEqual([])
  })

  it('sends a UC100 definition through the same door, named or numeric', () => {
    for (const spelling of ['UC100', '1']) {
      const imported = importUccncProfile(withDeviceType(spelling))
      expect(imported.controllerBoard).toEqual({ deviceType: 1 })
      expect(imported.issues).toEqual([])

      const written = exportUccncProfile(imported.definition, { profileName: 'UC100 bench' })
      expect(boardLine(written.text)).toBe('1')

      const reread = importUccncProfile(written.text)
      expect(reread.controllerBoard).toEqual({ deviceType: 1 })
      expect(reread.issues).toEqual([])
    }
  })

  it('the CURRENT declared fact beats a stale archived profile row', () => {
    // The edit-after-import case: the profile said AXBB (19), the operator
    // re-declared the machine as UC100 (1) in the Controller area, and the
    // raw archived row still sits in `profileOnlySettings`. The export is
    // asked what the machine IS, so the declared fact ships.
    const imported = importUccncProfile(PROFILE)
    expect(imported.definition!.profileOnlySettings).toContainEqual({
      controller: 'uccnc', section: 'Statistics', key: 'UCdevicetype', value: 'AXBB',
    })

    const written = exportUccncProfile(imported.definition, {
      profileName: imported.profileName,
      controllerBoard: { deviceType: 1 },
    })
    expect(boardLine(written.text)).toBe('1')

    const reread = importUccncProfile(written.text)
    expect(reread.controllerBoard).toEqual({ deviceType: 1 })
    expect(reread.issues).toEqual([])

    // And the other direction - a machine re-declared as the AXBB-E the
    // profile never named still exports its current fact.
    const renamed = exportUccncProfile(importUccncProfile(withDeviceType('UC100')).definition, {
      controllerBoard: { deviceType: 19 },
    })
    expect(boardLine(renamed.text)).toBe('19')
    expect(importUccncProfile(renamed.text).controllerBoard).toEqual({ deviceType: 19 })
  })

  it('an unknown-but-positive type is preserved, not dropped for being unnamed', () => {
    // Declared: a newer DeviceInfo type this app's name table does not know.
    const declared = exportUccncProfile(createDefaultControllerDefinition(), {
      controllerBoard: { deviceType: 999 },
    })
    expect(boardLine(declared.text)).toBe('999')
    const declaredBack = importUccncProfile(declared.text)
    expect(declaredBack.controllerBoard).toEqual({ deviceType: 999 })
    // No board complaint. (A from-scratch export states no homing sequence,
    // so the importer's own honest default-home note is still there - it is
    // not this order's key and not this order's business.)
    expect(declaredBack.issues.filter((i) => i.key === 'Statistics.UCdevicetype')).toEqual([])

    // Archived: the same honesty for a profile that stated a positive number.
    const archived = importUccncProfile(withDeviceType('999'))
    expect(archived.controllerBoard).toEqual({ deviceType: 999 })
    const archivedOut = exportUccncProfile(archived.definition)
    expect(boardLine(archivedOut.text)).toBe('999')
    expect(importUccncProfile(archivedOut.text).controllerBoard).toEqual({ deviceType: 999 })
  })
})

describe('WO-1805: no stated board stays honestly missing - never a guess', () => {
  it('a from-scratch definition exports the empty value and the importer reports it', () => {
    const written = exportUccncProfile(createDefaultControllerDefinition(), {
      profileName: 'Nobody has said',
    })
    // The existing missing-value convention for this block: present, typed
    // as the text it is, stating nothing false. Not removed, not 19.
    expect(boardLine(written.text)).toBe('')

    const reread = importUccncProfile(written.text)
    expect(reread.controllerBoard).toBeNull()
    // The board complaint, named exactly once. (A from-scratch export also
    // earns the importer's honest default-home note for the absent homing
    // sequence - its own register, not a board fact.)
    expect(reread.issues.filter((i) => i.key === 'Statistics.UCdevicetype')).toEqual([{
      key: 'Statistics.UCdevicetype',
      message: 'expected a positive DeviceInfo type or board name, found nothing',
    }])
  })

  it('never takes a board from the machine name, and never from this app', () => {
    // A profile that stated no row, exported under a name that SOUNDS like
    // a board: the name is not an identity, and neither is the exporting
    // software. The line stays empty and the importer says so by name.
    const imported = importUccncProfile(withDeviceType(null))
    expect(imported.controllerBoard).toBeNull()

    const written = exportUccncProfile(imported.definition, { profileName: 'AXBB-E router' })
    expect(boardLine(written.text)).toBe('')

    const reread = importUccncProfile(written.text)
    expect(reread.controllerBoard).toBeNull()
    expect(reread.issues).toEqual([{
      key: 'Statistics.UCdevicetype',
      message: 'expected a positive DeviceInfo type or board name, found nothing',
    }])
  })

  it('a name the table does not know is not an identity - it falls to empty, reported', () => {
    // `banana` was never a board. The import already logged that honestly;
    // the export must not launder the raw text back out as though it were.
    const imported = importUccncProfile(withDeviceType('banana'))
    expect(imported.controllerBoard).toBeNull()

    const written = exportUccncProfile(imported.definition)
    expect(boardLine(written.text)).toBe('')
    const reread = importUccncProfile(written.text)
    expect(reread.controllerBoard).toBeNull()
    expect(reread.issues).toEqual([{
      key: 'Statistics.UCdevicetype',
      message: 'expected a positive DeviceInfo type or board name, found nothing',
    }])
  })
})

describe('WO-1805: naming the field is a statement; omitting it is not', () => {
  // The live buttons hand in the machine's CURRENT identity; a definition-only
  // caller (the gauge, a hand-built export) names nothing. Those two are NOT
  // the same, and the difference is what "an explicit clear must not resurrect
  // an archived row" turns on. Operator's profile states AXBB (19) in its archived
  // row, so it is the perfect stale-archive to try to drag back.
  const staleArchive = () => importUccncProfile(PROFILE)

  it('an OMITTED field lets the archived identity carry the line', () => {
    const imported = staleArchive()
    // No `controllerBoard` key at all - the profile's own stated identity ships.
    expect(boardLine(exportUccncProfile(imported.definition, { profileName: 'x' }).text))
      .toBe('19')
  })

  it('an explicitly cleared identity (null, or a named undefined) exports empty, never 19', () => {
    const imported = staleArchive()

    for (const cleared of [null, undefined]) {
      const written = exportUccncProfile(imported.definition, {
        profileName: 'x',
        controllerBoard: cleared,
      })
      // The key is NAMED, so the caller is stating "this machine declares no
      // board" - the archived 19 must NOT come back.
      expect(boardLine(written.text)).toBe('')
      // And the importer reads that honestly as a missing identity, not a board.
      const reread = importUccncProfile(written.text)
      expect(reread.controllerBoard).toBeNull()
      expect(reread.issues.filter((i) => i.key === 'Statistics.UCdevicetype')).toEqual([{
        key: 'Statistics.UCdevicetype',
        message: 'expected a positive DeviceInfo type or board name, found nothing',
      }])
    }
  })

  it('a positive declared type ships and beats the archive in the same breath', () => {
    const imported = staleArchive()
    expect(boardLine(exportUccncProfile(imported.definition, {
      profileName: 'x', controllerBoard: { deviceType: 1 },
    }).text)).toBe('1')
  })
})

describe('WO-1805: the board line cannot touch the gauge', () => {
  it('it is a state key, never an emitted configuration key', () => {
    const imported = importUccncProfile(PROFILE)
    const withBoard = exportUccncProfile(imported.definition, {
      profileName: imported.profileName,
      controllerBoard: { deviceType: 1 },
    })
    const withoutBoard = exportUccncProfile(imported.definition, {
      profileName: imported.profileName,
    })

    // Present in both, counted in neither: the block's width is the same
    // 579 keys whether a board is stated or not, and the board never
    // enters `emitted` - 633 lines of state cannot flatter the ruler, and
    // neither can one line of identity.
    expect(withBoard.stateKeys).toContain('Statistics.UCdevicetype')
    expect(withBoard.stateKeys.length).toBe(579)
    expect(withoutBoard.stateKeys.length).toBe(579)
    expect(withBoard.emitted).not.toContain('Statistics.UCdevicetype')
    expect(withBoard.absent.map((entry) => entry.key)).not.toContain('Statistics.UCdevicetype')
    expect(withBoard.emitted).toEqual(withoutBoard.emitted)
    expect(uccncBoardName(1)).toBe('UC100')

    // The gap reads the same number with the identity on the file or off it.
    expect(measureProfileGap(PROFILE, imported.definition, {
      profileName: imported.profileName, controllerBoard: { deviceType: 1 },
    }).gapCount).toBe(measureProfileGap(PROFILE, imported.definition, {
      profileName: imported.profileName,
    }).gapCount)
  })
})

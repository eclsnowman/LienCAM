// WO-411 slice 5 - probe routine files: the liencam-probe-routines envelope,
// export, import, forced provenance, limits, collisions.
// Contract: docs/research/probe-routine-format.md part 5.
import { describe, expect, it } from 'vitest'
import {
  FACTORY_BORE_CENTRE,
  FACTORY_EDGE_X_MINUS,
  FACTORY_PROBE_ROUTINES,
} from '../../lib/machine/probeRoutineFactory'
import {
  IMPORTED_ROUTINE_ID_PREFIX,
  PROBE_ROUTINE_FILE_EXTENSION,
  PROBE_ROUTINE_FILE_FORMAT,
  PROBE_ROUTINE_FILE_LIMITS,
  buildProbeRoutineFile,
  exportRoutines,
  exportableRoutine,
  findJsonBoundViolation,
  importRoutines,
  keepBothId,
  parseProbeRoutineFile,
  probeRoutineFileName,
  renameReservedId,
  resolveImportCollision,
  routineContentHash,
  routinesContentHash,
} from '../../lib/machine/probeRoutineFile'
import {
  PROBE_ROUTINE_SCHEMA_VERSION,
  type ProbeRoutine,
} from '../../lib/machine/probeRoutineFormat'
import { APP_VERSION } from '../../version'

const NOW = '2026-08-19T12:00:00.000Z'
const FILE = 'shop-routines.liencam-probe.json'

function userRoutine(id = 'user.my-bore', name = 'My bore'): ProbeRoutine {
  return { ...FACTORY_BORE_CENTRE, id, name, provenance: { kind: 'user' } }
}

function envelopeWith(overrides: Record<string, unknown>, routines: unknown[] = [userRoutine()]): string {
  return JSON.stringify({
    format: PROBE_ROUTINE_FILE_FORMAT,
    schemaVersion: PROBE_ROUTINE_SCHEMA_VERSION,
    exportedAt: NOW,
    exportedBy: 'LienCAM test',
    routines,
    ...overrides,
  })
}

describe('WO-411 slice 5 - export', () => {
  it('writes one envelope with format, schemaVersion, exportedAt, exportedBy, contentHash and the routines', () => {
    const text = exportRoutines([FACTORY_BORE_CENTRE, userRoutine()], { now: NOW })
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['contentHash', 'exportedAt', 'exportedBy', 'format', 'routines', 'schemaVersion'])
    expect(parsed.format).toBe('liencam-probe-routines')
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.exportedAt).toBe(NOW)
    expect(parsed.exportedBy).toBe(`LienCAM ${APP_VERSION}`)
    expect(parsed.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect((parsed.routines as unknown[]).length).toBe(2)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('the content hash is the app\'s, over the routines as they travel', () => {
    const file = buildProbeRoutineFile([FACTORY_BORE_CENTRE], { now: NOW })
    expect(file.contentHash).toBe(routinesContentHash([FACTORY_BORE_CENTRE]))
    expect(routinesContentHash([FACTORY_BORE_CENTRE])).not.toBe(routinesContentHash([FACTORY_EDGE_X_MINUS]))
    expect(routineContentHash(FACTORY_BORE_CENTRE)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('a factory routine stays marked factory in the file; only the provenance kind travels', () => {
    const imported: ProbeRoutine = {
      ...userRoutine(),
      provenance: { kind: 'imported', importedFrom: 'x.json', importedAt: NOW, reviewedHash: 'sha256:abc' },
    }
    const file = buildProbeRoutineFile([FACTORY_BORE_CENTRE, imported], { now: NOW })
    expect(file.routines[0].provenance).toEqual({ kind: 'factory' })
    expect(file.routines[1].provenance).toEqual({ kind: 'imported' })
    expect(Object.keys(exportableRoutine(FACTORY_BORE_CENTRE)).sort()).toEqual(
      ['description', 'id', 'inputs', 'name', 'outputs', 'provenance', 'requires', 'schemaVersion', 'steps', 'version'],
    )
  })

  it('names the file after the one routine, or probe-routines for several', () => {
    expect(probeRoutineFileName([FACTORY_BORE_CENTRE])).toBe(`bore-centre${PROBE_ROUTINE_FILE_EXTENSION}`)
    expect(probeRoutineFileName([FACTORY_BORE_CENTRE, FACTORY_EDGE_X_MINUS])).toBe('probe-routines.liencam-probe.json')
  })
})

describe('WO-411 slice 5 - import: provenance is the app\'s decision', () => {
  it('round-trips every factory routine as imported under an imported. id, reporting each rename', () => {
    const text = exportRoutines(FACTORY_PROBE_ROUTINES, { now: NOW })
    const result = importRoutines(text, { fileName: FILE, now: NOW })
    expect(result.ok).toBe(true)
    expect(result.fileErrors).toEqual([])
    expect(result.refused).toEqual([])
    expect(result.accepted.length).toBe(FACTORY_PROBE_ROUTINES.length)
    expect(result.renamed.length).toBe(FACTORY_PROBE_ROUTINES.length)
    for (const [i, routine] of result.accepted.entries()) {
      const source = FACTORY_PROBE_ROUTINES[i]
      expect(routine.provenance).toEqual({ kind: 'imported', importedFrom: FILE, importedAt: NOW })
      expect(routine.id).toBe(`${IMPORTED_ROUTINE_ID_PREFIX}${source.id.slice('factory.'.length)}`)
      expect(result.renamed[i].fromId).toBe(source.id)
      expect(result.renamed[i].toId).toBe(routine.id)
      expect(result.renamed[i].sentence).toContain(`imported as '${routine.id}'`)
      // the definition is unchanged
      expect(routineContentHash({ ...routine, id: source.id, provenance: { kind: 'factory' } }))
        .toBe(routineContentHash(source))
    }
  })

  it('forces imported even when the file claims factory or user, and clears any reviewed-once record', () => {
    const claimsFactory = { ...userRoutine('user.claims', 'Claims'), provenance: { kind: 'factory' } }
    const claimsReviewed = {
      ...userRoutine('user.reviewed', 'Reviewed'),
      provenance: { kind: 'imported', importedFrom: 'elsewhere.json', importedAt: '2020-01-01T00:00:00Z', reviewedHash: 'sha256:deadbeef' },
    }
    const result = importRoutines(envelopeWith({}, [claimsFactory, claimsReviewed, userRoutine()]), { fileName: FILE, now: NOW })
    expect(result.ok).toBe(true)
    expect(result.accepted.map((r) => r.provenance)).toEqual([
      { kind: 'imported', importedFrom: FILE, importedAt: NOW },
      { kind: 'imported', importedFrom: FILE, importedAt: NOW },
      { kind: 'imported', importedFrom: FILE, importedAt: NOW },
    ])
    expect(result.accepted.every((r) => r.provenance.reviewedHash === undefined)).toBe(true)
  })

  it('a factory. id in a file is never imported as factory: renamed imported. and reported', () => {
    const text = envelopeWith({}, [{ ...FACTORY_BORE_CENTRE }])
    const result = importRoutines(text, { fileName: FILE, now: NOW })
    expect(result.accepted.map((r) => r.id)).toEqual(['imported.bore-centre'])
    expect(result.accepted[0].provenance.kind).toBe('imported')
    expect(result.renamed).toEqual([expect.objectContaining({ fromId: 'factory.bore-centre', toId: 'imported.bore-centre' })])
    expect(result.renamed[0].sentence).toContain("reserved for the routines shipped inside LienCAM")
  })

  it('a factory. id too long to rename is refused E_ID_RESERVED', () => {
    const longId = `factory.${'a'.repeat(56)}` // 64 chars, legal; imported. + 56 = 65, not legal
    expect(renameReservedId(longId)).toBeNull()
    const result = importRoutines(envelopeWith({}, [{ ...FACTORY_BORE_CENTRE, id: longId }]), { fileName: FILE, now: NOW })
    expect(result.accepted).toEqual([])
    expect(result.refused[0].errors[0].code).toBe('E_ID_RESERVED')
    expect(result.refused[0].sentences[0]).toContain("begins with 'factory.'")
    expect(renameReservedId('user.x')).toBe('user.x')
  })
})

describe('WO-411 slice 5 - import: whole-file refusals', () => {
  it('a newer schemaVersion is refused whole with the contract\'s sentence', () => {
    const result = importRoutines(envelopeWith({ schemaVersion: 2 }), { fileName: FILE })
    expect(result.ok).toBe(false)
    expect(result.fileErrors).toEqual([
      'This file was saved by a newer LienCAM (format 2); this version reads format 1. Nothing was imported.',
    ])
    expect(result.accepted).toEqual([])
  })

  it('an older schemaVersion is refused: no migration before 1.0', () => {
    const result = importRoutines(envelopeWith({ schemaVersion: 0 }), { fileName: FILE })
    expect(result.ok).toBe(false)
    expect(result.fileErrors[0]).toContain('does not migrate older files')
  })

  it('a missing schemaVersion is refused', () => {
    const text = JSON.stringify({ format: PROBE_ROUTINE_FILE_FORMAT, routines: [] })
    const result = importRoutines(text, { fileName: FILE })
    expect(result.ok).toBe(false)
    expect(result.fileErrors[0]).toContain('"schemaVersion" is missing')
  })

  it('a file carrying "feeds" or "envelope" is refused whole (E_UNKNOWN_FIELD - nothing but definitions travels)', () => {
    for (const key of ['feeds', 'envelope', 'offsets', 'toolTable']) {
      const result = importRoutines(envelopeWith({ [key]: { search: 300 } }), { fileName: FILE })
      expect(result.ok, key).toBe(false)
      expect(result.fileErrors[0]).toContain(`"${key}"`)
      expect(result.fileErrors[0]).toContain('not part of a probe routine file')
      expect(result.accepted).toEqual([])
    }
  })

  it('a routine carrying an unknown field of its own (a feed in mm/min) is refused by the validator, the rest imported', () => {
    const bad = { ...userRoutine('user.bad', 'Bad'), feeds: { search: 300 } }
    const result = importRoutines(envelopeWith({}, [bad, userRoutine()]), { fileName: FILE })
    expect(result.ok).toBe(true)
    expect(result.accepted.map((r) => r.id)).toEqual(['user.my-bore'])
    expect(result.refused.length).toBe(1)
    expect(result.refused[0].errors.some((e) => e.code === 'E_UNKNOWN_FIELD')).toBe(true)
    expect(result.refused[0].sentences[0]).toMatch(/^Routine 'Bad': /)
  })

  it('the wrong format, not an object, not JSON - each refused with a plain sentence', () => {
    expect(importRoutines(JSON.stringify({ format: 'liencam-posts', schemaVersion: 1, routines: [] }), { fileName: FILE }).fileErrors[0])
      .toContain('not a probe routine file')
    expect(importRoutines('[]', { fileName: FILE }).fileErrors[0]).toContain('should be an object')
    expect(importRoutines('{ not json', { fileName: FILE }).fileErrors[0]).toContain('not valid JSON')
    expect(importRoutines(envelopeWith({ routines: 'nope' }), { fileName: FILE }).fileErrors[0]).toContain('no "routines" list')
  })

  it('limit: file bytes', () => {
    const padding = 'x'.repeat(PROBE_ROUTINE_FILE_LIMITS.maxBytes)
    const result = importRoutines(envelopeWith({ exportedBy: padding }), { fileName: FILE })
    expect(result.ok).toBe(false)
    expect(result.fileErrors[0]).toContain('bytes; a probe routine file is at most')
  })

  it('limit: nesting depth', () => {
    let deep: unknown = 1
    for (let i = 0; i < PROBE_ROUTINE_FILE_LIMITS.maxDepth + 2; i++) deep = [deep]
    const result = importRoutines(envelopeWith({}, [deep]), { fileName: FILE })
    expect(result.ok).toBe(false)
    expect(result.fileErrors[0]).toContain(`nests deeper than ${PROBE_ROUTINE_FILE_LIMITS.maxDepth} levels`)
    expect(findJsonBoundViolation({ a: [1, 2] })).toBeNull()
  })

  it('limit: string length', () => {
    const long = 'y'.repeat(PROBE_ROUTINE_FILE_LIMITS.maxStringLength + 1)
    const result = importRoutines(envelopeWith({}, [{ ...userRoutine(), description: long }]), { fileName: FILE })
    expect(result.ok).toBe(false)
    expect(result.fileErrors[0]).toContain(`characters long (limit ${PROBE_ROUTINE_FILE_LIMITS.maxStringLength})`)
  })

  it('limit: routine count', () => {
    const many = Array.from({ length: PROBE_ROUTINE_FILE_LIMITS.maxRoutines + 1 }, (_, i) => userRoutine(`user.r${i}`))
    const result = importRoutines(envelopeWith({}, many), { fileName: FILE })
    expect(result.ok).toBe(false)
    expect(result.fileErrors[0]).toContain(`holds at most ${PROBE_ROUTINE_FILE_LIMITS.maxRoutines}`)
  })

  it('limit: object keys and array length', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i <= PROBE_ROUTINE_FILE_LIMITS.maxObjectKeys; i++) wide[`k${i}`] = i
    expect(importRoutines(envelopeWith({}, [wide]), { fileName: FILE }).fileErrors[0]).toContain('fields (limit')
    const longList = Array.from({ length: PROBE_ROUTINE_FILE_LIMITS.maxArrayLength + 1 }, () => 1)
    expect(importRoutines(envelopeWith({}, [{ ...userRoutine(), steps: longList }]), { fileName: FILE }).fileErrors[0])
      .toContain('entries (limit')
  })

  it('parseProbeRoutineFile notes a missing exportedAt and refuses a non-text contentHash', () => {
    const ok = parseProbeRoutineFile(JSON.stringify({ format: PROBE_ROUTINE_FILE_FORMAT, schemaVersion: 1, routines: [] }))
    expect(ok.ok && ok.notes[0]).toContain('does not say when it was exported')
    const bad = parseProbeRoutineFile(envelopeWith({ contentHash: 5 }))
    expect(!bad.ok && bad.fileErrors[0]).toContain('"contentHash" must be text')
  })
})

describe('WO-411 slice 5 - import: per-routine outcomes and collisions', () => {
  it('an invalid routine is refused with the validator\'s sentences; the others are accepted', () => {
    const broken = { ...userRoutine('user.broken', 'Broken'), steps: [{ kind: 'gcode', line: 'G10 L20 P0 X0' }] }
    const result = importRoutines(envelopeWith({}, [broken, userRoutine()]), { fileName: FILE })
    expect(result.ok).toBe(true)
    expect(result.accepted.map((r) => r.id)).toEqual(['user.my-bore'])
    expect(result.refused[0].id).toBe('user.broken')
    expect(result.refused[0].errors.map((e) => e.code)).toEqual(expect.arrayContaining(['E_STEP_KIND', 'E_GCODE_IN_ROUTINE']))
  })

  it('a non-object entry and a duplicate id within one file are refused', () => {
    const result = importRoutines(envelopeWith({}, [42, userRoutine(), userRoutine()]), { fileName: FILE })
    expect(result.accepted.length).toBe(1)
    expect(result.refused.map((r) => r.sentences[0])).toEqual([
      'Routine 1 in the file is not a routine object.',
      "Routine 'My bore': the file lists the id 'user.my-bore' more than once; only the first was imported.",
    ])
  })

  it('a collision with a user id: ask (default) holds it pending, not accepted', () => {
    const result = importRoutines(envelopeWith({}), { fileName: FILE, existingIds: ['user.my-bore'] })
    expect(result.accepted).toEqual([])
    expect(result.collisions).toEqual([expect.objectContaining({ id: 'user.my-bore', resolution: 'pending', acceptedAs: null })])
    expect(result.collisions[0].sentence).toContain('Replace it, keep both, or skip this one?')
    expect(result.collisions[0].incoming.provenance.kind).toBe('imported')
  })

  it('replace / keep-both (-2, then -3) / skip', () => {
    const replace = importRoutines(envelopeWith({}), { fileName: FILE, existingIds: ['user.my-bore'], onCollision: 'replace' })
    expect(replace.accepted.map((r) => r.id)).toEqual(['user.my-bore'])
    expect(replace.collisions[0]).toEqual(expect.objectContaining({ resolution: 'replaced', acceptedAs: 'user.my-bore' }))

    const keep = importRoutines(envelopeWith({}), { fileName: FILE, existingIds: ['user.my-bore'], onCollision: 'keep-both' })
    expect(keep.accepted.map((r) => r.id)).toEqual(['user.my-bore-2'])
    expect(keep.collisions[0]).toEqual(expect.objectContaining({ resolution: 'kept-both', acceptedAs: 'user.my-bore-2' }))
    expect(keep.collisions[0].sentence).toContain("kept as 'user.my-bore-2'")

    const keep3 = importRoutines(envelopeWith({}), { fileName: FILE, existingIds: ['user.my-bore', 'user.my-bore-2'], onCollision: 'keep-both' })
    expect(keep3.accepted.map((r) => r.id)).toEqual(['user.my-bore-3'])

    const skip = importRoutines(envelopeWith({}), { fileName: FILE, existingIds: ['user.my-bore'], onCollision: 'skip' })
    expect(skip.accepted).toEqual([])
    expect(skip.collisions[0]).toEqual(expect.objectContaining({ resolution: 'skipped', acceptedAs: null }))
  })

  it('a renamed factory id that collides with an existing imported copy follows the same policy', () => {
    const text = exportRoutines([FACTORY_BORE_CENTRE], { now: NOW })
    const result = importRoutines(text, { fileName: FILE, existingIds: ['imported.bore-centre'], onCollision: 'keep-both' })
    expect(result.renamed[0].toId).toBe('imported.bore-centre')
    expect(result.accepted.map((r) => r.id)).toEqual(['imported.bore-centre-2'])
  })

  it('resolveImportCollision settles a pending one', () => {
    const pending = importRoutines(envelopeWith({}), { fileName: FILE, existingIds: ['user.my-bore'] }).collisions[0]
    expect(resolveImportCollision(pending, 'skip', ['user.my-bore'])).toBeNull()
    expect(resolveImportCollision(pending, 'replace', ['user.my-bore'])).toEqual({ routine: pending.incoming, replaced: true })
    const kept = resolveImportCollision(pending, 'keep-both', ['user.my-bore'])
    expect(kept?.routine.id).toBe('user.my-bore-2')
    expect(kept?.replaced).toBe(false)
    expect(keepBothId('a.b', new Set(['a.b-2', 'a.b-3']))).toBe('a.b-4')
  })

  it('a content hash that no longer matches is a note, not a refusal (the hash is never trusted from the file)', () => {
    const file = buildProbeRoutineFile([userRoutine()], { now: NOW })
    const edited = { ...file, routines: [{ ...file.routines[0], name: 'Edited by hand' }] }
    const result = importRoutines(JSON.stringify(edited), { fileName: FILE })
    expect(result.ok).toBe(true)
    expect(result.accepted.length).toBe(1)
    expect(result.notes.some((n) => n.includes('content hash does not match'))).toBe(true)
    const untouched = importRoutines(JSON.stringify(file), { fileName: FILE })
    expect(untouched.notes).toEqual([])
  })
})

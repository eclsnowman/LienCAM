// WO-411 slice 5 - the probe routine library model: factory / user / imported,
// quarantine on load, reviewed-once, restore factory routines.
import { describe, expect, it } from 'vitest'
import {
  FACTORY_BORE_CENTRE,
  FACTORY_EDGE_X_MINUS,
  FACTORY_PROBE_ROUTINES,
} from '../../lib/machine/probeRoutineFactory'
import { exportRoutines, importRoutines } from '../../lib/machine/probeRoutineFile'
import {
  EMPTY_PROBE_ROUTINE_LIBRARY,
  addImportedRoutine,
  clearProbeRoutineReview,
  deleteProbeRoutine,
  duplicateProbeRoutine,
  getProbeRoutine,
  hideFactoryRoutine,
  isProbeRoutineReviewed,
  listProbeRoutines,
  loadProbeRoutineLibrary,
  markProbeRoutineReviewed,
  restoreFactoryRoutines,
  saveProbeRoutine,
  unhideFactoryRoutine,
  type ProbeRoutineLibraryState,
} from '../../lib/machine/probeRoutineLibrary'
import type { ProbeRoutine } from '../../lib/machine/probeRoutineFormat'

const NOW = '2026-08-19T12:00:00.000Z'

function userRoutine(id = 'user.my-bore', name = 'My bore'): ProbeRoutine {
  return { ...FACTORY_BORE_CENTRE, id, name, provenance: { kind: 'user' } }
}

function importedBore(): ProbeRoutine {
  const result = importRoutines(exportRoutines([FACTORY_BORE_CENTRE]), { fileName: 'bore.liencam-probe.json', now: NOW })
  return result.accepted[0]
}

function withImported(): { state: ProbeRoutineLibraryState; routine: ProbeRoutine } {
  const routine = importedBore()
  const added = addImportedRoutine(EMPTY_PROBE_ROUTINE_LIBRARY, routine)
  if (!added.ok) throw new Error(added.errors.join('\n'))
  return { state: added.state, routine }
}

describe('WO-411 slice 5 - library: the three kinds', () => {
  it('lists every factory routine first, from the compiled set, then user / imported by name', () => {
    let state = EMPTY_PROBE_ROUTINE_LIBRARY
    state = saveProbeRoutine(state, userRoutine('user.zed', 'Zed')).state
    state = saveProbeRoutine(state, userRoutine('user.alpha', 'Alpha')).state
    const { routine: imported } = withImported()
    state = addImportedRoutine(state, imported).state
    const entries = listProbeRoutines(state)
    expect(entries.slice(0, FACTORY_PROBE_ROUTINES.length).map((e) => e.routine)).toEqual(FACTORY_PROBE_ROUTINES)
    expect(entries.slice(0, FACTORY_PROBE_ROUTINES.length).every((e) => e.kind === 'factory')).toBe(true)
    expect(entries.slice(FACTORY_PROBE_ROUTINES.length).map((e) => [e.routine.name, e.kind])).toEqual([
      ['Alpha', 'user'],
      ['Bore centre', 'imported'],
      ['Zed', 'user'],
    ])
  })

  it('getProbeRoutine finds factory and stored routines; factory is never in the stored map', () => {
    const state = saveProbeRoutine(EMPTY_PROBE_ROUTINE_LIBRARY, userRoutine()).state
    expect(getProbeRoutine(state, 'factory.bore-centre')).toBe(FACTORY_BORE_CENTRE)
    expect(getProbeRoutine(state, 'user.my-bore')?.name).toBe('My bore')
    expect(getProbeRoutine(state, 'nope')).toBeNull()
    expect(Object.keys(state.routines)).toEqual(['user.my-bore'])
  })

  it('saveProbeRoutine validates, refuses factory ids, and stores as user', () => {
    const reserved = saveProbeRoutine(EMPTY_PROBE_ROUTINE_LIBRARY, { ...FACTORY_BORE_CENTRE })
    expect(reserved.ok).toBe(false)
    expect(!reserved.ok && reserved.errors[0]).toContain('reserved for the routines shipped inside LienCAM')
    const invalid = saveProbeRoutine(EMPTY_PROBE_ROUTINE_LIBRARY, { ...userRoutine(), steps: [{ kind: 'gcode', line: 'G10 L20 P0 X0' }] })
    expect(invalid.ok).toBe(false)
    const saved = saveProbeRoutine(EMPTY_PROBE_ROUTINE_LIBRARY, { ...userRoutine(), provenance: { kind: 'imported', importedFrom: 'x' } })
    expect(saved.ok && saved.state.routines['user.my-bore'].provenance).toEqual({ kind: 'user' })
  })

  it('duplicate of a factory routine yields a user copy under a non-reserved id; again yields -2', () => {
    const first = duplicateProbeRoutine(EMPTY_PROBE_ROUTINE_LIBRARY, 'factory.bore-centre')
    expect(first.ok && first.id).toBe('user.bore-centre')
    expect(first.state.routines['user.bore-centre'].provenance).toEqual({ kind: 'user' })
    const second = duplicateProbeRoutine(first.state, 'factory.bore-centre')
    expect(second.ok && second.id).toBe('user.bore-centre-2')
    const copyOfCopy = duplicateProbeRoutine(second.state, 'user.bore-centre', { newName: 'Mine' })
    expect(copyOfCopy.ok && copyOfCopy.id).toBe('user.bore-centre-copy')
    expect(copyOfCopy.state.routines['user.bore-centre-copy'].name).toBe('Mine')
    expect(duplicateProbeRoutine(EMPTY_PROBE_ROUTINE_LIBRARY, 'nope').ok).toBe(false)
  })

  it('delete removes user / imported / quarantined; a factory routine cannot be deleted, only hidden', () => {
    const state = saveProbeRoutine(EMPTY_PROBE_ROUTINE_LIBRARY, userRoutine()).state
    expect(deleteProbeRoutine(state, 'user.my-bore').state.routines).toEqual({})
    expect(deleteProbeRoutine(state, 'factory.bore-centre').ok).toBe(false)
    expect(deleteProbeRoutine(state, 'nope').ok).toBe(false)
    const hidden = hideFactoryRoutine(state, 'factory.bore-centre')
    expect(hidden.ok && hidden.state.hidden).toEqual(['factory.bore-centre'])
    expect(listProbeRoutines(hidden.state).some((e) => e.routine.id === 'factory.bore-centre')).toBe(false)
    expect(listProbeRoutines(hidden.state, { includeHidden: true }).find((e) => e.routine.id === 'factory.bore-centre')?.hidden).toBe(true)
    expect(hideFactoryRoutine(state, 'user.my-bore').ok).toBe(false)
    expect(unhideFactoryRoutine(hidden.state, 'factory.bore-centre').state.hidden).toEqual([])
  })
})

describe('WO-411 slice 5 - library: restore factory routines', () => {
  it('returns every factory routine to its shipped content and never touches user / imported ones', () => {
    let state = saveProbeRoutine(EMPTY_PROBE_ROUTINE_LIBRARY, userRoutine()).state
    const { routine: imported } = withImported()
    state = addImportedRoutine(state, imported).state
    state = hideFactoryRoutine(state, 'factory.bore-centre').state
    state = hideFactoryRoutine(state, 'factory.edge.x-minus').state
    // a stored routine under a factory id (impossible by construction) and a quarantined one
    state = {
      ...state,
      routines: { ...state.routines, 'factory.bore-centre': { ...FACTORY_BORE_CENTRE, name: 'Tampered' } },
      quarantined: { 'factory.edge.x-minus': { json: {}, errors: ['x'] }, 'user.old': { json: {}, errors: ['y'] } },
    }
    const restored = restoreFactoryRoutines(state)
    expect(restored.hidden).toEqual([])
    expect(Object.keys(restored.routines).sort()).toEqual(['imported.bore-centre', 'user.my-bore'])
    expect(restored.routines['user.my-bore']).toBe(state.routines['user.my-bore'])
    expect(restored.routines['imported.bore-centre']).toBe(state.routines['imported.bore-centre'])
    expect(Object.keys(restored.quarantined)).toEqual(['user.old'])
    const entries = listProbeRoutines(restored)
    expect(entries.filter((e) => e.kind === 'factory').map((e) => e.routine)).toEqual(FACTORY_PROBE_ROUTINES)
    expect(getProbeRoutine(restored, 'factory.bore-centre')).toBe(FACTORY_BORE_CENTRE)
    expect(getProbeRoutine(restored, 'factory.edge.x-minus')).toBe(FACTORY_EDGE_X_MINUS)
  })
})

describe('WO-411 slice 5 - library: reviewed-once', () => {
  it('an imported routine is not reviewed until marked with the preview hash, then is, then is not after a change', () => {
    const { state, routine } = withImported()
    const id = routine.id
    const hash = 'sha256:preview-1'
    expect(isProbeRoutineReviewed(state, id, hash)).toBe(false)
    const marked = markProbeRoutineReviewed(state, id, hash)
    expect(marked.ok).toBe(true)
    expect(isProbeRoutineReviewed(marked.state, id, hash)).toBe(true)
    expect(marked.state.routines[id].provenance.reviewedHash).toBe(hash)
    // changed inputs or content = a different preview hash = not reviewed
    expect(isProbeRoutineReviewed(marked.state, id, 'sha256:preview-2')).toBe(false)
    expect(isProbeRoutineReviewed(marked.state, id, '')).toBe(false)
    // the same content re-saved unchanged keeps the review
    const unchanged = saveProbeRoutine(marked.state, marked.state.routines[id])
    expect(unchanged.ok && unchanged.state.routines[id].provenance.kind).toBe('imported')
    expect(isProbeRoutineReviewed(unchanged.state, id, hash)).toBe(true)
    // an edit converts it to user (no review needed, record dropped)
    const edited = saveProbeRoutine(marked.state, { ...marked.state.routines[id], name: 'Edited bore' })
    expect(edited.ok && edited.state.routines[id].provenance).toEqual({ kind: 'user' })
    expect(isProbeRoutineReviewed(edited.state, id, hash)).toBe(true)
  })

  it('factory and user routines are always reviewed; an unknown id never; clearing drops the record', () => {
    const { state, routine } = withImported()
    expect(isProbeRoutineReviewed(state, 'factory.bore-centre', 'anything')).toBe(true)
    const withUser = saveProbeRoutine(state, userRoutine()).state
    expect(isProbeRoutineReviewed(withUser, 'user.my-bore', 'anything')).toBe(true)
    expect(isProbeRoutineReviewed(withUser, 'nope', 'anything')).toBe(false)
    expect(markProbeRoutineReviewed(withUser, 'nope', 'h').ok).toBe(false)
    expect(markProbeRoutineReviewed(withUser, 'factory.bore-centre', 'h').state).toBe(withUser)
    expect(markProbeRoutineReviewed(withUser, routine.id, '').ok).toBe(false)
    const marked = markProbeRoutineReviewed(withUser, routine.id, 'h').state
    const cleared = clearProbeRoutineReview(marked, routine.id)
    expect(cleared.routines[routine.id].provenance.reviewedHash).toBeUndefined()
    expect(isProbeRoutineReviewed(cleared, routine.id, 'h')).toBe(false)
  })

  it('re-importing (replace) stores the incoming routine without any review record', () => {
    const { state, routine } = withImported()
    const marked = markProbeRoutineReviewed(state, routine.id, 'h').state
    const replaced = addImportedRoutine(marked, { ...routine, provenance: { ...routine.provenance, reviewedHash: 'claimed' } })
    expect(replaced.ok && replaced.state.routines[routine.id].provenance.reviewedHash).toBeUndefined()
    expect(isProbeRoutineReviewed(replaced.state, routine.id, 'h')).toBe(false)
    expect(addImportedRoutine(state, userRoutine()).ok).toBe(false)
  })
})

describe('WO-411 slice 5 - library: load and quarantine', () => {
  it('re-validates every stored routine; an invalid one is quarantined with its sentences, never dropped', () => {
    const good = userRoutine()
    const badKind = { ...userRoutine('user.bad', 'Bad'), steps: [{ kind: 'gcode', line: 'G10 L20 P0 X0' }] }
    const state = loadProbeRoutineLibrary({
      routines: { 'user.my-bore': good, 'user.bad': badKind, 'user.mismatch': userRoutine('user.other', 'Other') },
      quarantined: { 'user.older': { json: { id: 'user.older' }, errors: ['Routine: old reason.'] }, 'user.raw': 'garbage' },
      hidden: ['factory.bore-centre', 'user.not-factory', 7],
    })
    expect(Object.keys(state.routines)).toEqual(['user.my-bore'])
    expect(Object.keys(state.quarantined).sort()).toEqual(['user.bad', 'user.mismatch', 'user.older', 'user.raw'])
    expect(state.quarantined['user.bad'].json).toEqual(badKind)
    expect(state.quarantined['user.bad'].errors.some((s) => s.includes("there is no step kind 'gcode'"))).toBe(true)
    expect(state.quarantined['user.mismatch'].errors[0]).toContain("stored under 'user.mismatch' but its own id is 'user.other'")
    expect(state.quarantined['user.older'].errors).toEqual(['Routine: old reason.'])
    expect(state.quarantined['user.raw'].json).toBe('garbage')
    expect(state.hidden).toEqual(['factory.bore-centre'])
  })

  it('a stored routine marked factory is quarantined - the factory set is compiled in', () => {
    const state = loadProbeRoutineLibrary({ routines: { 'factory.bore-centre': FACTORY_BORE_CENTRE } })
    expect(state.routines).toEqual({})
    expect(state.quarantined['factory.bore-centre'].errors[0]).toContain('cannot be a factory routine')
    expect(listProbeRoutines(state).find((e) => e.routine.id === 'factory.bore-centre')?.routine).toBe(FACTORY_BORE_CENTRE)
  })

  it('garbage yields the empty library', () => {
    expect(loadProbeRoutineLibrary(null)).toEqual(EMPTY_PROBE_ROUTINE_LIBRARY)
    expect(loadProbeRoutineLibrary('x')).toEqual(EMPTY_PROBE_ROUTINE_LIBRARY)
    expect(loadProbeRoutineLibrary({ routines: [], hidden: 'no' })).toEqual(EMPTY_PROBE_ROUTINE_LIBRARY)
  })

  it('saving over a quarantined id clears the quarantine entry', () => {
    const state = loadProbeRoutineLibrary({ routines: { 'user.my-bore': { ...userRoutine(), steps: [{ kind: 'gcode', line: 'G10 L20 P0 X0' }] } } })
    expect(Object.keys(state.quarantined)).toEqual(['user.my-bore'])
    const fixed = saveProbeRoutine(state, userRoutine())
    expect(fixed.ok && fixed.state.quarantined).toEqual({})
  })
})

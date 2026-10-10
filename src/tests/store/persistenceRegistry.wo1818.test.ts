// WO-1818: one persistence registry classifies every persisted surface.
//
// Two things prove this holds, matching the WO's own acceptance wording
// ("a test adds a dummy field to the Project type and proves the build or
// the census fails until it is classified"):
//  - the BUILD leg: PROJECT_FIELD_TREATMENT is typed
//    `Record<keyof Project, ProjectFieldTreatment>`, so `tsc -b` (npm run
//    build) already refuses to compile if a field is added to `Project`
//    (src/types/index.ts) without a matching entry here. The
//    `@ts-expect-error` block below reproduces that failure on a LOCAL
//    dummy field, so the mechanism is exercised, not just asserted in prose.
//    vitest's esbuild transform does not type-check, so this block proves
//    nothing when this FILE runs under `vitest run` - it proves something
//    when the project builds, which is the other half of the WO's own
//    "build or census" wording.
//  - the CENSUS leg: a runtime data census (every registered field carries a
//    valid treatment; the shared strip functions behave as documented),
//    which vitest DOES exercise every run.
import { describe, expect, it } from 'vitest'
import type { Operation, Project } from '../../types'
import {
  OPERATION_PERSISTED_FIELD_TREATMENT,
  omitProjectFields,
  PERSISTED_SURFACES,
  PROJECT_FIELD_TREATMENT,
  PROJECT_HOLDER_OWNED_RAW_STRIP_FIELDS,
  stripOperationForPersistence,
} from '../../store/persistenceRegistry'

const VALID_PROJECT_TREATMENTS = new Set([
  'core', 'root-lifted', 'localstorage-heavy', 'holder-owned',
])

describe('WO-1818 persistence registry: the Project field census', () => {
  it('every registered field carries one of the four defined treatments', () => {
    for (const [field, treatment] of Object.entries(PROJECT_FIELD_TREATMENT)) {
      expect(VALID_PROJECT_TREATMENTS.has(treatment), `${field} has an unrecognised treatment: ${treatment}`).toBe(true)
    }
  })

  it('the build leg: an unclassified Project field fails tsc -b (dummy-field proof)', () => {
    // This scenario only fails to compile under `tsc` (`npm run build`), the
    // BUILD leg of the WO's "build or census" acceptance wording - vitest's
    // esbuild transform does not type-check test files. `@ts-expect-error`
    // demands the error actually fire: if PROJECT_FIELD_TREATMENT is ever
    // widened to an index signature (silently accepting any field), this
    // line stops erroring and tsc flags the UNUSED directive instead - the
    // census can't go quietly stale in either direction.
    type ProjectWithWo1818DummyField = Project & { wo1818DummyField: string }
    // @ts-expect-error - wo1818DummyField is absent from PROJECT_FIELD_TREATMENT; classify it (src/store/persistenceRegistry.ts) before this line compiles.
    const exhaustiveCensus: Record<keyof ProjectWithWo1818DummyField, string> = PROJECT_FIELD_TREATMENT
    // Reached at runtime too (the cast succeeds under vitest's untyped
    // transform) - assert the table is still the same live object, not a
    // copy that could silently diverge from the production export.
    expect(exhaustiveCensus).toBe(PROJECT_FIELD_TREATMENT)
  })
})

describe('WO-1818 persistence registry: the one Project-document keep-list', () => {
  it('omitProjectFields drops the named fields and nothing else', () => {
    const project = {
      id: 'p1', name: 'Test', document: 'zip-bytes', modelItemDocuments: { a: 'x' },
    } as unknown as Project
    const stripped = omitProjectFields(project, PROJECT_HOLDER_OWNED_RAW_STRIP_FIELDS)
    expect('document' in stripped).toBe(false)
    expect('modelItemDocuments' in stripped).toBe(false)
    expect(stripped.id).toBe('p1')
    expect(stripped.name).toBe('Test')
  })

  it('omitProjectFields never mutates its input', () => {
    const project = { id: 'p1', document: 'zip-bytes' } as unknown as Project
    omitProjectFields(project, PROJECT_HOLDER_OWNED_RAW_STRIP_FIELDS)
    expect(project.document).toBe('zip-bytes')
  })
})

describe('WO-1818 persistence registry: the one Operation derived-field keep-list', () => {
  const opWithBoth = {
    id: 'op1',
    toolpathMoves: [{ x: 0, y: 0, z: 0 }],
    contourTabPreview: { loops: [{ loopId: 'l1', path: [], perimeter: 0 }], tabTopZ: -1 },
  } as unknown as Operation

  it('localstorage: strips toolpathMoves AND contourTabPreview', () => {
    const stripped = stripOperationForPersistence(opWithBoth, 'localstorage')
    expect(stripped.toolpathMoves).toBeUndefined()
    expect(stripped.contourTabPreview).toBeUndefined()
    expect(stripped.id).toBe('op1')
  })

  it('file: keeps toolpathMoves (a saved file must remain cuttable) but strips contourTabPreview (WO-1818 acceptance #3, setupClosureCensus.ts:130)', () => {
    const stripped = stripOperationForPersistence(opWithBoth, 'file')
    expect(stripped.toolpathMoves).toEqual(opWithBoth.toolpathMoves)
    expect(stripped.contourTabPreview).toBeUndefined()
  })

  it('never mutates its input', () => {
    stripOperationForPersistence(opWithBoth, 'localstorage')
    stripOperationForPersistence(opWithBoth, 'file')
    expect(opWithBoth.toolpathMoves).toBeDefined()
    expect(opWithBoth.contourTabPreview).toBeDefined()
  })

  it('is exhaustive over the two treatments this WO defines', () => {
    for (const treatment of Object.values(OPERATION_PERSISTED_FIELD_TREATMENT)) {
      expect(['localstorage-only-strip', 'always-strip']).toContain(treatment)
    }
  })
})

describe('WO-1818 persistence registry: every OTHER persisted surface', () => {
  it('names a non-empty version, migration policy and keep-list for each surface', () => {
    for (const surface of Object.values(PERSISTED_SURFACES)) {
      expect(surface.version.length, `${surface.id} has no version statement`).toBeGreaterThan(0)
      expect(surface.migration.length, `${surface.id} has no migration/mismatch policy`).toBeGreaterThan(0)
      expect(surface.keepList.length, `${surface.id} has no keep-list statement`).toBeGreaterThan(0)
    }
  })

  it('names the three machine-scoped stores, uiPrefs, an IndexedDB cache, and the userSpace envelope', () => {
    const ids = Object.keys(PERSISTED_SURFACES)
    expect(ids).toContain('machine-actions')
    expect(ids).toContain('machine-tool-table-legacy')
    expect(ids).toContain('probe-routines')
    expect(ids).toContain('ui-preferences')
    expect(ids).toContain('model-body-display-cache')
    expect(ids).toContain('user-space-envelope')
    expect(ids).toContain('project-document')
  })
})

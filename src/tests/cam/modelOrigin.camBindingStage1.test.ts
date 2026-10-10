// CAM-BINDING Stage 1 (coordination/work-orders/CAM-BINDING.md): unit + scope
// tests for the new `isModelOpSourceEligible` predicate (src/lib/cam/
// modelOrigin.ts) - the narrow, separately-named relaxation the charter's
// Stage 1 work-order-grade detail mandates ("add a second, narrower predicate
// distinct from isModelOriginGeometry... used ONLY at the op-source-list
// seams. Do not weaken isModelOriginGeometry itself").
//
// This file proves two things a behavioural test elsewhere cannot:
//   1. isModelOpSourceEligible today agrees exactly with isModelOriginGeometry
//      (every live modeled body is a legal Stage 1 source, whole-body only).
//   2. isModelOpSourceEligible is NOT imported anywhere stock/delete/nest-
//      aggregation live - a static, can-fail proof that Stage 1 did not widen
//      any OTHER modelOrigin consumer's refusal, which is the charter's own
//      named regression risk (the INT-17A-R1 audit precedent: a guard stated
//      at one seam is a guard a NEW seam can silently opt out of - here
//      inverted to "a NEW allowance must not silently spread").

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  isModelOriginGeometry,
  isModelOpSourceEligible,
  MODEL_BODY_BINDING_CAPABILITIES,
  modelOriginRefusal,
  resolveOwningModelItemId,
  type ModelOriginCandidate,
} from '../../lib/cam/modelOrigin'

describe('MODEL-BODY-BIND-ADAPTIVE capability map', () => {
  it('classifies every operation and exposes adaptive as a supported profile binding', () => {
    expect(Object.keys(MODEL_BODY_BINDING_CAPABILITIES)).toHaveLength(16)
    // WO-1963: Face fills the modeled body's profile, as Pocket does.
    expect(MODEL_BODY_BINDING_CAPABILITIES.face).toEqual({
      mode: 'profile', computeSupported: true,
    })
    expect(MODEL_BODY_BINDING_CAPABILITIES.contour_2d).toEqual({
      mode: 'profile', computeSupported: true,
    })
    expect(MODEL_BODY_BINDING_CAPABILITIES.pocket_2d).toEqual({
      mode: 'profile', computeSupported: true,
    })
    expect(MODEL_BODY_BINDING_CAPABILITIES.adaptive_clearing_2d).toEqual({
      mode: 'profile', computeSupported: true,
    })
    expect(MODEL_BODY_BINDING_CAPABILITIES.drill).toEqual({
      mode: 'hole-targets', computeSupported: true,
    })
    expect(MODEL_BODY_BINDING_CAPABILITIES.bore).toEqual({
      mode: 'cylinder-targets', computeSupported: true,
    })
    // WO-1939: Engrave computes from a picked model edge chain.
    expect(MODEL_BODY_BINDING_CAPABILITIES.engrave).toEqual({
      mode: 'edge-paths', computeSupported: true,
    })
    // WO-1954: Parallel 3D finishes the modeled solid, as Adaptive 3D roughs it.
    expect(MODEL_BODY_BINDING_CAPABILITIES.parallel_3d).toEqual({
      mode: 'solid', computeSupported: true,
    })
    // WO-1956: Waterline 3D slices the modeled solid through the same adapter.
    expect(MODEL_BODY_BINDING_CAPABILITIES.waterline_3d).toEqual({
      mode: 'solid', computeSupported: true,
    })
    // WO-1957: Scallop 3D follows the modeled solid through the same adapter.
    expect(MODEL_BODY_BINDING_CAPABILITIES.scallop_3d).toEqual({
      mode: 'solid', computeSupported: true,
    })
    // WO-1958: Steep/Shallow 3D splits the modeled solid through the same adapter.
    expect(MODEL_BODY_BINDING_CAPABILITIES.steep_shallow_3d).toEqual({
      mode: 'solid', computeSupported: true,
    })
    // WO-1959: Pencil 3D traces the modeled solid's corners through the same adapter.
    expect(MODEL_BODY_BINDING_CAPABILITIES.pencil_3d).toEqual({
      mode: 'solid', computeSupported: true,
    })
    expect(MODEL_BODY_BINDING_CAPABILITIES.adaptive_3d).toEqual({
      mode: 'solid', computeSupported: true,
    })
  })
})

describe('isModelOpSourceEligible (CAM-BINDING Stage 1)', () => {
  it('agrees with isModelOriginGeometry for every candidate shape today', () => {
    const cases: (ModelOriginCandidate | null | undefined)[] = [
      { format: 'model' },
      { format: 'dxf' },
      { format: 'step' },
      { format: undefined },
      null,
      undefined,
      {}, // format missing entirely
    ]
    for (const c of cases) {
      expect(isModelOpSourceEligible(c)).toBe(isModelOriginGeometry(c))
    }
  })

  it('is TRUE for a model-origin row regardless of type/loops (whole-body granularity, not shape-keyed)', () => {
    // Mirrors modelOrigin.ts's own "keyed on format alone" doctrine (the R1
    // audit's shape-spoofing lesson): a hand-built row wearing type:'brep' and
    // real loops must still read as eligible, and a bare {format:'model'} row
    // with none of that must ALSO read as eligible - origin is the only thing
    // that must never be spoofable in either direction.
    expect(isModelOpSourceEligible({ format: 'model' })).toBe(true)
    expect(isModelOpSourceEligible(
      { format: 'model', type: 'brep', loops: [{ closed: true }] } as unknown as ModelOriginCandidate,
    )).toBe(true)
  })

  it('is FALSE for every non-model format (mutation-provable: invert the body and this goes RED)', () => {
    expect(isModelOpSourceEligible({ format: 'stl' })).toBe(false)
    expect(isModelOpSourceEligible({ format: 'step' })).toBe(false)
    expect(isModelOpSourceEligible({ format: 'dxf' })).toBe(false)
    expect(isModelOpSourceEligible(undefined)).toBe(false)
  })
})

describe('CAM-BINDING Stage 1 scope boundary: isModelOpSourceEligible must not leak into another modelOrigin consumer', () => {
  const SRC = join(process.cwd(), 'src')

  function productionFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === 'tests') continue
        productionFiles(full, out)
      } else if (/\.tsx?$/.test(name)) {
        out.push(full)
      }
    }
    return out
  }

  // The charter's own named list of consumers that must keep refusing
  // COMPLETELY unchanged: stock membership/assignment, delete, and nest
  // aggregation. None of these may import the new narrower predicate - doing
  // so would be exactly the "Stage 1 touched a seam it must not touch" defect
  // the work order calls out.
  const MUST_NOT_IMPORT_ELIGIBLE = [
    'store/stockAssignment.ts',
    'store/migrateHierarchy.ts',
    'components/panels/DesignTree.tsx',
    'store/dispatchGeo.ts',
  ]

  // BK-178-DECOMP (commits 2d398686c/999fa839c/bfbff0258, 2026-07-24) split
  // the 5900-line NewOperationModal.tsx into a thin wrapper + child modules;
  // the op-source-list seam's isModelOpSourceEligible import (and every
  // project.geometry read alongside it - see
  // src/tests/store/int17aR1ConsumerCensus.test.ts's own relocation fix)
  // moved verbatim into the new NewOperationModalBody.tsx. The wrapper file
  // itself no longer imports it at all (grepped: zero matches). Re-verified
  // by grep there is still exactly ONE real importer, not two: store/index.ts
  // contains only a doc-comment MENTION of the name (line ~7810, explaining a
  // different filter's relationship to this one), which the import-statement
  // regex below correctly does not match - confirmed no second consumer
  // appeared anywhere, so this is a pure rename, not a scope-boundary leak.
  it('isModelOpSourceEligible is imported ONLY by the op-source-list seam (NewOperationModalBody.tsx)', () => {
    // Matches a real `import { ... isModelOpSourceEligible ... } from '...'`
    // statement, not a doc-comment MENTION of the name (e.g. a file explaining
    // why it deliberately does NOT use it) - a free-text grep would false-
    // positive on exactly the kind of drive-by comment this codebase writes.
    const IMPORT_RE = /import\s*(?:type\s*)?\{[^}]*\bisModelOpSourceEligible\b[^}]*\}\s*from/
    const importers = productionFiles(SRC)
      .filter((f) => IMPORT_RE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .sort()

    expect(importers).toEqual(['components/modals/NewOperationModalBody.tsx'])
    for (const forbidden of MUST_NOT_IMPORT_ELIGIBLE) {
      expect(importers).not.toContain(forbidden)
    }
  })

  it('every stock/delete/nest-aggregation consumer still imports the UNCHANGED isModelOriginGeometry, not the narrower predicate', () => {
    for (const f of MUST_NOT_IMPORT_ELIGIBLE) {
      const text = readFileSync(join(SRC, f), 'utf8')
      expect(text, `${f} must still gate on isModelOriginGeometry`).toMatch(/isModelOriginGeometry/)
      expect(text, `${f} must NOT import the Stage 1 op-source relaxation`).not.toMatch(/isModelOpSourceEligible/)
    }
  })
})

describe('modelOriginRefusal (regression: unchanged by Stage 1)', () => {
  it('still renders the standard named-refusal shape for a non-op-source seam', () => {
    const msg = modelOriginRefusal('Stock membership', 'Model F1', 'it cannot be assigned to a stock.')
    expect(msg).toMatch(/Stock membership: refusing modeled geometry "Model F1"/)
    expect(msg).toMatch(/read-only projection/)
  })
})

// ---- INT-MODEL-UNIFY: resolveOwningModelItemId (shared nav-routing resolver) ----

describe('resolveOwningModelItemId (INT-MODEL-UNIFY shared resolver)', () => {
  it('drift guard: the local legacy-id replica equals documentHolder.LEGACY_MODEL_ITEM_ID', async () => {
    // resolveOwningModelItemId replicates LEGACY_MODEL_ITEM_ID locally (the
    // SAME precedent modelBodyAdapter.ts and projectMigrations.ts already
    // both follow, each pinned by their own drift-guard test).
    const { LEGACY_MODEL_ITEM_ID } = await import('../../doc/documentHolder')
    expect(resolveOwningModelItemId({ format: 'model' })).toBe(LEGACY_MODEL_ITEM_ID)
  })

  it('a row with a real modelItemId returns it unchanged (no legacy fallback applied)', () => {
    expect(resolveOwningModelItemId({ format: 'model', modelItemId: 'item-a' })).toBe('item-a')
  })

  it('a row with a STALE modelItemId (no matching record, unknowable to this pure resolver) still returns it unchanged -- the caller\'s own existence check decides', () => {
    expect(resolveOwningModelItemId({ format: 'model', modelItemId: 'ghost-item' })).toBe('ghost-item')
  })

  it('a model-origin row with NO modelItemId (the legacy-scoped shape modelBodyAdapter.ts writes by design) falls back to the legacy id', () => {
    expect(resolveOwningModelItemId({ format: 'model' })).toBe('legacy')
  })

  it('a non-model row returns undefined regardless of any modelItemId field (nothing to route to)', () => {
    expect(resolveOwningModelItemId({ format: 'dxf' })).toBeUndefined()
    expect(resolveOwningModelItemId({ format: 'step', modelItemId: 'item-a' } as unknown as ModelOriginCandidate)).toBeUndefined()
  })

  it('null/undefined input returns undefined', () => {
    expect(resolveOwningModelItemId(null)).toBeUndefined()
    expect(resolveOwningModelItemId(undefined)).toBeUndefined()
  })
})

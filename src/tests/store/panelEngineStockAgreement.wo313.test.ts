// @vitest-environment jsdom
//
// WO-313 - the panel must agree with the engine.
//
// WO-305's audit closed a total outage (3D adaptive roughing refused every
// modeled body) but left ONE thing open, which its own audit named,
// reproduced, and stated as a landing condition: `src/store/index.ts`
// (the ENGINE) now passes `stocks` into `effectiveStockIdForCompute` when it
// counts how many solid parts share an op's stock (`solidPartsOnStock`), but
// `src/components/panels/PropertiesPanel.tsx` (the operator-facing PANEL,
// `RoughingScopeFallback`) called the SAME resolver without `stocks`. Both
// feed the SAME count into the SAME `resolveStockOutlineMode` safety gate, so
// the two halves of one gate could answer differently: the engine downgrades
// a "Clear all stock" op to part bounds, and the one surface built to tell
// the operator so stays silent.
//
// This file pins the fix (`PropertiesPanel.tsx:4420,4425` now pass `stocks`,
// same as `store/index.ts:2350,2357`) against BOTH scenarios the WO-305
// audit's own reproduction named:
//   scenario A - a STEP/STL part on the auto stock + one unlocked modeled body
//   scenario B - two unlocked modeled bodies on the auto stock
// asserting the engine's own `solidPartsOnStock` count and the panel's
// rendered disclosure agree - and that the disclosure text is byte-identical
// to what the SAME production decision (`resolveStockOutlineMode` +
// `roughingScopeFallbackMessage`, both real, unmodified imports) produces for
// the engine's actual count. Before the fix, the panel undercounts to 1 in
// both scenarios, so no disclosure renders and this file fails loudly with
// "unable to find an element by testid".
//
// WO-2007 round 3 (CS 21): the panel's notice row is removed (Operator: values only); each
// scenario now pins the engine count + decision and that Properties shows no notice row.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { effectiveStockIdForCompute } from '../../store/stockAssignment'
import { resolveStockOutlineMode, roughingScopeFallbackMessage } from '../../cam3d/integration/adaptive3dOperation'
import type { ImportedGeometry, Project } from '../../types'

const EVIDENCE_DIR = join(process.cwd(), 'src', 'tests', 'evidence', 'WO-305')
const PROJECT_PATH = join(EVIDENCE_DIR, 'operator-adaptive-3d-refuses.camproject')

function loadSampleMachineProject(): Project {
  return JSON.parse(readFileSync(PROJECT_PATH, 'utf8')) as Project
}

function activeOp(project: Project) {
  const setup = project.setups.find((s) => s.id === project.activeSetupId)
  const op = setup?.operations.find((o) => o.id === project.activeOperationId)
  if (!setup || !op) throw new Error('WO-313 fixture: active setup/operation not found')
  return op
}

// A STEP part hand-assigned to the derived auto stock (stockId set directly,
// mirroring what assignGeometryToStocks would do for a real spatially-
// contained STEP/STL part). Not model-origin, so RoughingScopeFallback's
// model-placement branch never runs for it - only the count logic under test
// touches it.
function syntheticStepPart(id: string, stockId: string): ImportedGeometry {
  return {
    id,
    name: 'WO-313 STEP part',
    type: 'mesh',
    format: 'step',
    loaded: true,
    stockId,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 20, y: 20, z: 10 },
    },
  } as unknown as ImportedGeometry
}

// A second unlocked modeled body sharing Operator's real fixture geometry/modelBody
// shape (deep-cloned with a new id) - the same construction
// modelBodyStockBinding.wo305.test.ts uses for its own "two modeled bodies"
// audit-fix test, so modelItemPlacements/modelBody.ref resolution (which
// RoughingScopeFallback's isModelOriginGeometry branch depends on) stays real
// and valid rather than hand-built and fragile.
function cloneModelBody(source: ImportedGeometry, id: string, name: string): ImportedGeometry {
  return { ...(JSON.parse(JSON.stringify(source)) as ImportedGeometry), id, name }
}

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

/** Seeds the store with `geometry`, the fixture's setup/op (re-targeted at
 *  `targetId`, "Clear all stock" requested), and the fixture's own
 *  stocks/modelItemPlacements - so the panel resolves membership exactly as
 *  the real app would for this project. */
function seedPanel(fixture: Project, geometry: ImportedGeometry[], targetId: string): void {
  const op = activeOp(fixture)
  act(() => {
    const current = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: fixture.toolLibrary,
      project: {
        ...current.project,
        ...fixture,
        geometry,
        setups: fixture.setups.map((s) =>
          s.id !== fixture.activeSetupId
            ? s
            : {
                ...s,
                operations: s.operations.map((o) =>
                  o.id !== op.id
                    ? o
                    : { ...o, geometrySelections: [targetId], params: { ...o.params, useStockBoundary: true } },
                ),
              },
        ),
      },
      viewer: {
        ...current.viewer,
        selectedGeometryId: null,
        selectedStockId: null,
        selectedNestId: null,
      },
    } as never)
  })
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
  // sceneStock.mode is 'auto' for this fixture, so the panel's footprint can
  // only come from the viewport handle (fixedFootprintAvailable requires
  // mode !== 'auto') - stub it exactly as the app publishes it.
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: -50, y: -25, z: 0 }, max: { x: 50, y: 25, z: 40 } }),
  }
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

const STORE_SOURCE = readFileSync(join(process.cwd(), 'src', 'store', 'index.ts'), 'utf8')

/** Mirrors src/store/index.ts's own solidPartsOnStock filter - the ENGINE
 *  half of the gate WO-305/WO-313 fixed - using the SAME unmodified resolver
 *  (effectiveStockIdForCompute) both call sites share. Pinned immediately
 *  below against the live source, so a future change to the engine's own
 *  formula fails this file loudly instead of silently drifting from what it
 *  mirrors. */
function engineSolidPartsOnStock(
  geometry: ReadonlyArray<ImportedGeometry>,
  stocks: Project['stocks'],
  target: ImportedGeometry,
): number {
  const myStockId = effectiveStockIdForCompute(target, [], stocks ?? [])
  if (myStockId === undefined) return 1
  return geometry.filter(
    (g) =>
      (g.format === 'step' || g.format === 'stl' || g.format === 'model') &&
      effectiveStockIdForCompute(g, [], stocks ?? []) === myStockId,
  ).length
}

describe('WO-313 pin: the engine formula this file mirrors is still what index.ts runs', () => {
  it('src/store/index.ts still resolves solidPartsOnStock WITH stocks at both call sites', () => {
    expect(STORE_SOURCE).toContain('effectiveStockIdForCompute(geo, nestsForCompute, stocksForCompute)')
    expect(STORE_SOURCE).toContain('effectiveStockIdForCompute(g, nestsForCompute, stocksForCompute) === myStockId')
  })
})

describe('WO-313 scenario A: a STEP part on the auto stock + one unlocked modeled body', () => {
  it('the engine\'s solidPartsOnStock count forces the fallback and Properties shows no notice row', () => {
    const fixture = loadSampleMachineProject()
    const derivedStock = fixture.stocks?.[0]
    if (!derivedStock) throw new Error('WO-313 fixture: expected a derived stock')
    const modelBody = fixture.geometry[0]
    const stepPart = syntheticStepPart('wo313-scenario-a-step', derivedStock.id)
    const geometry = [stepPart, modelBody]

    // The engine sees both: the STEP part (its own stockId) plus the
    // unlocked modeled body (resolved to the SAME catch-all stock only when
    // `stocks` is passed) - the exact WO-305 audit reproduction ("engine=2").
    const engineCount = engineSolidPartsOnStock(geometry, fixture.stocks, stepPart)
    expect(engineCount).toBe(2)

    seedPanel(fixture, geometry, stepPart.id)
    render(React.createElement(PropertiesPanel))

    // WO-2007 round 3 (CS 21): no fallback notice row in Properties; the engine's console.warn
    // (store/index.ts, decision.reason) reports it.
    expect(screen.getByTestId('props-adaptive3d-roughing-scope')).toBeTruthy()
    expect(screen.queryByTestId('props-adaptive3d-scope-fallback')).toBeNull()
    expect(document.body.textContent).not.toContain('Clear all stock cannot run')

    const expectedMessage = roughingScopeFallbackMessage(resolveStockOutlineMode({
      useStockBoundary: true,
      unspun: true,
      hasFootprint: true,
      solidPartsOnStock: engineCount,
      opName: activeOp(fixture).name,
    }))
    expect(expectedMessage).toContain('2 parts share this stock')
  })
})

describe('WO-313 scenario B: two unlocked modeled bodies on the auto stock', () => {
  it('the engine\'s solidPartsOnStock count forces the fallback and Properties shows no notice row', () => {
    const fixture = loadSampleMachineProject()
    const modelBody1 = fixture.geometry[0]
    const modelBody2 = cloneModelBody(modelBody1, 'modelbody:F1-neighbour-wo313', 'Extrude F1 (neighbour, WO-313)')
    const geometry = [modelBody1, modelBody2]

    // This is the exact configuration modelBodyStockBinding.wo305.test.ts's
    // own audit-fix test proves the REAL engine (via computeOperationToolpath,
    // not a mirror) disables full-clear for, with a console.warn reading
    // "2 parts share this stock". The mirror below reproduces that same
    // engine count for THIS project shape.
    const engineCount = engineSolidPartsOnStock(geometry, fixture.stocks, modelBody1)
    expect(engineCount).toBe(2)

    seedPanel(fixture, geometry, modelBody1.id)
    render(React.createElement(PropertiesPanel))

    // WO-2007 round 3 (CS 21): no fallback notice row in Properties; the engine's console.warn
    // (store/index.ts, decision.reason) reports it.
    expect(screen.getByTestId('props-adaptive3d-roughing-scope')).toBeTruthy()
    expect(screen.queryByTestId('props-adaptive3d-scope-fallback')).toBeNull()
    expect(document.body.textContent).not.toContain('Clear all stock cannot run')

    // "what the engine actually did": the SAME real resolveStockOutlineMode +
    // roughingScopeFallbackMessage the engine's own console.warn text is
    // built from (adaptive3dOperation.ts), fed the engine's own count.
    const expectedMessage = roughingScopeFallbackMessage(resolveStockOutlineMode({
      useStockBoundary: true,
      unspun: true,
      hasFootprint: true,
      solidPartsOnStock: engineCount,
      opName: activeOp(fixture).name,
    }))
    expect(expectedMessage).toContain('2 parts share this stock')
  })
})

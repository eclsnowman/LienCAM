// WO-305 - adaptive 3D refused every modeled body, including Operator's own: he
// built a part in this app's own modeller, took the auto stock, added one 3D
// adaptive rough, and got "the top of material is not proven" on the easiest
// case there is.
//
// Root cause (traced in the work order, verified here): TWO different
// functions answered "which stock does this geometry cut in" for a modeled
// body, and they disagreed. deriveStockBounds/derivedStockMembers (the
// rendered box, and the "Member parts" count) already knew an unlocked model
// row belongs to the catch-all derived stock. resolveProvenCam3dStockBounds's
// equality check (effectiveStockIdForCompute) did not - it only ever read
// geometry.stockId, which assignGeometryToStocks deliberately leaves
// undefined for an unlocked model row (INT-17A-R1 C3), so the gate always
// saw "no stock" even when the design tree, and the box drawn in the
// viewport, both said otherwise.
//
// The fix: effectiveStockIdForCompute is now THE single resolver. Passed
// `stocks`, it resolves an unlocked model row to the SAME catch-all derived
// stock id resolveStockMembershipState already names 'auto-catch-all' for
// the design tree - and derivedStockMembers now calls this exact function
// instead of re-deriving the same rule a second time. One resolver, one
// answer, everywhere.
//
// This file proves, in order:
//   1. Operator's own project (loaded verbatim) resolves its stock and generates
//      - the thing he could not do. This is the reproduction; it fails
//      against unfixed code (see the worker result for the failure output).
//   2. The safety invariant rule 1's comment protects is untouched: a model
//      row is still never spatially swept into an explicit stock by
//      containment.
//   3. The other safety invariant: an explicit "no stock" (stockIdLocked with
//      no id) still fails loud, unchanged - the fix does not fold locked-none
//      rows into the catch-all.
//   4. The single-resolver proof at the unit level: whatever a derived
//      stock's membership rule claims as a member, effectiveStockIdForCompute
//      (the provenance gate's own resolver) names the same stock for.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { typedMock } from '../support/typedMock'
import {
  assignGeometryToStocks,
  derivedStockMembers,
  effectiveStockIdForCompute,
} from '../../store/stockAssignment'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { ImportedGeometry, Operation, PhysicalStock, Project, Setup } from '../../types'
import { buildAdaptive3dSmartIntent } from '../../lib/cam/smartHeights'
import { legacyHeightIntentForOperation, resolveHeightIntent } from '../../lib/cam/heightIntent'

const EVIDENCE_DIR = join(process.cwd(), 'src', 'tests', 'evidence', 'WO-305')
const PROJECT_PATH = join(EVIDENCE_DIR, 'operator-adaptive-3d-refuses.camproject')

function loadSampleMachineProject(): Project {
  return JSON.parse(readFileSync(PROJECT_PATH, 'utf8')) as Project
}

function activeOp(project: Project): Operation {
  const setup = project.setups.find((s) => s.id === project.activeSetupId)
  const op = setup?.operations.find((o) => o.id === project.activeOperationId)
  if (!setup || !op) throw new Error('WO-305 fixture: active setup/operation not found')
  return op
}

// This project fixture was captured live from the running app (see the
// header comment) before commit 2e5678b7 made a valid `smart_v2` envelope
// the only runtime height authority, so its active operation carries no
// smartHeight at all. Per ADR-0040 (no legacy before 1.0) that is stamped
// onto a copy of the loaded project, not migrated in the fixture file.
//
// Adaptive 3D's 'current_material'/'initial_stock' variants don't consult
// the operation's own Top/Bottom at all -- V2 always roughs from the proven
// stock surface down to the target model surface for those. This op's
// persisted heights are an explicit Top ('stock_top' + 0) and Bottom
// ('absolute' -5), i.e. a real authored depth, not "rough to the part": the
// faithful V2 equivalent is 'bounded_band' with that exact pair of WCS
// planes, resolved with the SAME production resolver (resolveHeightIntent)
// the pre-cutover legacy path used, off this fixture's own persisted stock
// top and WCS origin. Using 'current_material' instead changes the actual
// depth of cut the real BvhKernel sees and was observed to trip an unrelated
// plunge-safety refusal deeper in the adaptive rough - this is the fixture
// repair, not a workaround for that.
function withSmartHeightAuthority(project: Project): Project {
  const op = activeOp(project)
  const setup = project.setups.find((s) => s.id === project.activeSetupId) as Setup
  const stock = (project.stocks ?? []).find((s) => s.id === setup.wcs.stockId)
  if (!stock) throw new Error('WO-305 fixture: expected the setup\'s bound stock to be present')
  const stockTopWcsMm = stock.bounds.max.z - setup.wcs.origin.z
  const legacyIntent = legacyHeightIntentForOperation(op)
  const resolved = resolveHeightIntent(legacyIntent, {
    wcsOriginZ: setup.wcs.origin.z,
    referenceWcsZ: { stock_top: stockTopWcsMm },
  })
  const smartHeight = {
    kind: 'smart_v2' as const,
    intent: buildAdaptive3dSmartIntent({
      setupId: setup.id,
      geometryIds: op.geometrySelections,
      safetyIntent: legacyIntent,
      mode: 'bounded_band' as const,
      boundedBand: { topWcsMm: resolved.wcs.top, bottomWcsMm: resolved.wcs.bottom },
    }),
  }
  return {
    ...project,
    setups: project.setups.map((s) =>
      s.id !== project.activeSetupId
        ? s
        : {
            ...s,
            operations: s.operations.map((candidate) =>
              candidate.id !== op.id ? candidate : { ...candidate, smartHeight },
            ),
          },
    ),
  }
}

/** In-process real Cam3dClient (BvhKernel + Cam3dDispatcher, no browser worker) -
 *  mirrors adaptive3dHeightTruth.cam16.test.ts's makeClient so the real
 *  adaptive-rough kernel runs, not a mock, and the WO-305 defect (which lives
 *  in computeAdaptive3dMoves's own material-top gate) is actually exercised. */
function makeClient(): Cam3dClient {
  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest)
    },
    terminate(): void {
      // The in-process test channel owns no browser worker.
    },
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent)
  })
  return new Cam3dClient(fakeWorker)
}

interface ComputeOutcome {
  status: Operation['status']
  errorMessage?: string
  moveCount: number
  stockTopZ?: number
}

/** Installs `project` verbatim into the real store and runs the REAL
 *  production computeOperationToolpath end to end (no compute-layer mocks) -
 *  only the cam3d worker transport is swapped for the in-process client. */
async function runProject(project: Project): Promise<ComputeOutcome> {
  vi.resetModules()
  const client = makeClient()
  vi.doMock('../../cam3d/integration/appClient', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => client,
  }))
  const localStorage = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', { localStorage })
  try {
    const { useCamStore } = await import('../../store')
    const op = activeOp(project)
    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        ...project,
      },
      toolLibrary: project.toolLibrary,
      toolpathBatch: null,
    }))
    await useCamStore.getState().computeOperationToolpath(project.activeSetupId!, op.id)
    const storedOp = activeOp(useCamStore.getState().project)
    return {
      status: storedOp.status,
      errorMessage: storedOp.errorMessage,
      moveCount: storedOp.toolpathMoves?.length ?? 0,
      stockTopZ: storedOp.resolvedHeights?.machine?.top,
    }
  } finally {
    await client.dispose()
    vi.doUnmock('../../cam3d/integration/appClient')
    vi.unstubAllGlobals()
    vi.resetModules()
  }
}

describe('WO-305 Operator\'s project: adaptive 3D on a modeled body + auto stock', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it(
    'resolves its own auto stock and generates - the thing Operator could not do',
    async () => {
      const project = loadSampleMachineProject()
      const before = activeOp(project)
      // Sanity on the fixture itself: this is the exact reproduction the WO
      // names, not a stand-in. The file even carries the live refusal Operator's
      // app produced (persisted the moment he hit it), before this fix.
      expect(project.geometry).toHaveLength(1)
      expect(project.geometry[0].format).toBe('model')
      expect(project.stocks?.[0]?.mode).toBe('derived')
      expect(before.errorMessage).toMatch(/top of material is not proven/)

      const result = await runProject(withSmartHeightAuthority(project))

      expect(result.errorMessage).toBeUndefined()
      expect(result.status).toBe('ready')
      expect(result.moveCount).toBeGreaterThan(0)

      // Tier 2 evidence capture (rule 6): the SAME run that asserts success
      // also records it, so the capture cannot drift from the product. One
      // compute only - the real adaptive-rough kernel is expensive enough
      // that a second, separate "evidence" test would just double the cost
      // for no additional proof.
      const capture = [
        'WO-305 - a part built in this app\'s own modeller resolves its own auto',
        'stock; Adaptive 3D generates instead of refusing it.',
        '',
        'Generated by src/tests/store/modelBodyStockBinding.wo305.test.ts on the',
        'same run that asserts it, so it cannot drift from the product.',
        '',
        'The project: src/tests/evidence/WO-305/operator-adaptive-3d-refuses.camproject',
        '(Operator\'s own part, modelled in LienCAM, auto stock, one 3D adaptive rough).',
        '',
        'BEFORE - what the file recorded live, from the running app, the moment',
        'Operator hit this (persisted op.status / op.errorMessage, unchanged by this test):',
        '',
        `  status: ${before.status}`,
        `  errorMessage: ${before.errorMessage}`,
        '',
        'AFTER - this test run, against the fixed resolver:',
        '',
        `  status: ${result.status}`,
        `  errorMessage: ${result.errorMessage ?? '(none)'}`,
        `  generated moves: ${result.moveCount}`,
        `  resolved stock top Z (machine): ${result.stockTopZ ?? '(n/a)'}`,
        '',
      ].join('\n')
      // WO-1093 rule (applied by WO-1280): the capture is written ONLY under WRITE_EVIDENCE=1;
      // the assertions above run regardless.
      if (process.env.WRITE_EVIDENCE === '1') {
        mkdirSync(EVIDENCE_DIR, { recursive: true })
        writeFileSync(join(EVIDENCE_DIR, 'adaptive3d-generates.txt'), capture, 'utf8')
      }
    },
    120_000,
  )
})

describe('WO-305 control: a modeled body is still never swept into a stock by containment', () => {
  it('an unlocked model row stays unassigned even fully inside an explicit stock (rule 1, unchanged)', () => {
    const project = loadSampleMachineProject()
    const modelGeo = project.geometry[0]
    // A generous explicit stock that fully contains the part's AABB
    // (-43.8..43.8 x -19.5..19.5 x 0..35) by construction.
    const explicitStock: PhysicalStock = {
      id: 'explicit-containing-stock',
      name: 'Vice stock',
      mode: 'explicit',
      bounds: {
        min: { x: -100, y: -100, z: -100 },
        max: { x: 100, y: 100, z: 100 },
        size: { x: 200, y: 200, z: 200 },
        center: { x: 0, y: 0, z: 0 },
      },
      position: { x: -100, y: -100, z: -100 },
    }

    const out = assignGeometryToStocks([modelGeo], [explicitStock])

    expect(out[0].stockId).toBeUndefined()
  })
})

describe('WO-305 control: an explicit "no stock" on a modeled body still fails loud, unchanged', () => {
  it('stockIdLocked===true with no stockId resolves to no stock and the op still errors', async () => {
    const project = loadSampleMachineProject()
    const lockedNoStockGeo: ImportedGeometry = {
      ...project.geometry[0],
      stockIdLocked: true,
      stockId: undefined,
    }
    const stocks = project.stocks as PhysicalStock[]

    // Unit-level pin: the single resolver must NOT fold a deliberate
    // "no stock" into the catch-all just because `stocks` is now supplied.
    expect(effectiveStockIdForCompute(lockedNoStockGeo, [], stocks)).toBeUndefined()

    // End-to-end: the operation still refuses, loudly.
    const mutated: Project = { ...project, geometry: [lockedNoStockGeo] }
    const result = await runProject(withSmartHeightAuthority(mutated))

    expect(result.status).toBe('error')
    expect(result.errorMessage).toBeTruthy()
    expect(result.moveCount).toBe(0)
  }, 30_000)
})

describe('WO-305 the single resolver: derivation and provenance agree', () => {
  it('effectiveStockIdForCompute names the same stock derivedStockMembers already claims the geometry for', () => {
    const project = loadSampleMachineProject()
    const stocks = project.stocks as PhysicalStock[]
    const derivedStock = stocks.find((s) => s.mode === 'derived')
    if (!derivedStock) throw new Error('WO-305 fixture: expected a derived stock')
    const modelGeo = project.geometry[0]

    const members = derivedStockMembers(derivedStock, project.geometry, stocks)
    expect(members.map((g) => g.id)).toContain(modelGeo.id)

    // The provenance gate's own resolver must name that SAME stock for that
    // SAME geometry - this is the WO-305 defect, pinned so it cannot return.
    expect(effectiveStockIdForCompute(modelGeo, [], stocks)).toBe(derivedStock.id)
  })

  it('a geometry the derived stock does NOT claim does not resolve to it either', () => {
    const project = loadSampleMachineProject()
    const stocks = project.stocks as PhysicalStock[]
    const derivedStock = stocks.find((s) => s.mode === 'derived')
    if (!derivedStock) throw new Error('WO-305 fixture: expected a derived stock')
    // A locked-none copy of the model row is deliberately NOT a member of
    // anything (ADR-0003 respects the explicit no-stock choice).
    const lockedNoStockGeo: ImportedGeometry = {
      ...project.geometry[0],
      id: 'locked-none-control',
      stockIdLocked: true,
      stockId: undefined,
    }

    const members = derivedStockMembers(derivedStock, [lockedNoStockGeo], stocks)
    expect(members).toHaveLength(0)
    expect(effectiveStockIdForCompute(lockedNoStockGeo, [], stocks)).toBeUndefined()
  })
})

// WO-305 AUDIT FIX: admitting modeled bodies to the provenance gate
// (resolveProvenCam3dStockBounds, above) newly makes the "Clear all stock"
// full-clear / side-entry safety gate REACHABLE for them - but that gate's
// neighbour count (solidPartsOnStock, index.ts:2341-2352) called
// effectiveStockIdForCompute WITHOUT `stocks`, so it kept returning undefined
// for every modeled body and fell into the "no resolvable stock -> 1" branch
// no matter how many modeled bodies actually shared the auto stock. Full-clear
// would then machine straight through a neighbour it could not see. The fix
// passes `stocks` at both call sites, the same one-argument change already
// made for operationStockId. This proves it end to end, through the REAL
// store compute path (not a mirrored copy of the gate logic).
describe('WO-305 audit fix: two modeled bodies on the auto stock disable full-clear', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it(
    'solidPartsOnStock counts BOTH modeled bodies, so full-clear falls back to part bounds instead of machining the neighbour',
    async () => {
      const project = loadSampleMachineProject()
      const op = activeOp(project)
      // A second, unlocked modeled body with no stockId of its own - exactly
      // like Operator's part - sharing the same derived "Auto Stock 1".
      const neighbour: ImportedGeometry = {
        ...(JSON.parse(JSON.stringify(project.geometry[0])) as ImportedGeometry),
        id: 'modelbody:F1-neighbour',
        name: 'Extrude F1 (neighbour)',
      }
      const mutated: Project = {
        ...project,
        geometry: [project.geometry[0], neighbour],
        setups: project.setups.map((s) =>
          s.id !== project.activeSetupId
            ? s
            : {
                ...s,
                operations: s.operations.map((o) =>
                  o.id !== op.id ? o : { ...o, params: { ...o.params, useStockBoundary: true } },
                ),
              },
        ),
      }

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await runProject(withSmartHeightAuthority(mutated))

      // Before the audit fix this call always undercounted at 1 (the WO-305
      // audit's own reproduction), so full-clear would have gone ahead and
      // treated `neighbour` as removable stock. With the fix, both modeled
      // bodies resolve to the same catch-all derived stock, the honest count
      // is 2, and resolveStockOutlineMode's HARD safety rule 4 fires instead.
      const fallbackWarning = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .find((msg) => msg.includes('parts share this stock'))
      expect(fallbackWarning).toMatch(/2 parts share this stock/)

      // The safety fallback still computes - using part bounds, not a crash
      // and not a silent skip.
      expect(result.status).toBe('ready')
      expect(result.moveCount).toBeGreaterThan(0)
    },
    120_000,
  )
})

// WO-1616 (Smart Heights finding SH-3): a 3D surface finish measures its
// untouched default Retract and Clearance from the proven stock top, like every
// 2D operation - Retract stock top + 5, Clearance stock top + 15 - so no link
// runs along the uncut stock top. With no stock proven, the default binds to
// the model Top, as before.
//
// Production compute path: the store's computeOperationToolpath on the closed
// box (30 x 20 x 10). Only browser transports are replaced, exactly as in
// src/tests/heights/solids3d.wo1606.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (geoId: string) => (await import('../helpers/heightScenario')).solidStepBytes(geoId),
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarioModule.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))

import * as scenarioModule from '../helpers/heightScenario'
import { installRealToolpathWorker, isRapid, runSolidScenario, type ScenarioStock } from '../helpers/heightScenario'
import { useCamStore } from '../../store'
import type { ToolpathMove } from '../../types'
import { TRAVERSE_STANDOFF_MM } from '../../cam3d/pathbuild'

installRealToolpathWorker()

const TOL = 0.01
const STOCKS: Record<'fixed' | 'auto', ScenarioStock> = {
  fixed: { kind: 'fixed', width: 50, height: 40, depth: 15, position: { x: -10, y: -10, z: 0 } },
  auto: { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 },
}
const lowest = (moves: ToolpathMove[]) => moves.reduce((z, m) => Math.min(z, m.z), Infinity)
const highest = (moves: ToolpathMove[]) => moves.reduce((z, m) => Math.max(z, m.z), -Infinity)

describe('WO-1616 3D finishes measure Retract and Clearance from a proven stock top', () => {
  for (const op of ['parallel_3d', 'waterline_3d'] as const) {
    for (const stock of ['fixed', 'auto'] as const) {
      it(`${op} on the box, ${stock} stock: every link at or above stock top + 5, clearance stock top + 15`, async () => {
        const [r] = await runSolidScenario({ part: 'closed_box', z: 0, stock: STOCKS[stock], operations: [{ kind: op, toolDiameter: 6 }] })
        expect(r.status, r.errorMessage).toBe('ready')
        expect(r.stockTopWcs, 'WCS zero is the stock top').toBeCloseTo(0, 2)
        const rapids = r.moves.filter(isRapid)
        expect(rapids.length).toBeGreaterThan(0)
        // WO-2210: a Parallel finish links between passes just over the proven stock top (WCS 0) + standoff;
        // its approach and final retract stay at Clearance. Waterline links at Retract as before.
        expect(lowest(rapids), 'lowest link Z (WCS)').toBeGreaterThanOrEqual((op === 'parallel_3d' ? TRAVERSE_STANDOFF_MM : 5) - TOL)
        expect(highest(r.moves), 'clearance').toBeCloseTo(15, 2)
        expect(r.heightsRow.retract, 'plan Retract').toBeCloseTo(5, 2)
        expect(r.heightsRow.clearance, 'plan Clearance').toBeCloseTo(15, 2)
        expect(r.plan?.safety.feed.wcsMm, 'plan Feed').toBeCloseTo(5, 2)
      }, 180_000)
    }
  }

  it('WRITE_EVIDENCE=1 dumps the Parallel finish moves on fixed stock for the side-view picture', async () => {
    if (process.env.WRITE_EVIDENCE !== '1') return
    const [r] = await runSolidScenario({ part: 'closed_box', z: 0, stock: STOCKS.fixed, operations: [{ kind: 'parallel_3d', toolDiameter: 6 }] })
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync('src/tests/evidence/WO-1616', { recursive: true })
    const label = process.env.WO1616_EVIDENCE_LABEL ?? 'after'
    writeFileSync(`src/tests/evidence/WO-1616/moves-${label}.json`, JSON.stringify({
      label, stockTopWcs: r.stockTopWcs, stockBottomWcs: r.stockBottomWcs, partTopWcs: r.partTopWcs,
      partBottomWcs: r.partBottomWcs, stockXY: r.stockXY, heightsRow: r.heightsRow,
      moves: r.moves.map(m => ({ t: isRapid(m) ? 'rapid' : 'feed', x: m.x, y: m.y, z: m.z })),
    }))
  }, 180_000)

  it.each(['parallel_3d', 'waterline_3d'] as const)(
    '%s on the box with no stock proven: Retract and Clearance still measure from the model Top', async op => {
      const [r] = await runSolidScenario({ part: 'closed_box', z: 0, stock: STOCKS.fixed, operations: [{ kind: op, toolDiameter: 6 }] })
      expect(r.status, r.errorMessage).toBe('ready')
      // Unbind the Setup from its stock: the compute can no longer prove one.
      const state = useCamStore.getState()
      const setup = state.project.setups[0]
      useCamStore.setState({
        project: {
          ...state.project,
          setups: [{
            ...setup,
            wcs: { ...setup.wcs, stockId: undefined, originBinding: undefined },
          }],
        },
      } as never)
      await useCamStore.getState().computeOperationToolpath(setup.id, r.opId)
      const computed = useCamStore.getState().project.setups[0].operations.find(o => o.id === r.opId)!
      expect(computed.status, computed.errorMessage).toBe('ready')
      const plan = computed.resolvedHeightPlan?.version === 2 ? computed.resolvedHeightPlan : undefined
      // Model top is WCS -5 (fixed stock 15 deep over a 10 mm box).
      expect(plan?.safety.retract.wcsMm, 'plan Retract').toBeCloseTo(0, 2)
      expect(plan?.safety.clearance.wcsMm, 'plan Clearance').toBeCloseTo(10, 2)
      const origin = setup.wcs.origin.z
      const rapids = (computed.toolpathMoves ?? []).filter(isRapid)
      expect(rapids.length).toBeGreaterThan(0)
      expect(lowest(rapids) - origin, 'lowest link Z (WCS)').toBeGreaterThanOrEqual(-TOL)
      expect(highest(computed.toolpathMoves ?? []) - origin, 'clearance').toBeCloseTo(10, 2)
    }, 180_000)
})

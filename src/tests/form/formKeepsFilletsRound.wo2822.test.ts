// @vitest-environment jsdom
//
// WO-2822: Form keeps an imported round fillet round. WO-2819 cell
// STEP-FORM-boss_fillet_base: From body on the boss_fillet_base STEP (plate
// 60x60x10, d20 x 12 boss, r3 foot fillet), then Finish with no edit, came back
// 164-181 mm^3 heavy, its r3 foot fillet a straight 45 degree bevel - the
// fillet's ring was taken for a ruled band (one ring of quads) and creased at
// both rims. A conversion with no edit must give the body back within the
// Form budget, every blend kind the WO-2757 fixtures carry included.
//
// Every cell runs the REAL Model screen (SolidsWorkbenchPage) on the REAL
// in-process occt kernel: the part comes in through the screen's own Import
// input, Form opens from its toolbar button, From body and Finish are the Form
// panel's own buttons, and the body Finish makes is the one the Model history
// replays (buildFormBody). The kernel is read only to MEASURE: the finished
// body's volume and its tessellation.
//
// Oracles (hand formulas from the fixture dimensions, generate_parts.py):
//   - volume within 1% of the part's hand-formula volume (the budget the From
//     body cylinder/cone tests hold, remeshRuled/remesh.test.ts); the boss also
//     within 0.1% - its whole r3 fillet is 129.5 mm^3, the bevel was +181;
//   - the finished body's surface within 0.25 mm of the imported body's, both
//     ways (no point of either more than that from the other);
//   - the boss foot: every point of the finished body in the fillet's corner
//     (r 10..13 from the boss axis, z 10..13) within 0.2 mm of the r3 arc
//     (centre r 13, z 13) - the bevel's middle is 0.88 mm off it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import type { BodyHandle } from '../../geom/geom-service'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { closestPointIndex } from '../../form/closestPoint'
import type { Vec3 } from '../../form/cage'
import { createFakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { stubCanvas2d } from '../model3d/stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from '../model3d/loadTolerantWaitFor'

const { stepCache } = vi.hoisted(() => ({ stepCache: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepCache.set(id, bytes) },
  loadCachedStep: async (id) => stepCache.get(id) ?? null,
  removeCachedStep: async (id) => { stepCache.delete(id) },
}))

// jsdom's localStorage is broken under Vitest's node launch flags (the same shim directEditAudit.wo2757 installs).
const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { useCamStore } = await import('../../store')
const { useFormStore } = await import('../../form/formStore')

const PI = Math.PI
const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const OUT = resolve(process.cwd(), 'src/tests/evidence/WO-2822')

/** Area and centroid offset (from the corner, along either leg) of the corner an r fillet fills or removes. */
const blendArea = (r: number) => r * r * (1 - PI / 4)
const blendOffset = (r: number) => (r * (10 - 3 * PI)) / (12 - 3 * PI)
/** a block w x d x h with its four vertical edges r6 */
const roundedBlock = (w: number, d: number, h: number, r: number) => (w * d - 4 * (r * r - (PI * r * r) / 4)) * h

interface Cell {
  id: string
  file: string
  /** hand-formula volume of the part, mm^3 */
  volume: number
  what: string
  /** tighter volume budget than 1%, as a fraction */
  volumeTol?: number
  /** extra check on the finished body's tessellation vertices: worst deviation, mm, with its budget */
  section?: { budget: number; measure: (pts: Vec3[]) => { worst: number; points: number } }
}

const CELLS: Cell[] = [
  {
    id: 'STEP-FORM-boss_fillet_base', file: 'boss_fillet_base.step',
    what: 'plate 60x60x10 + d20 x 12 boss, r3 fillet at the foot',
    // plate + boss + the r3 ring the fillet adds round the boss (Pappus: centroid at r 10 + offset)
    volume: 60 * 60 * 10 + PI * 10 * 10 * 12 + 2 * PI * (10 + blendOffset(3)) * blendArea(3),
    volumeTol: 0.001,
    section: {
      budget: 0.2,
      measure: (pts) => {
        let worst = 0, points = 0
        for (const p of pts) {
          const r = Math.hypot(p[0] - 30, p[1] - 30)
          if (r < 10.05 || r > 12.95 || p[2] < 10.05 || p[2] > 12.95) continue
          points++
          worst = Math.max(worst, Math.abs(Math.hypot(r - 13, p[2] - 13) - 3))
        }
        return { worst, points }
      },
    },
  },
  {
    id: 'STEP-FORM-fillet_chain', file: 'fillet_chain.step',
    what: 'block 60x40x20, vertical edges r6, the whole top loop r2',
    // the r2 removed along the 152 mm of straight top edges and round the four r6 corners (centroid at r 6 - offset)
    volume: roundedBlock(60, 40, 20, 6) - blendArea(2) * (2 * 48 + 2 * 28) - 2 * PI * (6 - blendOffset(2)) * blendArea(2),
  },
  {
    id: 'STEP-FORM-chamfer_chain', file: 'chamfer_chain.step',
    what: 'block 60x40x20, vertical edges r6, the top loop chamfered 2',
    // a 2 x 2 triangle (area 2, centroid 2/3 in) removed along the straight edges and round the corners
    volume: roundedBlock(60, 40, 20, 6) - 2 * (2 * 48 + 2 * 28) - 2 * PI * (6 - 2 / 3) * 2,
  },
  {
    id: 'STEP-FORM-pocket_floor_fillet', file: 'pocket_floor_fillet.step',
    what: 'block 60x40x20, pocket 30x20x8 (corners r5), floor edges r2',
    // the pocket's r5-cornered outline x 8 deep, less the r2 floor fillets left in it (round the corners at r 5 - offset)
    volume: 60 * 40 * 20 - roundedBlock(30, 20, 8, 5) + blendArea(2) * (2 * 20 + 2 * 10) + 2 * PI * (5 - blendOffset(2)) * blendArea(2),
  },
  {
    id: 'STEP-FORM-dome_on_plate', file: resolve(process.cwd(), 'test_fixtures/brep/fix_freeform.step'),
    what: 'block 40x40x10 + an r12 ball cap 14 tall (taller than a hemisphere)',
    // spherical cap: pi h^2 (3R - h) / 3
    volume: 40 * 40 * 10 + (PI * 14 * 14 * (3 * 12 - 14)) / 3,
  },
  {
    id: 'STEP-FORM-rib_part', file: 'rib_part.step',
    what: 'base 60x40x5 + two ribs 50 x 3 x 15 (no blends: the control)',
    volume: 60 * 40 * 5 + 2 * 50 * 3 * 15,
  },
]

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  stepCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
})
afterEach(() => {
  act(() => { useFormStore.getState().closeSession() })
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}
function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

async function meshOf(featureId: string) {
  const h = hooks().getBodyHandle(featureId) as BodyHandle
  return hooks().client.tessellate(h, { deflection: 0.02, angularDeflection: 0.1 })
}
const vertices = (m: { position: ArrayLike<number> }): Vec3[] => {
  const out: Vec3[] = []
  for (let i = 0; i < m.position.length; i += 3) out.push([m.position[i], m.position[i + 1], m.position[i + 2]])
  return out
}
/** the worst distance from any vertex of `a` to the surface of `b` */
function worstFrom(a: Vec3[], b: { position: ArrayLike<number>; index: ArrayLike<number> }): number {
  const idx = closestPointIndex(b)
  return a.reduce((w, p) => Math.max(w, idx.closest(p).distance), 0)
}

interface Result { id: string; verdict: 'WORKS' | 'WRONG'; oracle: string; detail: Record<string, unknown> }
const results: Result[] = []
afterAll(() => {
  if (results.length !== CELLS.length || process.env.WO2822_WRITE_CELLS !== '1') return
  mkdirSync(OUT, { recursive: true })
  writeFileSync(resolve(OUT, 'cells.json'), `${JSON.stringify({ wo: 'WO-2822', route: 'SolidsWorkbenchPage: Import STEP -> Form -> From body -> Finish (no edit), real occt kernel', cells: results }, null, 2)}\n`)
})

describe('WO-2822 Form From body + Finish with no edit gives the imported body back (production Model screen)', () => {
  for (const cell of CELLS) {
    it(`${cell.id}: ${cell.what}`, async () => {
      const runtime = createFakeSceneRuntime()
      const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
      render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime, createPushPullTestDriver }))
      await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
      const path = cell.file.includes('/') ? cell.file : resolve(PARTS, cell.file)
      const name = path.split(/[\\/]/).pop()!
      fireEvent.change(screen.getByTestId('workbench-import-step-input'), { target: { files: [new File([bytesOf(path)], name, { type: 'application/octet-stream' })] } })
      await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
      await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })
      const imported = (await hooks().client.measure(hooks().getBodyHandle('IMP1')!, 'volume')).value
      // the fixture is the part the hand formula describes
      expect(Math.abs(imported - cell.volume)).toBeLessThan(0.05)
      const source = await meshOf('IMP1')

      fireEvent.click(screen.getByTestId('workbench-form'))
      await waitFor(() => expect(useFormStore.getState().active).toBe(true))
      fireEvent.click(screen.getByTestId('form-starter-body'))
      await waitFor(() => expect(useFormStore.getState().startedFrom).toBe('body'), { timeout: 120_000 })
      const cage = useFormStore.getState().cage
      fireEvent.click(screen.getByTestId('form-finish'))
      try {
        await waitFor(() => expect(hooks().getBodyHandle('FRM1')).not.toBeUndefined(), { timeout: 120_000 })
      } catch (e) {
        throw new Error(`Finish made no FRM1 body: features [${hooks().dag.featureOrder().join(',')}] FRM1 ${hooks().scheduler.statusOf('FRM1')} ${JSON.stringify(hooks().scheduler.diagnosticsOf('FRM1'))}`, { cause: e })
      }
      await waitFor(() => expect(hooks().scheduler.statusOf('FRM1')).toBe('ok'), { timeout: 120_000 })

      const volume = (await hooks().client.measure(hooks().getBodyHandle('FRM1')!, 'volume')).value
      const finished = await meshOf('FRM1')
      const formToBody = worstFrom(vertices(finished), source)
      const bodyToForm = worstFrom(vertices(source), finished)
      const section = cell.section?.measure(vertices(finished))
      const dv = volume - cell.volume
      const volumeTol = cell.volumeTol ?? 0.01
      const detail = {
        handVolume: +cell.volume.toFixed(3), volume: +volume.toFixed(3), volumeDelta: +dv.toFixed(3), volumeBudget: +(volumeTol * cell.volume).toFixed(1),
        formToBodyMm: +formToBody.toFixed(4), bodyToFormMm: +bodyToForm.toFixed(4), surfaceBudgetMm: 0.25,
        ...(section !== undefined ? { sectionWorstMm: +section.worst.toFixed(4), sectionPoints: section.points, sectionBudgetMm: cell.section!.budget } : {}),
        cagePoints: cage.positions.length,
      }
      const ok = Math.abs(dv) <= volumeTol * cell.volume && formToBody <= 0.25 && bodyToForm <= 0.25 && (section === undefined || (section.points > 0 && section.worst <= cell.section!.budget))
      const oracle = `hand volume ${cell.volume.toFixed(3)} mm^3 (${cell.what}); surface both ways within 0.25 mm${cell.section ? `; foot section within ${cell.section.budget} mm of the r3 arc` : ''}`
      results.push({ id: cell.id, verdict: ok ? 'WORKS' : 'WRONG', oracle, detail })
      console.log(`WO-2822 CELL ${cell.id} ${JSON.stringify(detail)}`)

      expect(Math.abs(dv), `volume ${volume} against the hand formula ${cell.volume}`).toBeLessThanOrEqual(volumeTol * cell.volume)
      expect(formToBody, 'finished body to the imported body, mm').toBeLessThanOrEqual(0.25)
      expect(bodyToForm, 'imported body to the finished body, mm').toBeLessThanOrEqual(0.25)
      if (section !== undefined) {
        expect(section.points).toBeGreaterThan(0)
        expect(section.worst, 'the foot section against the r3 arc, mm').toBeLessThanOrEqual(cell.section!.budget)
      }
    }, 600_000)
  }
})

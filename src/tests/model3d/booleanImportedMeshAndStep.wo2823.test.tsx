// @vitest-environment jsdom
// WO-2823: Boolean between an imported STL and a STEP body, and between two
// STLs, in both target directions, through the production Model screen on the
// real OCCT kernel and the original WO-2757 parts (the WO-2819 cells).
//
// The curved boss STL is opened the product's way (Edit as model - it stays a
// mesh), the second part comes in through the screen's own Import input, and
// every Boolean is picked in the dialog and applied with its Apply button.
//
// Hand oracle, independent of anything the kernel measures: every part here is
// a plate with things standing on it or cut down into it, so each one is a
// column [0, top(x, y)] over the XY plane - top() written straight from
// generate_parts.py's dimensions. Intersection = the integral of the lower top
// of the two; union = A + B - I; subtract = A - I. The STL twins are
// tessellated at 0.02 mm, so a result may differ from the exact shape by no
// more than its operands' own STL-vs-exact volume differences (plus 1 mm3).
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import type { BodyHandle } from '../../geom/geom-service'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

const { stepCache, stlCache } = vi.hoisted(() => ({
  stepCache: new Map<string, ArrayBuffer>(),
  stlCache: new Map<string, ArrayBuffer>(),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepCache.set(id, bytes) },
  loadCachedStep: async (id) => stepCache.get(id) ?? null,
  removeCachedStep: async (id) => { stepCache.delete(id) },
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id, bytes) => { stlCache.set(id, bytes) },
  loadCachedSTL: async (id) => stlCache.get(id) ?? null,
  removeCachedSTL: async (id) => { stlCache.delete(id) },
}))

// jsdom's localStorage is broken under Vitest's node launch flags (the same
// shim directEditAuditWave3.wo2819.test.ts installs before the page loads).
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
const { resetDocumentHolder } = await import('../../doc/documentHolder')
const { useFormStore } = await import('../../form/formStore')
const { resolveEditedStlMesh } = await import('../../mesh/edit')

const PARTS = resolve(process.cwd(), 'src/tests/evidence/WO-2757')
const part = (name: string) => resolve(PARTS, name)
function bytesOf(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

// ---- the hand oracle: each part's top height over (x, y), mm ----
type Top = (x: number, y: number) => number
/** Plate 60x60x10; boss d20 x 12 at (30,30); r3 fillet at its foot. */
const bossTop: Top = (x, y) => {
  if (x < 0 || x > 60 || y < 0 || y > 60) return 0
  const r = Math.hypot(x - 30, y - 30)
  if (r <= 10) return 22
  // the fillet: a quarter circle r3 centred 13 mm out and 13 mm up
  if (r < 13) return 13 - Math.sqrt(9 - (r - 13) ** 2)
  return 10
}
/** Base 60x40x5; ribs 50x3x15 at x 5..55, y 8..11 and y 29..32. */
const ribTop: Top = (x, y) => {
  if (x < 0 || x > 60 || y < 0 || y > 40) return 0
  if (x >= 5 && x <= 55 && ((y >= 8 && y <= 11) || (y >= 29 && y <= 32))) return 20
  return 5
}
/** Plate 70x40x15; at y 20: x 15 d6.6 through + d11 x 6.5 counterbore;
 *  x 35 d6.6 through + 90 degree countersink to d13; x 55 d5 through. */
const steppedTop: Top = (x, y) => {
  if (x < 0 || x > 70 || y < 0 || y > 40) return 0
  const r1 = Math.hypot(x - 15, y - 20), r2 = Math.hypot(x - 35, y - 20), r3 = Math.hypot(x - 55, y - 20)
  if (r1 < 3.3 || r2 < 3.3 || r3 < 2.5) return 0
  if (r1 < 5.5) return 15 - 6.5
  // the countersink cone widens 1:1 from r3.3 at z 11.8 (15 - (13 - 6.6) / 2)
  if (r2 < 6.5) return 11.8 + (r2 - 3.3)
  return 15
}
/** Midpoint rule at 0.01 mm over 0..70 x 0..60 (the plates' edges fall on
 *  cell edges, so only curved boundaries carry any rule error). */
function integrate(f: Top): number {
  const h = 0.01
  let v = 0
  for (let x = h / 2; x < 70; x += h) for (let y = h / 2; y < 60; y += h) v += f(x, y)
  return v * h * h
}
const exact = new Map<string, number>()
const exactOf = (key: string, f: Top) => {
  let v = exact.get(key)
  if (v === undefined) { v = integrate(f); exact.set(key, v) }
  return v
}

let restoreCanvas2d: (() => void) | null = null
const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
let consoleLines: string[] = []
beforeEach(() => {
  resetDocumentHolder()
  useFormStore.getState().closeSession()
  memory.clear()
  stepCache.clear()
  stlCache.clear()
  restoreCanvas2d = stubCanvas2d()
  act(() => { useCamStore.getState().newProject() })
  consoleLines = []
  useCamStore.getState().addConsoleEvent = (event) => { consoleLines.push(event.message) }
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  useCamStore.getState().addConsoleEvent = realAddConsoleEvent
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

async function volumeOf(featureId: string): Promise<number> {
  const h = hooks().getBodyHandle(featureId)
  if (h === undefined) throw new Error(`no body for ${featureId}`)
  return (await hooks().client.measure(h, 'volume')).value
}

function meshVolume(positions: Float32Array, indices: Uint32Array): number {
  let v = 0
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3]
    v += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])
  }
  return v / 6
}

interface Session { runtime: FakeSceneRuntime; meshId: string; stlVolume: number }

/** Open the curved boss STL the product's way - the store's Edit as model
 *  keeps it a mesh body in the Model screen - on the real kernel. */
async function openBossStl(): Promise<Session> {
  const id = 'boss_fillet_base-stl'
  const bytes = bytesOf(part('boss_fillet_base.stl'))
  stlCache.set(id, bytes)
  act(() => {
    useCamStore.setState((st) => ({
      project: {
        ...st.project,
        geometry: [{
          id, name: 'boss_fillet_base.stl', filename: 'boss_fillet_base.stl', type: 'mesh', format: 'stl',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 60, z: 22 }, size: { x: 60, y: 60, z: 22 }, center: { x: 30, y: 30, z: 11 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        }],
      },
    }))
  })
  await act(async () => { expect((await useCamStore.getState().wrapImportedGeometryAsModelItem(id)).ok).toBe(true) })
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(createElement(SolidsWorkbenchPage, { modelItemId: useCamStore.getState().activeModelItemId ?? undefined, createClient: createLocalGeomService, createSceneRuntime: () => runtime }))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  const meshId = `stl-body:${id}`
  await waitFor(() => expect(screen.getByTestId(`body-row-${meshId}`)).toBeTruthy(), { timeout: 30_000 })
  const r = resolveEditedStlMesh(bytes, undefined)
  return { runtime, meshId, stlVolume: meshVolume(r.mesh.positions, r.mesh.indices) }
}

/** The second part, through the Model screen's own Import input. */
async function importSecond(name: string): Promise<number> {
  fireEvent.change(screen.getByTestId('workbench-import-step-input'), { target: { files: [new File([bytesOf(part(name))], name)] } })
  try {
    await waitFor(() => expect(hooks().getBodyHandle('IMP1')).toBeDefined(), { timeout: 60_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 60_000 })
  } catch (e) {
    throw new Error(`import of ${name} did not land IMP1: ${consoleLines.join(' | ')}`, { cause: e })
  }
  return volumeOf('IMP1')
}

/** Aim the viewport ray down the outward normal of the largest triangle of
 *  a live body, from just outside it. */
async function aimAtBody(runtime: FakeSceneRuntime, featureId: string): Promise<void> {
  const mesh = await hooks().client.tessellate(hooks().getBodyHandle(featureId) as BodyHandle, { deflection: 0.05 })
  let best = -1, bestArea = 0
  let aim = { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } }
  for (let t = 0; t < mesh.index.length / 3; t++) {
    const p = (k: number) => {
      const i = mesh.index[t * 3 + k] * 3
      return { x: mesh.position[i], y: mesh.position[i + 1], z: mesh.position[i + 2] }
    }
    const [a, b, c] = [p(0), p(1), p(2)]
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }
    const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x }
    const area = Math.hypot(n.x, n.y, n.z) / 2
    if (area <= bestArea) continue
    best = t
    bestArea = area
    const l = area * 2
    aim = { point: { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 }, normal: { x: n.x / l, y: n.y / l, z: n.z / l } }
  }
  expect(best).toBeGreaterThanOrEqual(0)
  const { point, normal } = aim
  runtime.rayOverride = {
    origin: { x: point.x + normal.x * 100, y: point.y + normal.y * 100, z: point.z + normal.z * 100 },
    direction: { x: -normal.x, y: -normal.y, z: -normal.z },
  }
}

const OPS = ['fuse', 'cut', 'intersect'] as const
const PAIRS = [
  // WO-2819 cell STL+STEP-BOOLEAN: boss STL with the rib STEP
  { cell: 'STL+STEP-BOOLEAN', second: 'rib_part.step', secondLabel: 'rib_part', secondTop: ribTop, secondFacetError: 0 },
  // WO-2819 cell STL+STL-BOOLEAN: boss STL with the stepped-holes STL
  { cell: 'STL+STL-BOOLEAN', second: 'stepped_holes.stl', secondLabel: 'stepped_holes', secondTop: steppedTop, secondFacetError: null },
] as const

interface CellResult {
  verdict: 'WORKS' | 'WRONG'
  target: string
  tool: string
  op: string
  measured: number
  expected: number
  tolerance: number
  oracle: string
  rePicked: boolean
  undoRestoresStl: boolean
}
const cells: Record<string, CellResult> = {}
afterAll(() => {
  if (Object.keys(cells).length === 0) return
  // The WO-2819 cell each pair answers: WORKS only when all six of its
  // directions and operations measured WORKS.
  const wo2819 = Object.fromEntries(PAIRS.map((pair) => {
    const mine = Object.entries(cells).filter(([key]) => key.startsWith(`${pair.cell}-`))
    return [pair.cell, { verdict: mine.length === 6 && mine.every(([, c]) => c.verdict === 'WORKS') ? 'WORKS' : 'WRONG', cells: mine.map(([key]) => key) }]
  }))
  writeFileSync(resolve(process.cwd(), 'src/tests/evidence/WO-2823/cells.json'), JSON.stringify({
    route: 'SolidsWorkbenchPage (Edit as model STL + Model-screen Import) on real createLocalGeomService; WO-2757 fixtures',
    oracle: 'each part a column [0, top(x, y)] from generate_parts.py; I = integral of min(topA, topB) at 0.01 mm; fuse A + B - I, cut A - I, intersect I; tolerance = the STL operands\' own |faceted - exact| volume + 1 mm3',
    wo2819,
    exactVolumes: Object.fromEntries(exact),
    cells,
  }, null, 2) + '\n')
})

for (const pair of PAIRS) {
  for (const stlIs of ['target', 'tool'] as const) {
    for (const op of OPS) {
      const name = `${pair.cell} ${op}: STL is the ${stlIs}`
      it(name, async () => {
        const s = await openBossStl()
        const secondVolume = await importSecond(pair.second)

        fireEvent.click(screen.getByTestId('workbench-boolean'))
        const target = screen.getByTestId('boolean-target-select') as HTMLSelectElement
        // Every body the operator can see is offered as the target.
        expect([...target.options].map((o) => o.value)).toEqual([s.meshId, 'IMP1'])
        if (stlIs === 'target') {
          fireEvent.change(target, { target: { value: s.meshId } })
          const tool = screen.getByTestId('boolean-tool-shape-select') as HTMLSelectElement
          // ...and the STL target's tool list holds the second body.
          expect([...tool.options].map((o) => o.value)).toEqual(['box', 'cylinder', 'IMP1'])
          fireEvent.change(tool, { target: { value: 'IMP1' } })
        } else {
          fireEvent.change(target, { target: { value: 'IMP1' } })
          const tool = screen.getByTestId('boolean-tool-select') as HTMLSelectElement
          // ...and the modelled target's tool list holds the STL.
          expect([...tool.options].map((o) => o.value)).toEqual(['IMP1', s.meshId])
          fireEvent.change(tool, { target: { value: s.meshId } })
        }
        fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: op } })
        const apply = screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
        expect(apply.disabled, screen.queryByTestId('boolean-selection-error')?.textContent ?? '').toBe(false)
        const before = hooks().dag.featureOrder()
        fireEvent.click(apply)

        let resultId = ''
        await waitFor(() => {
          const added = hooks().dag.featureOrder().filter((id) => !before.includes(id))
          resultId = added.find((id) => hooks().dag.getNode(id)?.payload.opType === 'boolean') ?? ''
          expect(resultId, `${screen.queryByTestId('boolean-apply-error')?.textContent ?? ''} ${consoleLines.join(' | ')}`).not.toBe('')
          expect(['ok', 'failed', 'degraded']).toContain(hooks().scheduler.statusOf(resultId))
        }, { timeout: 120_000 })
        const why = (id: string) => `${id} ${hooks().scheduler.statusOf(id)} ${JSON.stringify(hooks().scheduler.diagnosticsOf(id))}`
        const inputs = hooks().dag.getNode(resultId)?.consumes ?? []
        expect(hooks().scheduler.statusOf(resultId), [resultId, ...inputs].map(why).join(' | ')).toBe('ok')
        await waitFor(() => expect(hooks().getBodyHandle(resultId)).toBeDefined(), { timeout: 30_000 })
        const measured = await volumeOf(resultId)

        // The oracle, from the parts' dimensions alone.
        const bossExact = exactOf('boss_fillet_base', bossTop)
        const secondExact = exactOf(pair.secondLabel, pair.secondTop)
        const overlap = exactOf(`boss_fillet_base^${pair.secondLabel}`, (x, y) => Math.min(bossTop(x, y), pair.secondTop(x, y)))
        const [a, b] = stlIs === 'target' ? [bossExact, secondExact] : [secondExact, bossExact]
        const expected = op === 'fuse' ? a + b - overlap : op === 'cut' ? a - overlap : overlap
        const facetError = Math.abs(s.stlVolume - bossExact) +
          (pair.secondFacetError ?? Math.abs(secondVolume - secondExact))
        const tolerance = facetError + 1
        const oracle = op === 'fuse' ? 'A + B - I' : op === 'cut' ? 'A - I' : 'I'

        // The result is a body later edits pick: the Boolean's own viewport
        // pick takes it as the next target, and the STL's mesh no longer
        // stands in front of it.
        fireEvent.click(screen.getByTestId('workbench-boolean'))
        await aimAtBody(s.runtime, resultId)
        fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
        fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
        await waitFor(() => expect((screen.getByTestId('boolean-target-select') as HTMLSelectElement).value).toBe(resultId), { timeout: 10_000 })
        const rePicked = true
        // The STL went in as the Boolean's input: it is no longer a body of
        // its own, as a consumed tool is not...
        expect(screen.queryByTestId(`body-row-${s.meshId}`)).toBeNull()
        expect([...(screen.getByTestId('boolean-target-select') as HTMLSelectElement).options].map((o) => o.value)).not.toContain(s.meshId)
        // ...and one Undo takes the Boolean and its copy of the STL back out
        // and gives the STL back.
        fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
        fireEvent.click(screen.getAllByTestId('workbench-undo')[0])
        await waitFor(() => expect(hooks().dag.featureOrder()).toEqual(before), { timeout: 30_000 })
        await waitFor(() => expect(screen.getByTestId(`body-row-${s.meshId}`)).toBeTruthy(), { timeout: 30_000 })
        const undoRestoresStl = true

        const verdict = Math.abs(measured - expected) <= tolerance ? 'WORKS' : 'WRONG'
        cells[`${pair.cell}-${stlIs === 'target' ? 'STL-target' : 'STL-tool'}-${op}`] = {
          verdict,
          target: stlIs === 'target' ? 'boss_fillet_base.stl' : pair.second,
          tool: stlIs === 'target' ? pair.second : 'boss_fillet_base.stl',
          op,
          measured: Number(measured.toFixed(3)),
          expected: Number(expected.toFixed(3)),
          tolerance: Number(tolerance.toFixed(3)),
          oracle,
          rePicked,
          undoRestoresStl,
        }
        expect(measured, `${name}: ${oracle}`).toBeGreaterThan(expected - tolerance)
        expect(measured, `${name}: ${oracle}`).toBeLessThan(expected + tolerance)
      }, 240_000)
    }
  }
}

// Fix round 1 (audit A1): turning the pair round and back in ONE open dialog
// keeps Apply on for every pair of different bodies, and a real same-body
// pick turns it off with its own sentence. The STL target's tool is its body
// pick, never the hidden tool list the other direction left behind.
it('STL+STEP-BOOLEAN: switching target and tool both ways in one dialog keeps a valid pair applicable', async () => {
  const s = await openBossStl()
  await importSecond('rib_part.step')

  fireEvent.click(screen.getByTestId('workbench-boolean'))
  const apply = () => screen.getByTestId('dialog-shell-apply') as HTMLButtonElement
  const why = () => [screen.queryByTestId('boolean-selection-error'), screen.queryByTestId('boolean-same-body-error')]
    .map((el) => el?.textContent ?? '').join(' ')
  const setTarget = (id: string) => fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: id } })
  const setStlTargetTool = (id: string) => fireEvent.change(screen.getByTestId('boolean-tool-shape-select'), { target: { value: id } })
  const setTool = (id: string) => fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: id } })
  const expectApplicable = (step: string) => {
    expect(apply().disabled, `${step}: ${why()}`).toBe(false)
    expect(screen.queryByTestId('boolean-same-body-error'), step).toBeNull()
  }
  fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: 'fuse' } })

  // STL target, rib tool
  setTarget(s.meshId)
  setStlTargetTool('IMP1')
  expectApplicable('STL -> IMP1')
  // turned round: rib target, STL tool
  setTarget('IMP1')
  setTool(s.meshId)
  expectApplicable('IMP1 -> STL')
  // and back: the same pair as the first, Apply on again
  setTarget(s.meshId)
  setStlTargetTool('IMP1')
  expect((screen.getByTestId('boolean-tool-shape-select') as HTMLSelectElement).value).toBe('IMP1')
  expectApplicable('STL -> IMP1 again')

  // a real same-body pick: Apply off, and the dialog says why
  setTarget('IMP1')
  setTool('IMP1')
  expect(apply().disabled).toBe(true)
  expect(screen.getByTestId('boolean-same-body-error').textContent).toMatch(/different bodies/i)
  // a different tool clears it
  setTool(s.meshId)
  expectApplicable('IMP1 -> STL again')

  // Apply on the last turn-round lands the pair the dialog shows: the STL
  // (as its import node) is the target, the rib the tool.
  setTarget(s.meshId)
  setStlTargetTool('IMP1')
  expectApplicable('STL -> IMP1 before Apply')
  const before = hooks().dag.featureOrder()
  fireEvent.click(apply())
  let resultId = ''
  await waitFor(() => {
    resultId = hooks().dag.featureOrder().filter((id) => !before.includes(id))
      .find((id) => hooks().dag.getNode(id)?.payload.opType === 'boolean') ?? ''
    expect(resultId, `${screen.queryByTestId('boolean-apply-error')?.textContent ?? ''} ${consoleLines.join(' | ')}`).not.toBe('')
  }, { timeout: 120_000 })
  const payload = hooks().dag.getNode(resultId)?.payload ?? {}
  const targetNode = hooks().dag.getNode(String(payload.targetFeatureId))
  expect(targetNode?.kind).toBe('import')
  expect(targetNode?.payload.stlGeoId).toBe('boss_fillet_base-stl')
  expect(payload.toolFeatureId).toBe('IMP1')
  expect(payload.boolOp).toBe('fuse')
}, 240_000)

// Fix round 2 (audit A2): the STL is put away only while the import made from
// it is ACTIVE. Rolling the marker back before that import (and its Boolean)
// gives the original STL back to Bodies, the Boolean target list and Export;
// rolling forward again puts it away and the Boolean result is intact; Undo
// still walks back to the STL as before. One mounted session throughout.
it('STL+STEP-BOOLEAN: rolling back before the STL\'s import gives the STL back; rolling forward puts it away again', async () => {
  const s = await openBossStl()
  await importSecond('rib_part.step')
  const exported = () => (hooks().getExportBodies?.() ?? []).map((b) => b.id)
  const targets = () => {
    fireEvent.click(screen.getByTestId('workbench-boolean'))
    const ids = [...(screen.getByTestId('boolean-target-select') as HTMLSelectElement).options].map((o) => o.value)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    return ids
  }
  expect(exported()).toContain(s.meshId)

  // STL target, rib tool, fuse
  fireEvent.click(screen.getByTestId('workbench-boolean'))
  fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: s.meshId } })
  fireEvent.change(screen.getByTestId('boolean-tool-shape-select'), { target: { value: 'IMP1' } })
  fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: 'fuse' } })
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  let resultId = ''
  await waitFor(() => {
    resultId = hooks().dag.featureOrder().filter((id) => !before.includes(id))
      .find((id) => hooks().dag.getNode(id)?.payload.opType === 'boolean') ?? ''
    expect(resultId, `${screen.queryByTestId('boolean-apply-error')?.textContent ?? ''} ${consoleLines.join(' | ')}`).not.toBe('')
    expect(hooks().scheduler.statusOf(resultId)).toBe('ok')
    expect(hooks().getBodyHandle(resultId)).toBeDefined()
  }, { timeout: 120_000 })
  const stlImportId = String(hooks().dag.getNode(resultId)?.payload.targetFeatureId)
  expect(hooks().dag.getNode(stlImportId)?.payload.stlGeoId).toBe('boss_fillet_base-stl')
  const fusedVolume = await volumeOf(resultId)
  // converted: the STL is put away
  await waitFor(() => expect(screen.queryByTestId(`body-row-${s.meshId}`)).toBeNull(), { timeout: 30_000 })
  expect(exported()).not.toContain(s.meshId)
  expect(targets()).not.toContain(s.meshId)

  // marker up until it sits just after IMP1: the STL's import and the Boolean roll back
  // (one click per render: each click's slot is the one the tree last drew)
  const moveMarker = async (button: 'rollback-marker-up' | 'rollback-marker-down', settled: () => void) => {
    fireEvent.click(screen.getByTestId(button))
    await act(async () => {})
    await waitFor(settled, { timeout: 30_000 })
  }
  await moveMarker('rollback-marker-up', () => expect(hooks().dag.isRolledBack(resultId)).toBe(true))
  await moveMarker('rollback-marker-up', () => expect(hooks().dag.isRolledBack(stlImportId)).toBe(true))
  expect(hooks().dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'IMP1' })
  expect(hooks().dag.rolledBackIds()).toEqual([stlImportId, resultId])
  // ...and the original STL is a usable body again: Bodies, Boolean target, Export
  await waitFor(() => expect(screen.getByTestId(`body-row-${s.meshId}`)).toBeTruthy(), { timeout: 30_000 })
  expect(exported()).toContain(s.meshId)
  expect(targets()).toEqual([s.meshId, 'IMP1'])

  // marker back to the end: the STL is put away again and the Boolean result is intact
  await moveMarker('rollback-marker-down', () => expect(hooks().dag.isRolledBack(stlImportId)).toBe(false))
  await moveMarker('rollback-marker-down', () => expect(hooks().dag.isRolledBack(resultId)).toBe(false))
  expect(hooks().dag.getRollbackMarker()).toEqual({ kind: 'end' })
  await waitFor(() => expect(screen.queryByTestId(`body-row-${s.meshId}`)).toBeNull(), { timeout: 30_000 })
  expect(exported()).not.toContain(s.meshId)
  expect(targets()).not.toContain(s.meshId)
  await waitFor(() => {
    expect(hooks().scheduler.statusOf(resultId)).toBe('ok')
    expect(hooks().getBodyHandle(resultId)).toBeDefined()
  }, { timeout: 120_000 })
  expect(Math.abs(await volumeOf(resultId) - fusedVolume)).toBeLessThan(1e-6 * fusedVolume)

  // Undo still walks back to the STL: the marker moves first, then the Boolean
  // and its copy of the STL in one step.
  for (let i = 0; i < 12 && hooks().dag.featureOrder().length > before.length; i++) {
    const undo = screen.getAllByTestId('workbench-undo')[0] as HTMLButtonElement
    if (undo.disabled) break
    fireEvent.click(undo)
    await act(async () => {})
  }
  await waitFor(() => expect(hooks().dag.featureOrder()).toEqual(before), { timeout: 30_000 })
  expect(hooks().dag.getRollbackMarker()).toEqual({ kind: 'end' })
  await waitFor(() => expect(screen.getByTestId(`body-row-${s.meshId}`)).toBeTruthy(), { timeout: 30_000 })
  expect(exported()).toContain(s.meshId)
}, 240_000)

// Landing round (merge with WO-2820): the open STL is put away while it is
// Form's From-body source AND while a Boolean has taken it in. Each brings it
// back on its own: Cancel ends the Form session, Undo takes the Boolean out.
it('STL+STEP-BOOLEAN: the STL hides while it is the Form source and while a Boolean has it (WO-2820 merge)', async () => {
  const s = await openBossStl()
  const stlMesh = () => {
    const root = s.runtime.scene.getObjectByName('stl-model-body:boss_fillet_base-stl')
    const mesh = root?.children.find((c) => c.userData.isBodyPresentationMesh === true)
    if (mesh === undefined) throw new Error('no STL presentation mesh in the scene')
    return mesh
  }
  expect(stlMesh().visible).toBe(true)

  // Form - From body takes the open STL; while it is the source it is not drawn
  fireEvent.click(screen.getByTestId('workbench-form'))
  await waitFor(() => expect(useFormStore.getState().active).toBe(true))
  fireEvent.click(screen.getByTestId('form-starter-body'))
  await waitFor(() => expect(useFormStore.getState().sourceBodyId).toBe(s.meshId), { timeout: 120_000 })
  await waitFor(() => expect(stlMesh().visible).toBe(false))
  // still an STL body of its own: a Form source is hidden, not consumed
  expect(screen.getByTestId(`body-row-${s.meshId}`)).toBeTruthy()
  fireEvent.click(screen.getByTestId('form-cancel'))
  await waitFor(() => expect(useFormStore.getState().active).toBe(false))
  await waitFor(() => expect(stlMesh().visible).toBe(true))

  // a Boolean takes it in: hidden again, and its row goes
  await importSecond('rib_part.step')
  fireEvent.click(screen.getByTestId('workbench-boolean'))
  fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: s.meshId } })
  fireEvent.change(screen.getByTestId('boolean-tool-shape-select'), { target: { value: 'IMP1' } })
  fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: 'fuse' } })
  const before = hooks().dag.featureOrder()
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => {
    const resultId = hooks().dag.featureOrder().filter((id) => !before.includes(id))
      .find((id) => hooks().dag.getNode(id)?.payload.opType === 'boolean') ?? ''
    expect(resultId, consoleLines.join(' | ')).not.toBe('')
    expect(hooks().scheduler.statusOf(resultId)).toBe('ok')
  }, { timeout: 120_000 })
  await waitFor(() => expect(stlMesh().visible).toBe(false), { timeout: 30_000 })
  expect(screen.queryByTestId(`body-row-${s.meshId}`)).toBeNull()

  // one Undo: the STL is back and drawn
  fireEvent.click(screen.getAllByTestId('workbench-undo')[0])
  await waitFor(() => expect(hooks().dag.featureOrder()).toEqual(before), { timeout: 30_000 })
  await waitFor(() => expect(stlMesh().visible).toBe(true), { timeout: 30_000 })
  expect(screen.getByTestId(`body-row-${s.meshId}`)).toBeTruthy()
}, 240_000)

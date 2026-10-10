// @vitest-environment jsdom
// WO-2713 (D8): on a simple drawn part the Adaptive makes a real sideways cut.
//
// The operator 2026-10-09 (card "Cloud journey: 3 findings", item 3): "on a
// simple drawn part the Adaptive only dips down and up, no sideways cut."
//
// The part is the 10-09 newcomer journey's scratch part (WO-2694's fixture): a
// 100 x 60 x 15 sketch -> extrude block with a D20 through hole and a D6 hole,
// Auto Stock 1 with a 1 mm Z top allowance. Its Adaptive was created with no
// loops picked ("All loops (auto)") on the body, bottom WCS -5.
//
//   loadProjectFromFile -> store.computeOperationToolpath (Face, then Adaptive)
//   -> REAL toolpathWorker (in-process stub of the Worker thread only)
//   -> postProject(UCCNC)
//
// Before the fix the empty loop list resolved to the body's outer profile, so
// the Adaptive pocketed the part's own top 4 mm deep and the tool-reach trim
// kept only six re-entry dips (G1 Z-1.077 / G0 Z15) - no sideways cut.
import { act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { ToolpathMove } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) }, setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { useCamStore } = await import('../../store')
const { UCCNC_CONFIG } = await import('../../lib/post')
const { postProject } = await import('../../lib/post/postProject')
const { ensureClipperReady } = await import('../../lib/cam/face2d/clipperOffset')
const { smartHeightStockBounds, setupProvenStockId } = await import('../../store')

// The Face's stock footprint is read through the viewport's stock box in the
// app; here the same first-class stock evidence stands in (WO-2051's shim).
;(window as unknown as Record<string, unknown>).__cncViewport = {
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    return smartHeightStockBounds(project, stockId ?? setupProvenStockId(project.setups[0], project)!)
  },
}

type WorkerSelf = {
  postMessage: (msg: WorkerResponseMsg) => void
  onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null
  location: Location
}
let deliver: ((msg: WorkerResponseMsg) => void) | null = null
const workerSelf: WorkerSelf = {
  postMessage: (msg) => { deliver?.(msg) }, onmessage: null, location: window.location,
}
class InProcessToolpathWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { /* the real module is already loaded */ }
  postMessage(request: WorkerRequestMsg): void {
    deliver = (msg) => this.onmessage?.({ data: msg })
    void workerSelf.onmessage!({ data: request })
  }
  terminate(): void { /* no thread to stop */ }
}

const FIXTURE = join(process.cwd(), 'src/tests/evidence/WO-2694/journey-1009-scratch.camproject')
const FACE_ID = 'b1da9442-70d3-44d9-b3c0-b162b9ea69dd'
const ADAPTIVE_ID = '21e5509b-da6b-4ed3-91ce-abe93b28dbff'
const PART_TOP_WCS = -1
const NL = String.fromCharCode(10)

const setup = () => useCamStore.getState().project.setups[0]
const operation = (opId: string) => setup().operations.find(candidate => candidate.id === opId)!

async function compute(opId: string): Promise<void> {
  await act(async () => { await useCamStore.getState().computeOperationToolpath(setup().id, opId) })
  expect(operation(opId).status, operation(opId).errorMessage).toBe('ready')
}

/** The operation's own posted lines (real post, UCCNC). */
function postedLines(opId: string): string[] {
  const project = useCamStore.getState().project
  const posted = postProject(project, [project.setups[0]], UCCNC_CONFIG, {
    mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2713', ext: 'nc',
    selectedOpIds: { [project.setups[0].id]: [opId] },
  })
  expect(posted.diagnostics.filter(d => d.level === 'error')).toEqual([])
  const result = posted.files![0].result
  const span = result.operationSpans!.find(s => s.opId === opId)!
  return result.gcode.split(NL).slice(span.startLine - 1, span.endLine)
}

/** Posted feed motion: XY length cut below the part top, and the deepest feed Z (WCS). */
function feedStats(lines: readonly string[]): { sidewaysBelowTopMm: number; deepestZ: number } {
  let modal = ''
  let x = NaN, y = NaN, z = NaN
  let sideways = 0
  let deepest = Infinity
  for (const raw of lines) {
    const line = raw.replace(/\(.*?\)/g, '').trim()
    const g = /\bG0?([0-3])\b/.exec(line)
    if (g) modal = g[1]
    const nx = /\bX(-?[\d.]+)/.exec(line), ny = /\bY(-?[\d.]+)/.exec(line), nz = /\bZ(-?[\d.]+)/.exec(line)
    const px = x, py = y
    if (nx) x = Number(nx[1])
    if (ny) y = Number(ny[1])
    if (nz) z = Number(nz[1])
    if (modal === '0' || modal === '') continue
    if (nz) deepest = Math.min(deepest, z)
    if (z < PART_TOP_WCS - 0.5 && Number.isFinite(px) && Number.isFinite(py)) sideways += Math.hypot(x - px, y - py)
  }
  return { sidewaysBelowTopMm: sideways, deepestZ: deepest }
}

const ORIGINAL_WORKER = globalThis.Worker
const ORIGINAL_SELF = globalThis.self
const results: Record<string, unknown> = {}

beforeAll(async () => {
  ;(globalThis as { Worker: unknown }).Worker = InProcessToolpathWorker
  ;(globalThis as { self: unknown }).self = workerSelf
  await import('../../lib/cam/toolpathWorker')
  await ensureClipperReady()
}, 120_000)
afterAll(() => {
  ;(globalThis as { Worker: unknown }).Worker = ORIGINAL_WORKER
  ;(globalThis as { self: unknown }).self = ORIGINAL_SELF
  console.info('[WO-2713] results', JSON.stringify(results))
})

/** Open the journey project (optionally edited first), compute its Face then its
 *  Adaptive through the store, and measure the Adaptive's own posted lines. */
async function adaptiveOf(edit?: (file: Record<string, any>) => void) {
  const file = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  edit?.(file)
  await act(async () => {
    await useCamStore.getState().loadProjectFromFile(JSON.stringify(file))
  })
  act(() => useCamStore.getState().closeModal())
  expect((operation(ADAPTIVE_ID).params as { loopIds: string[] }).loopIds).toEqual([])
  await compute(FACE_ID)
  await compute(ADAPTIVE_ID)
  const adaptive = operation(ADAPTIVE_ID)
  const moves = (adaptive.toolpathMoves ?? []) as ToolpathMove[]
  return {
    moves: moves.length,
    reachShortfall: adaptive.reachShortfall,
    ...feedStats(postedLines(ADAPTIVE_ID)),
  }
}

describe('WO-2713: the Adaptive on a simple drawn part cuts sideways', () => {
  it('an Adaptive with no loops picked clears the part holes, not plunge-and-lift dips', async () => {
    const adaptive = await adaptiveOf()
    results.adaptive = { ...adaptive, reachShortfall: adaptive.reachShortfall ?? null }
    // A real adaptive: sideways feed at depth, all the way to the asked bottom.
    expect(adaptive.sidewaysBelowTopMm).toBeGreaterThan(200)
    expect(adaptive.deepestZ).toBeCloseTo(-5, 3)
    // Nothing of it had to be trimmed off the part (D7's "Stopped short").
    expect(adaptive.reachShortfall).toBeUndefined()
  }, 300_000)

  it('with no holes detected on the body yet (no Drill made), it clears the through hole', async () => {
    // The same part before any operation detected its holes: the body carries
    // no loops of its own, only its live profile (outline + D20 through hole).
    const adaptive = await adaptiveOf((file) => {
      for (const geometry of file.geometry) {
        geometry.loops = []
        geometry.layers2d = []
      }
    })
    results.noDetectedHoles = { ...adaptive, reachShortfall: adaptive.reachShortfall ?? null }
    expect(adaptive.sidewaysBelowTopMm).toBeGreaterThan(200)
    expect(adaptive.deepestZ).toBeCloseTo(-5, 3)
    expect(adaptive.reachShortfall).toBeUndefined()
  }, 300_000)
})

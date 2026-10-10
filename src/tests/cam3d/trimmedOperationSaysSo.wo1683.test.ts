// @vitest-environment jsdom
//
// WO-1683: WO-1678 trims the moves of a reach-limited operation and says so on
// the console, one line per stop, and the bare numbers name no frame. Operator,
// 2026-09-18 on the WO-1678 card: "it should not fail silently... the
// operation should indicate if it did not finish the operation to full
// depth." This proves the three outcomes through the store's real generate
// action, exactly as WO-1678's own suite does (same cavity, block, tool and
// mocks - a 3D finish so the real store path runs with no DOM Worker: node's
// `new URL(..., import.meta.url)` resolution for the 2D worker thread does not
// survive jsdom, which WO-1678's own suite avoids the same way by running in
// vitest's default node environment instead; this file needs jsdom for the
// real tree row render, so it takes the 3D finish path WO-1678 already proves
// carries the identical trim):
//
//   1. The trimmed operation carries the fact on itself (reached Z, asked Z,
//      uncut mm) and its tree row marks it - never a refusal, status stays
//      'ready'.
//   2. The console says it as ONE summary line per operation per generate,
//      its position framed ("G54 X.. Y.. Z..") through the one formatter
//      (positionFrames.ts), not one line per stop.
//   3. A tool that reaches carries no fact and marks nothing; the console
//      stays quiet.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { evidenceOutDir } from '../helpers/evidenceScratch'
import { join } from 'node:path'
import { createElement } from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { pocketBox } from '../../cam3d/fixtures'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { PartMesh } from '../../cam3d/kernel/types'
import type {
  BoundingBox, ImportedGeometry, LinkingParams, Operation, PhysicalStock, Project, SceneStock, Setup,
  Tool, ToolHolder, Vec3, WCS,
} from '../../types'

// jsdom's built-in localStorage is broken under vitest's launch flags, and the
// store's persist() writes on every set(). Copied from
// DesignTreeNestZeroFitStatus.wo1406.test.tsx.
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

// Mocked exactly as toolReachSeam.wo1678.test.ts mocks them, so the 3D finish
// runs a real cam3d kernel in-process with no DOM Worker involved.
const cam3d = vi.hoisted(() => ({ client: undefined as unknown, partMesh: undefined as PartMesh | undefined }))

vi.mock('../../lib/stlCache', async (importOriginal) => typedMock<typeof import('../../lib/stlCache')>({
  ...await importOriginal<typeof import('../../lib/stlCache')>(),
  loadCachedSTL: vi.fn(async () => null),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...await importOriginal<typeof import('../../lib/stepCache')>(),
  loadCachedStep: vi.fn(async () => new ArrayBuffer(8)),
  loadCachedStepDisplay: vi.fn(async () => null),
}))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/appClient')>({
  ...await importOriginal<typeof import('../../cam3d/integration/appClient')>(),
  getCam3dClient: () => cam3d.client as Cam3dClient,
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
  ...await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>(),
  acquirePartMesh: vi.fn(async () => cam3d.partMesh!),
}))

const { useCamStore } = await import('../../store')
const { DesignTree } = await import('../../components/panels/DesignTree')

// ── The block, the cavity, the tool (same as WO-1678) ────────────────────────

const OUTER = { x: 40, y: 40, z: 30 }
const CAVITY = { x: 16, y: 16, depth: 25 }
const TOP_Z = OUTER.z
const FLOOR_Z = OUTER.z - CAVITY.depth
const SHORT_STICKOUT = 15
const LONG_STICKOUT = 40
/** The lowest tip the 20 mm holder allows over the cavity, from the tool and the block alone. */
const REACH_FLOOR_Z = TOP_Z - SHORT_STICKOUT + 0.25

const HOLDER: ToolHolder = { id: 'holder-1', name: 'ER20', segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }] }

function mill(stickout: number): Tool {
  return {
    id: 'tool-1', name: '6 mm ball end mill', type: 'ball_end_mill',
    diameter: 6, fluteLength: 40, shankDiameter: 6, overallLength: 80,
    lengthBelowHolder: stickout, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 5, stepover: 2 } },
  } as unknown as Tool
}

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const PART_ID = 'block'
const STOCK_ID = 'stock-block'
const OP_ID = 'op-finish'

function part(): ImportedGeometry {
  return {
    id: PART_ID, name: 'Block', filename: 'block.step', type: 'brep', format: 'step',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: OUTER.x, y: OUTER.y, z: OUTER.z }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId: STOCK_ID,
  } as unknown as ImportedGeometry
}

function finishOp(): Operation {
  const params = { stepover: 2, angleDeg: 0, tolerance: 0.1, surfaceStockToLeave: 0, useStockBoundary: false }
  return stampSmartHeightAuthority({
    id: OP_ID, name: 'Cavity finish', type: 'parallel_3d', enabled: true, status: 'pending', toolId: 'tool-1',
    geometrySelections: [PART_ID],
    heights: {
      clearanceHeight: 50, clearanceHeightMode: 'absolute', retractHeight: 40, feedHeight: 32,
      topHeight: 0, topHeightMode: 'model_top', bottomHeight: 0, bottomHeightMode: 'model_bottom',
    },
    passes: { stepdown: 3, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: LINKING,
    params,
  } as unknown as Operation, { setupId: 'setup-1', geometryIds: [PART_ID], stockId: STOCK_ID }) as Operation
}

function install(stickout: number): void {
  cam3d.partMesh = pocketBox(OUTER, CAVITY)
  const fixedStock = { id: STOCK_ID, name: 'Block stock', width: OUTER.x, height: OUTER.y, depth: OUTER.z, position: { x: 0, y: 0, z: 0 } }
  const stock = {
    id: STOCK_ID, name: 'Block stock', mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: OUTER.x, y: OUTER.y, z: OUTER.z }), position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId: STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [finishOp()], notes: '',
  } as unknown as Setup
  const tool = mill(stickout)
  useCamStore.getState().newProject()
  useCamStore.setState((s) => ({
    toolLibrary: [tool], holders: [HOLDER], toolpathBatch: null, consoleEvents: [],
    project: {
      ...s.project, geometry: [part()], stocks: [stock], setups: [setup],
      sceneStock: {
        mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: OUTER.x, fixedHeight: OUTER.y,
        fixedDepth: OUTER.z, fixedStocks: [fixedStock],
      } as unknown as SceneStock,
      toolLibrary: [tool], activeSetupId: 'setup-1', activeOperationId: OP_ID,
      modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    } as Project,
  }))
}

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest) },
    terminate(): void { /* in-process */ },
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent)
  }, {})
  return new Cam3dClient(fakeWorker)
}

let client: Cam3dClient

beforeEach(() => {
  client = makeClient()
  cam3d.client = client
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  await client.dispose()
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const opById = () => useCamStore.getState().project.setups[0].operations.find((op) => op.id === OP_ID)!
const linesFor = () => useCamStore.getState().consoleEvents
  .filter((e) => e.source === 'toolpath' && e.entityRef?.kind === 'op' && e.entityRef.id === OP_ID)
  .map((e) => e.message)

async function generate(): Promise<Operation> {
  await useCamStore.getState().computeOperationToolpath('setup-1', OP_ID)
  const op = opById()
  expect(op.status, op.errorMessage).toBe('ready')
  return op
}

// ── Pictures: the real tree row, trimmed and not ─────────────────────────────

const rowHtml: Record<string, string> = {}
function captureRow(label: string): void {
  const { container, unmount } = render(createElement(DesignTree))
  rowHtml[label] = container.innerHTML
  unmount()
}

describe('WO-1683: a trimmed operation says it did not reach full depth', () => {
  it('the 15 mm stickout tool: the operation carries the fact, marks its row, and the console says one framed line', { timeout: 30_000 }, async () => {
    install(SHORT_STICKOUT)
    const op = await generate()

    expect(op.reachShortfall).toBeDefined()
    expect(op.reachShortfall!.reachedZ).toBeGreaterThan(REACH_FLOOR_Z - 0.3)
    expect(op.reachShortfall!.reachedZ).toBeLessThan(REACH_FLOOR_Z + 1)
    expect(Math.abs(op.reachShortfall!.askedZ - FLOOR_Z)).toBeLessThan(1)
    expect(op.reachShortfall!.uncutMm).toBeGreaterThan(0)

    const lines = linesFor()
    const stopLines = lines.filter((l) => l.includes('cut stopped at'))
    // WO-1683: one summary line per operation per generate, not one per stop.
    expect(stopLines.length, lines.join('\n')).toBe(1)
    expect(stopLines[0]).toContain('G54')
    expect(stopLines[0]).toMatch(/[\d.]+ mm of cutting path was left uncut, .*; reached Z [\d.]+ of Z [\d.]+ asked/)

    render(createElement(DesignTree))
    const badge = document.querySelector('.tree-op-reach-shortfall')
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute('data-tooltip')).toContain('Stopped short')
    expect(badge!.getAttribute('data-tooltip')).toContain(`${op.reachShortfall!.uncutMm.toFixed(1)} mm`)
    captureRow('trimmed')
  })

  it('re-generating with a 40 mm stickout tool clears the fact and the row mark', { timeout: 30_000 }, async () => {
    install(LONG_STICKOUT)
    const op = await generate()

    expect(op.reachShortfall).toBeUndefined()
    expect(linesFor().filter((l) => l.includes('cut stopped at'))).toEqual([])

    render(createElement(DesignTree))
    expect(document.querySelector('.tree-op-reach-shortfall')).toBeNull()
    captureRow('not-trimmed')
  })

  it('trimmed, then regenerated with a tool that reaches: the fact and the row mark both clear', { timeout: 30_000 }, async () => {
    install(SHORT_STICKOUT)
    const trimmed = await generate()
    expect(trimmed.reachShortfall).toBeDefined()

    install(LONG_STICKOUT)
    const cleared = await generate()
    expect(cleared.reachShortfall).toBeUndefined()

    render(createElement(DesignTree))
    expect(document.querySelector('.tree-op-reach-shortfall')).toBeNull()
  })
})

// ── Evidence: a real headless-Chromium screenshot of the row, both states ────

afterAll(async () => {
  if (Object.keys(rowHtml).length === 0) return
  const dir = evidenceOutDir(join(process.cwd(), 'src', 'tests', 'evidence', 'WO-1683'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'summary.txt'), [
    `WO-1683 - cavity ${CAVITY.x} x ${CAVITY.y} x ${CAVITY.depth} deep in a ${OUTER.x} x ${OUTER.y} x ${OUTER.z} block.`,
    `Tool 6 mm ball, flutes 40 mm; short stickout ${SHORT_STICKOUT} mm below a 20 mm holder reaches to Z ` +
      `${REACH_FLOOR_Z.toFixed(2)}; long stickout ${LONG_STICKOUT} mm reaches the floor Z ${FLOOR_Z}.`,
    'See tree-row-trimmed.png and tree-row-not-trimmed.png for the operation row in each state.',
  ].join('\n') + '\n')
  let css = ''
  try {
    css = [
      readFileSync(join(process.cwd(), 'src', 'theme', 'tokens.css'), 'utf8'),
      readFileSync(join(process.cwd(), 'src', 'styles', 'app.css'), 'utf8'),
    ].join('\n')
  } catch (err) {
    console.warn('[WO-1683 evidence] could not read app CSS for the row screenshot:', err)
    return
  }
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    try {
      for (const [label, html] of Object.entries(rowHtml)) {
        const page = await browser.newPage({ viewport: { width: 420, height: 900 } })
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head>` +
          `<body style="background:var(--bg-secondary,#1a1a1a);margin:0;">${html}</body></html>`,
        )
        const row = page.locator('[data-testid="tree-name-op"]').first()
        await row.scrollIntoViewIfNeeded().catch(() => {})
        await page.screenshot({ path: join(dir, `tree-row-${label}.png`) })
        await page.close()
      }
    } finally {
      await browser.close()
    }
  } catch (err) {
    // Evidence-only: a missing Playwright browser install must not fail the
    // behavioural tests above, which already proved the fact and the DOM mark.
    console.warn('[WO-1683 evidence] Playwright screenshot skipped:', err)
  }
}, 30_000)

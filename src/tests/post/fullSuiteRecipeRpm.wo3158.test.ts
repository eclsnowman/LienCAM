/**
 * WO-3158: the shipped Full Suite chamfer recipe uses the owner's selected 24,000 RPM.
 *
 * This is the production load boundary (JSON import + migrateProjectData), the
 * normal post route (postProject), and the Control > Load staging boundary. The
 * five chamfer operations deliberately cover both resolution paths:
 * disabled overrides use the tool default, while enabled overrides use their
 * operation value. The saved toolpath fingerprints intentionally make the
 * loaded operations stale; staging must recompute them before post reads them.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { buildPostInput, GRBL_CONFIG, postProject, UCCNC_CONFIG } from '../../lib/post'
import { buildPreviewModel, type PreviewMove } from '../../lib/machine/previewGeometry'
import { migrateProjectData } from '../../store/migrations/projectMigrations'
import type { Operation, Project } from '../../types'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import { typedMock } from '../support/typedMock'

const binaryCaches = vi.hoisted(() => ({
  stl: new Map<string, ArrayBuffer>(),
  step: new Map<string, ArrayBuffer>(),
}))

vi.mock('../../lib/stlCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stlCache')>()
  return typedMock<typeof import('../../lib/stlCache')>({
    ...actual,
    cacheSTL: vi.fn(async (id: string, bytes: ArrayBuffer) => { binaryCaches.stl.set(id, bytes) }),
    loadCachedSTL: vi.fn(async (id: string) => binaryCaches.stl.get(id) ?? null),
    removeCachedSTL: vi.fn(async (id: string) => { binaryCaches.stl.delete(id) }),
  })
})
vi.mock('../../lib/stepCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stepCache')>()
  return typedMock<typeof import('../../lib/stepCache')>({
    ...actual,
    cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { binaryCaches.step.set(id, bytes) }),
    loadCachedStep: vi.fn(async (id: string) => binaryCaches.step.get(id) ?? null),
    loadCachedStepDisplay: vi.fn(async () => null),
    cacheStepDisplay: vi.fn(async () => {}),
    removeCachedStep: vi.fn(async () => {}),
  })
})
// The load boundary restores STEP previews through a separate browser worker.
// The diagnosis is about CAM generation/posting, so keep that render-only
// worker out of the shared 2D worker shim while still loading the real project.
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()
  return typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...actual,
    readStep: vi.fn(async () => ({}) as never),
    setBrepPayload: vi.fn(),
  })
})

const FILE = path.resolve(__dirname, '../../../Example Projects/Full Suite.camproject')
const TOOL_ID = 'wo2935-chamfer90'
const CHAMFER_IDS = [
  'wo2935-plate-chamfer-pre',
  'wo2935-plate-chamfer',
  'wo2935-plate-chamfer-bolts',
  'wo2935-plate-chamfer-boss',
  'wo2935-plate-chamfer-shaft',
] as const
const POST_OPTIONS = {
  mode: 'combined',
  pauseBetweenSetups: false,
  baseName: 'full-suite',
  ext: 'nc',
} as const

// The production 2D toolpath worker is run in-process, using the same shim as
// the example-generation regression. This keeps the diagnosis on the app's
// computeOperationToolpath entry point without touching the saved fixture.
const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => Array.from(mem.keys())[index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } satisfies Storage,
  configurable: true,
})

const { useCamStore, smartHeightStockBounds } = await import('../../store')
const { resetDocumentHolder, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const { operationGenerationIsCurrent } = await import('../../lib/cam/generationFingerprint')

const globals = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (message: WorkerResponseMsg) => void; onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null }
  Worker: unknown
}
globals.window ??= {}
globals.window.__cncViewport = {
  clearScene: () => {},
  rebuildStock: () => {},
  addSTL: async () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }),
  setSTLVisible: () => {},
  setPartLoopsOnFacePlane: () => {},
  setPartProjectedLoops: () => {},
  addBrepModel: () => {},
  addModelBody: () => {},
  add2DGeometry: () => {},
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    const ids = stockId === undefined ? (project.stocks ?? []).map((stock) => stock.id) : [stockId]
    const boxes = ids
      .map((id) => smartHeightStockBounds(project, id))
      .filter((box): box is { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } => box !== null)
    if (boxes.length === 0) return null
    return {
      min: { x: Math.min(...boxes.map((box) => box.min.x)), y: Math.min(...boxes.map((box) => box.min.y)), z: Math.min(...boxes.map((box) => box.min.z)) },
      max: { x: Math.max(...boxes.map((box) => box.max.x)), y: Math.max(...boxes.map((box) => box.max.y)), z: Math.max(...boxes.map((box) => box.max.z)) },
    }
  },
}
const workerScope = {
  postMessage: (message: WorkerResponseMsg) => activeWorker?.onmessage?.({ data: message }),
  onmessage: null as ((event: { data: WorkerRequestMsg }) => Promise<void>) | null,
}
globals.self = workerScope
await import('../../lib/cam/toolpathWorker')
if (typeof workerScope.onmessage !== 'function') throw new Error('the real toolpathWorker did not install its handler')
let activeWorker: { onmessage: ((event: { data: WorkerResponseMsg }) => void) | null } | null = null
globals.Worker = class {
  onmessage: ((event: { data: WorkerResponseMsg }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage(message: WorkerRequestMsg): void {
    activeWorker = this
    void workerScope.onmessage!({ data: message })
  }
  terminate(): void { if (activeWorker === this) activeWorker = null }
}

function importedFullSuite(): Project {
  return migrateProjectData(JSON.parse(sourceText()))
}

function sourceText(): string {
  const override = process.env.WO3158_SOURCE_PATH
  const sourceCommit = process.env.WO3158_SOURCE_COMMIT
  if (sourceCommit) return execFileSync('git', ['show', `${sourceCommit}:Example Projects/Full Suite.camproject`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return fs.readFileSync(override ?? FILE, 'utf8')
}

function projectTextWithRpm(rpm: 24000 | 31000): string {
  const project = JSON.parse(sourceText()) as Project
  const tool = project.toolLibrary.find((candidate) => candidate.id === TOOL_ID)!
  tool.feedsAndSpeeds.default.rpm = rpm
  for (const operation of project.setups.flatMap((setup) => setup.operations)) {
    if (['wo2935-plate-chamfer-bolts', 'wo2935-plate-chamfer-boss', 'wo2935-plate-chamfer-shaft'].includes(operation.id)) {
      operation.feedrateOverride!.rpm = rpm
    }
  }
  return JSON.stringify(project)
}

type DiffEntry = { path: string; saved: unknown; generated: unknown }

function deepDiff(saved: unknown, generated: unknown, prefix = ''): DiffEntry[] {
  if (Object.is(saved, generated)) return []
  if (Array.isArray(saved) && Array.isArray(generated)) {
    const entries: DiffEntry[] = []
    for (let index = 0; index < Math.max(saved.length, generated.length); index++) {
      entries.push(...deepDiff(saved[index], generated[index], `${prefix}[${index}]`))
    }
    return entries
  }
  if (saved && generated && typeof saved === 'object' && typeof generated === 'object') {
    const keys = new Set([...Object.keys(saved), ...Object.keys(generated)])
    return [...keys].sort().flatMap((key) => deepDiff(
      (saved as Record<string, unknown>)[key],
      (generated as Record<string, unknown>)[key],
      prefix ? `${prefix}.${key}` : key,
    ))
  }
  return [{ path: prefix, saved, generated }]
}

function opSnapshot(operation: Operation): Operation {
  return structuredClone(operation)
}

type VariantResult = {
  label: string
  sourceSha256: string
  saved: Record<string, Operation>
  generated: Record<string, Operation>
  recomputed: string[]
  gcode: string
  previewMoves: Record<string, PreviewMove[]>
  preview: ReturnType<typeof buildPreviewModel>
  operationSpans: NonNullable<NonNullable<ReturnType<typeof postProject>['combined']>['operationSpans']>
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

type PostedLineDiff = { line: number; left: string | undefined; right: string | undefined }
type SideViewBounds = { xMin: number; xMax: number; zMin: number; zMax: number }

type RenderMove = Pick<PreviewMove, 'line' | 'kind' | 'coordinateFrame' | 'workCoordinateSystem'> & {
  from: PreviewMove['from']
  to: PreviewMove['to']
}

function renderMove(move: PreviewMove): RenderMove {
  return {
    line: move.line,
    kind: move.kind,
    coordinateFrame: move.coordinateFrame,
    workCoordinateSystem: move.workCoordinateSystem,
    from: move.from,
    to: move.to,
  }
}

function flatSideView(
  variant: VariantResult,
  rpm: number,
  spindleDifference: PostedLineDiff | undefined,
  bounds: SideViewBounds,
  wcs: Record<'clearance' | 'retract' | 'feed' | 'top' | 'bottom', number>,
): string {
  const { xMin, xMax, zMin, zMax } = bounds
  const xSpan = Math.max(xMax - xMin, 1)
  const zSpan = Math.max(zMax - zMin, 1)
  const left = 100, top = 78, width = 1120, height = 470
  const px = (x: number) => left + ((x - xMin) / xSpan) * width
  const py = (z: number) => top + ((zMax - z) / zSpan) * height
  const planes = [
    ['Clearance (WCS)', wcs.clearance, '#c0392b'],
    ['Retract (WCS)', wcs.retract, '#d68910'],
    ['Feed (WCS)', wcs.feed, '#2980b9'],
    ['Top (stock-top ref, WCS)', wcs.top, '#27ae60'],
    ['Bottom (WCS)', wcs.bottom, '#7f8c8d'],
  ] as const
  const palette = ['#4527a0', '#1565c0', '#00897b', '#ef6c00', '#6d4c41']
  const paths = CHAMFER_IDS.map((id, index) => {
    const points = variant.previewMoves[id]
      .flatMap((move) => [`M ${px(move.from.x).toFixed(2)} ${py(move.from.z).toFixed(2)}`, `L ${px(move.to.x).toFixed(2)} ${py(move.to.z).toFixed(2)}`])
      .join(' ')
    return `<path d="${points}" fill="none" stroke="${palette[index]}" stroke-width="1.6" opacity="0.85" ${variant.previewMoves[id].some((move) => move.kind === 'rapid') ? 'stroke-dasharray="5 3"' : ''}/>`
  }).join('\n')
  const planeLines = planes.map(([name, z, color]) => {
    const y = py(z)
    return `<line x1="${left}" y1="${y.toFixed(2)}" x2="${left + width}" y2="${y.toFixed(2)}" stroke="${color}" stroke-width="1" stroke-dasharray="6 4"/><text x="${left + width + 12}" y="${(y + 4).toFixed(2)}" fill="${color}" font-size="13">${xml(name)} ${z.toFixed(2)} mm</text>`
  }).join('\n')
  const legend = CHAMFER_IDS.map((id, index) =>
    `<text x="${left + (index % 3) * 370}" y="${top + height + 82 + Math.floor(index / 3) * 22}" fill="${palette[index]}" font-size="12">${index + 1}. ${xml(id)} (posted WCS moves)</text>`,
  ).join('\n')
  const spindleText = spindleDifference
    ? `Complete posted diff includes line ${spindleDifference.line}: ${spindleDifference.left ?? '(none)'} -> ${spindleDifference.right ?? '(none)'}.`
    : 'The complete posted diff contains no identified spindle-word line.'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800" viewBox="0 0 1600 800">
<rect width="1600" height="800" fill="white"/>
<text x="${left}" y="27" font-family="sans-serif" font-size="17" font-weight="bold">Full Suite chamfers - X-Z flat side view (${rpm.toLocaleString()} RPM)</text>
<text x="${left}" y="49" font-family="sans-serif" font-size="12">Production posted-preview moves in WCS frame; dashed lines are resolved WCS planes; posted spindle word: M3 S${rpm}</text>
<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#fafafa" stroke="#555"/>
${planeLines}
${paths}
<text x="${left}" y="${top + height + 22}" font-family="sans-serif" font-size="12">X (mm)</text>
<text x="18" y="${top + height / 2}" transform="rotate(-90 18 ${top + height / 2})" font-family="sans-serif" font-size="12">Z (mm)</text>
<text x="${left}" y="${top + height + 57}" font-family="sans-serif" font-size="12" font-weight="bold">Operation legend (solid feed/arc, dashed rapid):</text>
${legend}
<text x="${left}" y="${top + height + 142}" font-family="sans-serif" font-size="12">${xml(spindleText)}</text>
<text x="${left}" y="${top + height + 164}" font-family="sans-serif" font-size="12">Renderer data comes from buildPreviewModel(posted NC), selected by emitted operationSpans; no raw CAM/model moves are overlaid.</text>
<text x="${left}" y="${top + height + 186}" font-family="sans-serif" font-size="12">Complete NC and motion diff is retained in regeneration-comparison.json.</text>
</svg>\n`
}

async function generateVariant(label: string, source: string): Promise<VariantResult> {
  const savedProject = migrateProjectData(JSON.parse(source))
  const savedSetup = savedProject.setups.find((candidate) => candidate.name === 'Setup 1')!
  const saved = Object.fromEntries(CHAMFER_IDS.map((id) => [id, opSnapshot(savedSetup.operations.find((operation) => operation.id === id)!)]))
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  binaryCaches.stl.clear()
  binaryCaches.step.clear()
  useCamStore.setState({ toolLibrary: [], toolLibraries: [], holders: [], machineLibrary: [] })
  useCamStore.getState().newProject()
  await useCamStore.getState().loadProjectFromFile(source)
  const loaded = useCamStore.getState().project
  const setup = loaded.setups.find((candidate) => candidate.name === 'Setup 1')!
  const staged = await useCamStore.getState().stageOperationsForEmission(setup.id, undefined)
  const fresh = useCamStore.getState()
  const project = { ...fresh.project, toolLibrary: fresh.toolLibrary }
  const stagedSetup = project.setups.find((candidate) => candidate.id === setup.id)!
  const generated = Object.fromEntries(CHAMFER_IDS.map((id) => [id, opSnapshot(stagedSetup.operations.find((operation) => operation.id === id)!)]))
  expect(CHAMFER_IDS.flatMap((id) => [saved[id].status, generated[id].status])).not.toContain('error')
  expect(CHAMFER_IDS.every((id) => operationGenerationIsCurrent(project, stagedSetup, generated[id]))).toBe(true)
  const posted = postProject(
    project,
    [stagedSetup],
    UCCNC_CONFIG,
    POST_OPTIONS,
  )
  expect(posted.ok, `${label}: ${JSON.stringify(posted.diagnostics)}`).toBe(true)
  const combined = posted.combined!
  const operationSpans = combined.operationSpans ?? []
  const preview = buildPreviewModel(combined.gcode)
  expect(preview.refusal, `${label}: posted preview refused`).toBeNull()
  const previewMoves = Object.fromEntries(CHAMFER_IDS.map((id) => {
    const spans = operationSpans.filter((span) => span.opId === id)
    expect(spans, `${label}: missing emitted span for ${id}`).not.toHaveLength(0)
    const moves = preview.moves.filter((move) => spans.some((span) => move.line >= span.startLine && move.line <= span.endLine))
    expect(moves, `${label}: no posted preview moves for ${id}`).not.toHaveLength(0)
    expect(moves.every((move) => move.coordinateFrame === 'work' && move.workCoordinateSystem !== null), `${label}: ${id} mixes machine/unknown frames`).toBe(true)
    return [id, moves]
  })) as Record<string, PreviewMove[]>
  const rendererMoves = CHAMFER_IDS.flatMap((id) => previewMoves[id].map(renderMove))
  const parsedSpanMoves = CHAMFER_IDS.flatMap((id) => previewMoves[id].map(renderMove))
  expect(rendererMoves).toEqual(parsedSpanMoves)
  return {
    label,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    saved,
    generated,
    recomputed: staged.recomputed.map(({ opId }) => opId),
    gcode: posted.combined!.gcode,
    previewMoves,
    preview,
    operationSpans,
  }
}

function lineDiff(left: string, right: string): PostedLineDiff[] {
  const a = left.split('\n')
  const b = right.split('\n')
  const out: Array<{ line: number; left: string | undefined; right: string | undefined }> = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push({ line: i + 1, left: a[i], right: b[i] })
  }
  return out
}

function sharedSideViewBounds(variants: VariantResult[], wcs: Record<'clearance' | 'retract' | 'feed' | 'top' | 'bottom', number>): SideViewBounds {
  const moves = variants.flatMap((variant) => CHAMFER_IDS.flatMap((id) => variant.previewMoves[id]))
  const xs = moves.flatMap((move) => [move.from.x, move.to.x])
  const zs = [...moves.flatMap((move) => [move.from.z, move.to.z]), ...Object.values(wcs)]
  const xMin = Math.min(...xs), xMax = Math.max(...xs), zMin = Math.min(...zs), zMax = Math.max(...zs)
  const xMargin = Math.max((xMax - xMin) * 0.05, 2)
  const zMargin = Math.max((zMax - zMin) * 0.08, 2)
  return {
    xMin: xMin - xMargin,
    xMax: xMax + xMargin,
    zMin: zMin - zMargin,
    zMax: zMax + zMargin,
  }
}

describe('WO-3158: Full Suite chamfer recipe RPM', () => {
  it('loads, resolves and posts all five chamfers at 24,000 RPM', () => {
    const project = importedFullSuite()
    const setup = project.setups.find((candidate) => candidate.name === 'Setup 1')!
    const tool = project.toolLibrary.find((candidate) => candidate.id === TOOL_ID)!
    const operations = setup.operations.filter((operation) => CHAMFER_IDS.includes(operation.id as typeof CHAMFER_IDS[number]))

    expect(tool.feedsAndSpeeds.default).toMatchObject({ rpm: 24000, feedRate: 900, plungeRate: 100 })
    expect(project.machine.maxSpindleRpm).toBe(31000)
    expect(operations.map((operation) => operation.id)).toEqual([...CHAMFER_IDS])
    expect(operations.slice(0, 2).map((operation) => [operation.feedrateOverride?.enabled, operation.feedrateOverride?.rpm]))
      .toEqual([[false, 18000], [false, 18000]])
    expect(operations.slice(2).map((operation) => [operation.feedrateOverride?.enabled, operation.feedrateOverride?.rpm]))
      .toEqual([[true, 24000], [true, 24000], [true, 24000]])

    const input = buildPostInput(project, setup)
    const resolved = input.setup.operations
      .filter((operation) => CHAMFER_IDS.includes(operation.op.id as typeof CHAMFER_IDS[number]))
      .map((operation) => [operation.op.id, operation.spindle.rpm])
    expect(resolved).toEqual(CHAMFER_IDS.map((id) => [id, 24000]))

    // WO-3153: the shipped file now opens current (regenerated through File
    // Open, Generate All, Save), so it posts; every chamfer cuts at 24,000 RPM.
    const posted = postProject(project, [setup], GRBL_CONFIG, POST_OPTIONS)
    expect(posted.ok, JSON.stringify(posted.diagnostics)).toBe(true)
    expect(posted.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    const lines = posted.combined!.gcode.split('\n')
    const spindle = (line: string) => /^[^;(]*\bS(\d+(?:\.\d+)?)/.exec(line)?.[1]
    for (const id of CHAMFER_IDS) {
      const span = (posted.combined!.operationSpans ?? []).find((candidate) => candidate.opId === id)!
      // One-based inclusive span; the speed in force is the last S word up to its end.
      const upToEnd = lines.slice(0, span.endLine).map(spindle).filter((word) => word !== undefined)
      const inSpan = lines.slice(span.startLine - 1, span.endLine).map(spindle).filter((word) => word !== undefined)
      expect([id, upToEnd.at(-1), [...new Set(inSpan)].filter((word) => Number(word) !== 24000)])
        .toEqual([id, '24000', []])
    }
  })

  // D10 (owner ruling 10-27): generated evidence is not committed; regenerate it on demand with WRITE_EVIDENCE=1.
  it.skipIf(!process.env.WRITE_EVIDENCE)('regenerates only the five affected chamfers and compares the real posted route', { timeout: 600_000 }, async () => {
    const thirtyOne = await generateVariant('temporary-31k', projectTextWithRpm(31000))
    const twentyFour = await generateVariant('shipped-24k', projectTextWithRpm(24000))
    expect(thirtyOne.recomputed, '31,000-RPM saved caches should remain current').toEqual([])
    expect(twentyFour.recomputed, '24,000-RPM staging should recompute all five affected chamfers')
      .toEqual([...CHAMFER_IDS])
    const operationComparison = Object.fromEntries(CHAMFER_IDS.map((id) => [id, {
      savedVsGenerated31k: deepDiff(thirtyOne.saved[id], thirtyOne.generated[id]),
      savedVsGenerated24k: deepDiff(twentyFour.saved[id], twentyFour.generated[id]),
      generated31kVsGenerated24k: deepDiff(thirtyOne.generated[id], twentyFour.generated[id]),
    }]))
    const postedDiff = lineDiff(thirtyOne.gcode, twentyFour.gcode)
    const spindleDifference = postedDiff.find(({ left, right }) => left?.startsWith('M3 S') && right?.startsWith('M3 S'))
    const sharedWcs = thirtyOne.generated[CHAMFER_IDS[0]].resolvedHeights?.wcs ?? {
      clearance: 15, retract: 5, feed: 4, top: 0, bottom: -1,
    }
    expect(twentyFour.generated[CHAMFER_IDS[0]].resolvedHeights?.wcs).toEqual(sharedWcs)
    const firstChamferRawZ = thirtyOne.generated[CHAMFER_IDS[0]].toolpathMoves?.[0]?.z
    const firstChamferPostedMove = thirtyOne.previewMoves[CHAMFER_IDS[0]][0]
    expect(firstChamferPostedMove.coordinateFrame).toBe('work')
    expect(firstChamferPostedMove.workCoordinateSystem).not.toBeNull()
    expect(firstChamferPostedMove.from.z).toBe(15)
    expect(firstChamferRawZ).toBe(20)
    expect(firstChamferPostedMove.from.z).not.toBe(firstChamferRawZ)
    const sharedBounds = sharedSideViewBounds([thirtyOne, twentyFour], sharedWcs)
    const evidenceDir = path.resolve(__dirname, '../evidence/WO-3158')
    const files = {
      nc31k: 'regenerated-31k.nc',
      nc24k: 'regenerated-24k.nc',
      flat31k: 'flat-xz-31k.svg',
      flat24k: 'flat-xz-24k.svg',
      png31k: 'flat-xz-31k.png',
      png24k: 'flat-xz-24k.png',
    }
    fs.writeFileSync(path.join(evidenceDir, files.nc31k), thirtyOne.gcode)
    fs.writeFileSync(path.join(evidenceDir, files.nc24k), twentyFour.gcode)
    fs.writeFileSync(path.join(evidenceDir, files.flat31k), flatSideView(thirtyOne, 31000, spindleDifference, sharedBounds, sharedWcs))
    fs.writeFileSync(path.join(evidenceDir, files.flat24k), flatSideView(twentyFour, 24000, spindleDifference, sharedBounds, sharedWcs))
    const renderReadback: Record<string, { sha256: string; bytes: number; width: number; height: number; mtimeMs: number }> = {}
    for (const [svgFile, pngFile] of [[files.flat31k, files.png31k], [files.flat24k, files.png24k]] as const) {
      const pngPath = path.join(evidenceDir, pngFile)
      try { fs.unlinkSync(pngPath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await sharp(path.join(evidenceDir, svgFile)).png().toFile(pngPath)
      const stat = fs.statSync(pngPath)
      const metadata = await sharp(pngPath).metadata()
      expect(stat.size).toBeGreaterThan(0)
      expect(metadata.width).toBe(1600)
      expect(metadata.height).toBe(800)
      renderReadback[pngFile] = {
        sha256: createHash('sha256').update(fs.readFileSync(pngPath)).digest('hex'),
        bytes: stat.size,
        width: metadata.width!,
        height: metadata.height!,
        mtimeMs: stat.mtimeMs,
      }
    }
    const artifact = {
      order: 'WO-3158',
      command: 'npx vitest run src/tests/post/fullSuiteRecipeRpm.wo3158.test.ts --reporter=verbose',
      route: 'loadProjectFromFile -> stageOperationsForEmission (automatic five-chamfer recompute) -> postProject(UCCNC)',
      sourceVariants: {
        temporary31k: {
          sha256: thirtyOne.sourceSha256,
          values: { default: 31000, bolts: 31000, boss: 31000, shaft: 31000 },
          stagingRecomputed: thirtyOne.recomputed,
        },
        shipped24k: {
          sha256: twentyFour.sourceSha256,
          values: { default: 24000, bolts: 24000, boss: 24000, shaft: 24000 },
          stagingRecomputed: twentyFour.recomputed,
        },
      },
      operationIds: CHAMFER_IDS,
      evidenceFiles: Object.fromEntries(Object.values(files).map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(evidenceDir, file))).digest('hex')])),
      renderReadback,
      sourceHashes: {
        test: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
        previewGeometry: createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../../lib/machine/previewGeometry.ts'))).digest('hex'),
      },
      preview: {
        parser: 'buildPreviewModel(posted NC)',
        operationSpans: {
          temporary31k: thirtyOne.operationSpans.filter((span) => CHAMFER_IDS.includes(span.opId as typeof CHAMFER_IDS[number])),
          shipped24k: twentyFour.operationSpans.filter((span) => CHAMFER_IDS.includes(span.opId as typeof CHAMFER_IDS[number])),
        },
        selectedMoveCounts: {
          temporary31k: Object.fromEntries(CHAMFER_IDS.map((id) => [id, thirtyOne.previewMoves[id].length])),
          shipped24k: Object.fromEntries(CHAMFER_IDS.map((id) => [id, twentyFour.previewMoves[id].length])),
        },
        firstChamferFrame: {
          coordinateFrame: firstChamferPostedMove.coordinateFrame,
          workCoordinateSystem: firstChamferPostedMove.workCoordinateSystem,
          postedClearanceZ: firstChamferPostedMove.from.z,
          rawCamFirstMoveZ: firstChamferRawZ,
          mismatchExplanation: 'raw CAM/model moves and posted WCS preview moves are different coordinate presentations; only posted preview moves are plotted',
        },
      },
      operationComparison,
      posted: {
        thirtyOneGcode: thirtyOne.gcode,
        twentyFourGcode: twentyFour.gcode,
        completeLineDiff: postedDiff,
        lineCount31k: thirtyOne.gcode.split('\n').length,
        lineCount24k: twentyFour.gcode.split('\n').length,
      },
      conclusion: 'automatic staging recomputes the five corrected chamfers; the complete saved-31k versus staged-24k differences are recorded and include any motion changes',
    }
    fs.writeFileSync(path.join(evidenceDir, 'regeneration-comparison.json'), `${JSON.stringify(artifact, null, 2)}\n`)
    expect(artifact.conclusion).toBe(
      'automatic staging recomputes the five corrected chamfers; the complete saved-31k versus staged-24k differences are recorded and include any motion changes',
    )
  })
})

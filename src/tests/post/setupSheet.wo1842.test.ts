// @vitest-environment jsdom
//
// WO-1842: a setup sheet downloads with the program.
//
// buildSetupSheet is a pure text builder over the SAME PostInput data
// (buildPostInput) and PostResult (operationSpans, gcode) the post itself
// produces, so these tests drive it through postProject on a real fixture
// project exactly the way the modal will, then verify the sheet's claims
// against the actual posted text rather than against the builder's own
// bookkeeping. jsdom is used file-wide (needed for the modal/component test
// at the bottom); Node's crypto.subtle survives under it (verified: jsdom
// does not shadow globalThis.crypto), so the pure-builder tests above are
// unaffected by the environment choice.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { postProject } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { buildSetupSheet, quoted, setupSheetFilenameFor } from '../../lib/post/setupSheet'
import { stockWorldBounds } from '../../store/stockAssignment'
import { toWork } from '../../lib/program/coords'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from './helpers'
import type {
  BoundingBox, Operation, PhysicalStock, Project, Setup, Stock, Vec3,
} from '../../types'

// --- fixtures ----------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min },
    max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function makeStock(): Stock {
  return {
    type: 'rectangular', width: 300, depth: 200, height: 25, origin: { x: 0, y: 0, z: 0 },
  } as unknown as Stock
}

function physStock(id: string, name: string, fixtureOffset: number): PhysicalStock {
  return {
    id,
    name,
    mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 300, y: 200, z: 25 }),
    position: { x: 0, y: 0, z: 0 },
    fixtureOffset,
  }
}

/** First-tool op: rapid to Z5, two cuts descending to Z-4 (world). */
// Machine-frame bottom must reach the deepest move (world Z -4) once the
// setup's wcs.origin.z (2) is added to the local bottomHeight, or the CAM-17
// saved-toolpath/height-snapshot check downgrades the op to 'outdated' before
// posting ever sees it.
const DEEP_HEIGHTS = {
  clearanceHeight: 10,
  clearanceHeightMode: 'absolute' as const,
  retractHeight: 5,
  feedHeight: 1,
  topHeight: 0,
  topHeightMode: 'stock_top' as const,
  bottomHeight: -10,
  bottomHeightMode: 'absolute' as const,
}

function roughOp(nameOverride?: string): Operation {
  return makeOp({
    id: 'op-rough',
    name: nameOverride ?? 'Rough',
    toolId: 't1',
    heights: DEEP_HEIGHTS,
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: -2, feed: 2000, role: 'cut' }),
      move({ type: 'feed', x: 40, y: 20, z: -4, feed: 2000, role: 'cut' }),
    ],
  })
}

/** Second, DIFFERENT-tool op: forces a real tool change (T2 M6). */
function finishOp(): Operation {
  return makeOp({
    id: 'op-finish',
    name: 'Finish',
    toolId: 't2',
    heights: DEEP_HEIGHTS,
    toolpathMoves: [
      move({ type: 'rapid', x: 40, y: 20, z: 3, role: 'rapid' }),
      move({ type: 'feed', x: 60, y: 40, z: -1, feed: 900, role: 'cut' }),
    ],
  })
}

function makeSetup(rough: Operation, finish: Operation): Setup {
  return {
    id: 's1',
    name: 'Front',
    // Non-identity origin (z:2) so the Z-range/origin math actually exercises
    // the world->work transform instead of passing through unchanged.
    wcs: makeWcs({ id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 2 }, stockId: 'stock-a' }),
    stock: makeStock(),
    operations: [rough, finish],
    notes: '',
  }
}

function makeProject(setup: Setup): Project {
  const project: Project = {
    id: 'p1',
    name: 'Two Op Fixture',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [
      makeTool({ id: 't1', name: 'Endmill 6mm', toolNumber: 1, diameter: 6, fluteLength: 25 }),
      makeTool({
        id: 't2', name: 'Finish 3mm', toolNumber: 2, diameter: 3, fluteLength: 12,
        feedsAndSpeeds: { default: { rpm: 9000, feedRate: 900, plungeRate: 250, depthOfCut: 1, stepover: 1 } },
      }),
    ],
    geometry: [],
    stocks: [physStock('stock-a', 'Plate A', 54)],
    setups: [setup],
    activeSetupId: null,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  }
  for (const op of setup.operations) {
    const tool = project.toolLibrary.find((t) => t.id === op.toolId)!
    stampGenerationCurrent(project, setup, op, tool)
  }
  return project
}

const baseOpts = { mode: 'combined' as const, pauseBetweenSetups: false, baseName: 'part', ext: 'nc' }

function build(nameOverride?: string) {
  const rough = roughOp(nameOverride)
  const finish = finishOp()
  const setup = makeSetup(rough, finish)
  const project = makeProject(setup)
  const res = postProject(project, [setup], UCCNC_CONFIG, baseOpts)
  if (!res.ok || !res.combined) throw new Error('fixture failed to post: ' + JSON.stringify(res.diagnostics))
  return { project, setup, result: res.combined }
}

// --- tests ---------------------------------------------------------------

describe('buildSetupSheet (WO-1842)', () => {
  it('NC line ranges point at the real tool-change/first-move lines in the posted text', async () => {
    const { project, setup, result } = build()
    const gcodeLines = result.gcode.split('\n')
    const sheet = await buildSetupSheet(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)

    const roughMatch = sheet.match(/1\. "Rough"[\s\S]*?NC lines: (\d+)-(\d+)/)
    const finishMatch = sheet.match(/2\. "Finish"[\s\S]*?NC lines: (\d+)-(\d+)/)
    expect(roughMatch).not.toBeNull()
    expect(finishMatch).not.toBeNull()
    const [, roughStartStr, roughEndStr] = roughMatch!
    const [, finishStartStr, finishEndStr] = finishMatch!
    const roughStart = Number(roughStartStr)
    const roughEnd = Number(roughEndStr)
    const finishStart = Number(finishStartStr)
    const finishEnd = Number(finishEndStr)

    // Read the lines the sheet claims out of the ACTUAL posted text.
    const roughSpan = gcodeLines.slice(roughStart - 1, roughEnd)
    const finishSpan = gcodeLines.slice(finishStart - 1, finishEnd)

    // Rough opens its own span (the section comment names it) and carries the
    // first-tool load (T1) plus its first cutting move (X30).
    expect(gcodeLines[roughStart - 1]).toBe('( Rough )')
    expect(roughSpan.some((l) => l === 'T1')).toBe(true)
    expect(roughSpan.some((l) => l.includes('X30'))).toBe(true)

    // Finish is a DIFFERENT tool -> its span carries the real tool-change line
    // (T2 M6, not a bare initial load) and its own first cutting move (X60).
    expect(gcodeLines[finishStart - 1]).toBe('( Finish )')
    expect(finishSpan.some((l) => l === 'T2 M6')).toBe(true)
    expect(finishSpan.some((l) => l.includes('X60'))).toBe(true)

    // Negative control: shifting the line lookup by one no longer lands on the
    // section's own opening line - the assertion the sheet's claim rests on
    // fails once the range is wrong.
    expect(gcodeLines[roughStart]).not.toBe('( Rough )')
    expect(gcodeLines[finishStart]).not.toBe('( Finish )')
  })

  it('tool, RPM and feeds match the project operations', async () => {
    const { project, setup, result } = build()
    const sheet = await buildSetupSheet(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)

    expect(sheet).toContain('Tool: T1 "Endmill 6mm" dia 6mm flute length 25mm')
    expect(sheet).toContain('Spindle: 12000 RPM') // makeTool default feedsAndSpeeds.default.rpm
    expect(sheet).toContain('Feed: cutting 2000mm/min, plunge 400mm/min')

    expect(sheet).toContain('Tool: T2 "Finish 3mm" dia 3mm flute length 12mm')
    expect(sheet).toContain('Spindle: 9000 RPM')
    expect(sheet).toContain('Feed: cutting 900mm/min, plunge 250mm/min')
  })

  it('Z range per operation equals the min/max WORK Z of that operation\'s posted moves', async () => {
    const { project, setup, result } = build()
    const sheet = await buildSetupSheet(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)

    const wcs = setup.wcs
    const roughZs = [
      toWork({ x: 0, y: 0, z: 5 }, wcs).z,
      toWork({ x: 30, y: 20, z: -2 }, wcs).z,
      toWork({ x: 40, y: 20, z: -4 }, wcs).z,
    ]
    const finishZs = [
      toWork({ x: 40, y: 20, z: 3 }, wcs).z,
      toWork({ x: 60, y: 40, z: -1 }, wcs).z,
    ]
    expect(sheet).toContain(`Z range: ${Math.min(...roughZs)} to ${Math.max(...roughZs)} mm`)
    expect(sheet).toContain(`Z range: ${Math.min(...finishZs)} to ${Math.max(...finishZs)} mm`)
  })

  it('SHA-256 and byte length match the exact posted text bytes the G-code download writes', async () => {
    const { project, setup, result } = build()
    const sheet = await buildSetupSheet(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)

    const bytes = new TextEncoder().encode(result.gcode)
    expect(sheet).toContain(`Bytes: ${bytes.length}`)

    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    expect(sheet).toContain(`SHA-256: ${hex}`)
  })

  it('quotes names so an embedded newline cannot fake an extra instruction line', async () => {
    // JSON quoting itself: an embedded newline/quote/backslash never survives
    // as a raw control character in the quoted output.
    const evil = 'Rough"\nNC lines: 999-999\n'
    const q = quoted(evil)
    expect(q).not.toMatch(/\n/)
    expect(JSON.parse(q)).toBe(evil)

    // Integration: an operation named with an embedded newline cannot inject a
    // fake "NC lines" row - the real per-operation range is still the only one
    // that appears for operation 1.
    const { project, setup, result } = build(evil)
    const sheet = await buildSetupSheet(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)
    const fakeLine = sheet.split('\n').find((l) => l.trim() === 'NC lines: 999-999')
    expect(fakeLine).toBeUndefined()
    // The op's real header line is the JSON-quoted (single-line) name.
    expect(sheet).toContain(`1. ${quoted(evil)}`)
  })

  it('reports the setup work offset, stock size and origin placement', async () => {
    const { project, setup, result } = build()
    const sheet = await buildSetupSheet(project, [setup], UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)

    expect(sheet).toContain('Setup: "Front" (G54)')
    expect(sheet).toContain('Units: mm')
    expect(sheet).toContain('Work offset origin: X0 Y0 Z2 mm')
    expect(sheet).toContain('Stock: "Plate A" size 300 x 200 x 25 mm')
    expect(sheet).toContain('Origin offset from stock min corner: X0 Y0 Z2 mm')
  })

  it('setupSheetFilenameFor swaps the program extension for .setup.txt', () => {
    expect(setupSheetFilenameFor('part.nc')).toBe('part.setup.txt')
    expect(setupSheetFilenameFor('part-G54.nc')).toBe('part-G54.setup.txt')
  })

  it('separate mode: a selectedOpIds filter drops an unselected setup from the sheet (mirrors postProject drop-empty)', async () => {
    const rough = roughOp()
    const finish = finishOp()
    const setup = makeSetup(rough, finish)
    const project = makeProject(setup)
    const res = postProject(project, [setup], UCCNC_CONFIG, {
      ...baseOpts,
      selectedOpIds: { s1: ['op-rough'] },
    })
    expect(res.ok).toBe(true)
    const sheet = await buildSetupSheet(project, [setup], UCCNC_CONFIG, res.combined!, 'part.nc', stockWorldBounds, { s1: ['op-rough'] })
    expect(sheet).toContain('1. "Rough"')
    expect(sheet).not.toContain('"Finish"')
  })
})

// --- component test: the dialog's setup-sheet download control -------------
// Mirrors src/tests/components/PostProcessModalConsole.smoke.test.tsx's
// working-Export harness (same fixture helpers, same Blob/anchor mocking
// pattern), but drives the NEW "Setup Sheet" footer button instead.

describe('PostProcessModal setup-sheet download control (WO-1842)', () => {
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

  let capturedBlobs: Array<{ parts: unknown[]; type: string }>
  let capturedFilenames: string[]
  let expectedProject: Project
  let expectedSetup: Setup

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  beforeEach(async () => {
    const { useCamStore } = await import('../../store')

    capturedBlobs = []
    capturedFilenames = []
    class CapturedBlob {
      parts: unknown[]
      type: string
      constructor(parts: unknown[], options?: { type?: string }) {
        this.parts = parts
        this.type = options?.type ?? ''
        capturedBlobs.push({ parts, type: this.type })
      }
    }
    vi.stubGlobal('Blob', CapturedBlob)
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function capture(this: HTMLAnchorElement) {
      capturedFilenames.push(this.download)
    })

    act(() => {
      useCamStore.getState().closeModal()
      const tool = makeTool()
      const op = makeOp({ toolId: tool.id }) // status:'ready' + a real toolpath move (helper default)
      const setup = {
        id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
        stock: { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 } } as unknown as Stock,
        operations: [op], notes: '',
      }
      const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
      const project = { ...s.project, name: 'TestProject', machine: makeMachine(), setups: [setup] }
      stampGenerationCurrent(
        { ...project, toolLibrary: [tool] } as unknown as Project,
        setup as unknown as Setup,
        op,
        tool,
      )
      useCamStore.setState({
        project,
        toolLibrary: [tool],
        consoleEvents: [], consoleReadThroughId: 0,
      } as never)
      expectedProject = { ...project, toolLibrary: [tool] } as unknown as Project
      expectedSetup = setup as unknown as Setup
    })
  })

  it('renders a setup-sheet download control; clicking it downloads a .txt matching the builder output', async () => {
    const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
    render(createElement(PostProcessModal))
    const { useCamStore } = await import('../../store')
    act(() => { useCamStore.getState().openModal('post-process') })

    // Turn off "Include LienCAM context": its LCX1 comment block embeds a
    // real-time generatedAt timestamp, which would make the posted bytes (and
    // this test's independent re-post below) different on every run through
    // no fault of the setup sheet. Plain-program output is deterministic.
    const contextToggle = screen.getByTestId('post-include-context-row')
      .querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(contextToggle)

    const sheetBtn = screen.getByTestId('post-download-setup-sheet')
    expect(sheetBtn.hasAttribute('disabled')).toBe(false)

    fireEvent.click(sheetBtn)

    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled())

    expect(capturedFilenames[0]).toMatch(/\.setup\.txt$/)
    expect(capturedBlobs[0].type).toBe('text/plain')

    // The exact same fresh post the modal just ran, computed independently:
    // the op was already 'ready' + generation-current, so the staged
    // recompute inside the modal is a no-op and reproduces byte-identical
    // output from the same fixture objects.
    const res = postProject(expectedProject, [expectedSetup], UCCNC_CONFIG, {
      mode: 'combined', pauseBetweenSetups: false, baseName: 'TestProject', ext: 'nc',
    })
    expect(res.ok).toBe(true)
    const expectedSheet = await buildSetupSheet(
      expectedProject, [expectedSetup], UCCNC_CONFIG, res.combined!, capturedFilenames[0].replace(/\.setup\.txt$/, '.nc'),
      stockWorldBounds,
    )
    expect(String(capturedBlobs[0].parts[0])).toBe(expectedSheet)
  })
})

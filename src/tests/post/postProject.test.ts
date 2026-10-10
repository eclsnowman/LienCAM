import { describe, it, expect } from 'vitest'
import { postProject } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import {
  makeMachine, makeOp, makeOverride, makeTool, makeWcs, move, stampGenerationCurrent,
} from './helpers'
import type {
  BoundingBox, ImportedGeometry, Operation, PhysicalStock, Project, Setup, Stock, Vec3,
} from '../../types'

// --- fixtures ----------------------------------------------------------------

function makeStock(): Stock {
  return {
    type: 'rectangular',
    width: 100,
    depth: 100,
    height: 20,
    origin: { x: 0, y: 0, z: 0 },
  } as unknown as Stock
}

/** A 2-move op: rapid up to Z5, feed-cut at Z5. Highest (safe) Z = 5. */
function twoMoveOp(id: string, name: string): Operation {
  return makeOp({
    id,
    name,
    toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}

function makeSetup(
  id: string,
  name: string,
  fixtureOffset: number,
  ops: Operation[],
): Setup {
  return {
    id,
    name,
    wcs: makeWcs({ id: `wcs-${id}`, label: `G${fixtureOffset}`, fixtureOffset }),
    stock: makeStock(),
    operations: ops,
    notes: '',
  }
}

/** A 2-move op bound to an explicit tool id (defaults to 't1'). */
function twoMoveOpTool(id: string, name: string, toolId: string): Operation {
  return makeOp({
    id,
    name,
    toolId,
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}

function makeProject(
  setups: Setup[],
  extras: { geometry?: ImportedGeometry[]; stocks?: PhysicalStock[] } = {},
): Project {
  const project: Project = {
    id: 'p1',
    name: 'Test Project',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    // Two tools so different-tool scenarios resolve distinct T numbers (T1/T2).
    toolLibrary: [
      makeTool({ id: 't1', toolNumber: 1 }),
      makeTool({ id: 't2', toolNumber: 2 }),
    ],
    geometry: extras.geometry ?? [],
    stocks: extras.stocks,
    setups,
    activeSetupId: null,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  }
  // CAM-15 (52ac9e3e7): a 'ready' op must carry a fingerprint-current generation
  // stamp or posting refuses it as OP_OUTDATED. Stamp every ready fixture op
  // against the final project; non-ready ops (the intentional 'outdated'
  // fixtures) are left untouched so the refusal paths stay covered.
  for (const setup of setups) {
    for (const op of setup.operations) {
      if (op.status !== 'ready') continue
      const tool = project.toolLibrary.find((t) => t.id === op.toolId)!
      stampGenerationCurrent(project, setup, op, tool)
    }
  }
  return project
}

// -- SETUP_MULTI_STOCK fixtures (ADR 0026) ------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function geoOnStock(id: string, stockId: string): ImportedGeometry {
  return {
    id, name: id, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId,
    loops: [{
      id: `${id}-loop`, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 50,
    }],
  } as ImportedGeometry
}

function physStock(id: string, name: string): PhysicalStock {
  return {
    id, name, mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

/** A 2-move op (highest safe Z = 5) bound to a geometry via params.geometryId. */
function opForGeo(id: string, name: string, geometryId: string): Operation {
  return makeOp({
    id, name, toolId: 't1',
    params: { geometryId },
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}

/** Two distinct setups on G54 / G55, one 2-move op each, BOTH on tool t1. */
function twoSetupProject(): { project: Project; setups: Setup[] } {
  const s1 = makeSetup('s1', 'Front', 54, [twoMoveOp('op-a', 'Profile A')])
  const s2 = makeSetup('s2', 'Back', 55, [twoMoveOp('op-b', 'Profile B')])
  const setups = [s1, s2]
  return { project: makeProject(setups), setups }
}

/** Two distinct setups on G54 / G55; setup 1 uses tool t1 (T1), setup 2 uses
 *  tool t2 (T2) -> the boundary MUST contain a real tool change. */
function twoSetupDiffToolProject(): { project: Project; setups: Setup[] } {
  const s1 = makeSetup('s1', 'Front', 54, [twoMoveOpTool('op-a', 'Profile A', 't1')])
  const s2 = makeSetup('s2', 'Back', 55, [twoMoveOpTool('op-b', 'Profile B', 't2')])
  const setups = [s1, s2]
  return { project: makeProject(setups), setups }
}

const baseOpts = { mode: 'combined' as const, pauseBetweenSetups: false, baseName: 'part', ext: 'nc' }

function countOf(lines: string[], pred: (l: string) => boolean): number {
  return lines.filter(pred).length
}

// --- combined: single preamble / postamble + ordered WCS selects -------------

describe('postProject — combined mode', () => {
  it('posts both resolved speeds for two same-tool operations in one setup', async () => {
    const rough = twoMoveOp('rough', 'Rough')
    const finish = {
      ...twoMoveOp('finish', 'Finish'),
      feedrateOverride: makeOverride({ rpm: 8000 }),
    }
    const setup = makeSetup('s1', 'Front', 54, [rough, finish])
    const project = makeProject([setup])
    const res = postProject(project, [setup], UCCNC_CONFIG, baseOpts)
    expect(res.ok).toBe(true)
    const lines = res.combined!.gcode.trimEnd().split('\n')

    const roughSpeed = lines.indexOf('M3 S12000')
    const finishSpeed = lines.indexOf('M3 S8000')
    const finishComment = lines.indexOf('( Finish )')
    const finishCut = lines.findIndex((line, index) => index > finishSpeed && line.includes('X30'))
    expect(roughSpeed).toBeGreaterThanOrEqual(0)
    expect(finishSpeed).toBeGreaterThan(finishComment)
    expect(finishCut).toBeGreaterThan(finishSpeed)
    await expect(res.combined!.gcode).toMatchFileSnapshot(
      '../evidence/WO-1277/two-speed-same-tool.nc',
    )
  })

  it('carries spindle state across combined setup sections', () => {
    const roughSetup = makeSetup('s1', 'Front', 54, [twoMoveOp('rough', 'Rough')])
    const finish = twoMoveOp('finish', 'Finish')
    finish.feedrateOverride = makeOverride({ rpm: 8000 })
    const finishSetup = makeSetup('s2', 'Back', 55, [finish])
    const setups = [roughSetup, finishSetup]
    const project = makeProject(setups)
    const res = postProject(project, setups, UCCNC_CONFIG, baseOpts)
    expect(res.ok).toBe(true)
    const lines = res.combined!.gcode.trimEnd().split('\n')

    const g55 = lines.indexOf('G55')
    const finishSpeed = lines.indexOf('M3 S8000')
    expect(finishSpeed).toBeGreaterThan(g55)
    expect(lines.filter((line) => line === 'M3 S12000')).toHaveLength(1)
    expect(lines.filter((line) => line === 'M3 S8000')).toHaveLength(1)
  })

  it('emits exactly ONE preamble, ONE M30, and a WCS select per setup IN ORDER', () => {
    const { project, setups } = twoSetupProject()
    const res = postProject(project, setups, UCCNC_CONFIG, baseOpts)
    expect(res.ok).toBe(true)
    const lines = res.combined!.gcode.trimEnd().split('\n')

    expect(countOf(lines, (l) => l === 'G90 G94 G17 G21 G64')).toBe(1)
    expect(countOf(lines, (l) => l === 'M30')).toBe(1)

    const wcsIdx = [lines.indexOf('G54'), lines.indexOf('G55')]
    expect(wcsIdx[0]).toBeGreaterThanOrEqual(0)
    expect(wcsIdx[1]).toBeGreaterThan(wcsIdx[0]) // G54 section precedes G55 section
    expect(countOf(lines, (l) => l === 'G54')).toBe(1)
    expect(countOf(lines, (l) => l === 'G55')).toBe(1)
  })

  it('emits a trailing retract between sections but NOT after the last', () => {
    const { project, setups } = twoSetupProject()
    const res = postProject(project, setups, UCCNC_CONFIG, baseOpts)
    const lines = res.combined!.gcode.trimEnd().split('\n')

    // Section safe Z is 5; the first section ends with a G0 Z5 retract, the
    // second section does NOT (the postamble's safe_z_only does that final lift).
    const g55Idx = lines.indexOf('G55')
    const retractIdx = lines.indexOf('G0 Z5')
    expect(retractIdx).toBeGreaterThanOrEqual(0)
    expect(retractIdx).toBeLessThan(g55Idx) // trailing retract is BEFORE the 2nd section

    // Exactly one mid-program trailing retract (n-1 = 1) plus the postamble's
    // own final safe-Z retract, plus (WO-2023) the Z-only lift before the
    // program's first XY travel = three total G0 Z5 lines.
    expect(lines[lines.indexOf('G0 X10 Y20 Z5') - 1]).toBe('G0 Z5')
    expect(lines[lines.lastIndexOf('G0 Z5', g55Idx) + 1]).toBe('( Back )')
    expect(countOf(lines, (l) => l === 'G0 Z5')).toBe(3)
  })

  it('SAME-tool DEFAULT: no M5 between sections, setup 2 does NOT re-emit T#/M3, but its WCS IS present', () => {
    const { project, setups } = twoSetupProject()
    const res = postProject(project, setups, UCCNC_CONFIG, baseOpts)
    const lines = res.combined!.gcode.trimEnd().split('\n')

    expect(countOf(lines, (l) => l === 'M0')).toBe(0)
    // The only M5 is the postamble spindle-off (no mid-program stop, no tool change).
    expect(countOf(lines, (l) => l === 'M5')).toBe(1)

    // Setup 2's WCS select is present...
    const g55 = lines.indexOf('G55')
    expect(g55).toBeGreaterThanOrEqual(0)
    const section2 = lines.slice(g55)
    // ...but setup 2 re-emits NEITHER the tool word NOR a spindle-on (same tool,
    // spindle already running). T1 and M3 S#### appear ONCE total (setup 1 only).
    expect(section2.some((l) => l === 'T1')).toBe(false)
    expect(section2.some((l) => /^M3 S\d+/.test(l))).toBe(false)
    expect(countOf(lines, (l) => l === 'T1')).toBe(1)
    expect(countOf(lines, (l) => /^M3 S\d+/.test(l))).toBe(1)
  })

  it('DIFFERENT-tool DEFAULT: the boundary contains a REAL tool change (T2 M6), then a spindle restart', () => {
    const { project, setups } = twoSetupDiffToolProject()
    const res = postProject(project, setups, UCCNC_CONFIG, baseOpts)
    expect(res.ok).toBe(true)
    const lines = res.combined!.gcode.trimEnd().split('\n')

    // Setup 1 loads T1 (initial load: bare T1, no M6). Setup 2 must perform a
    // genuine tool change to T2 -- emitToolChange for UCCNC ('m6') emits 'T2 M6',
    // NOT a bare initial-load 'T2'. This is the safety assertion.
    expect(lines.some((l) => l === 'T2 M6')).toBe(true)
    expect(lines.some((l) => l === 'T2')).toBe(false) // never a bare initial load for T2

    const tcIdx = lines.indexOf('T2 M6')
    // Tool change is preceded by spindle-off + coolant-off + a safe-Z retract.
    const before = lines.slice(0, tcIdx)
    expect(before.includes('M5')).toBe(true)
    // After the change the spindle is restarted before any cut.
    const after = lines.slice(tcIdx)
    expect(after.some((l) => /^M3 S\d+/.test(l))).toBe(true)
    // Setup 2's WCS is re-asserted as part of the change ceremony.
    expect(after.includes('G55')).toBe(true)
  })

  it('SAME-tool + pauseBetweenSetups: M5 then M0 at the boundary, then an M3 restart before setup 2 cuts', () => {
    const { project, setups } = twoSetupProject()
    const res = postProject(project, setups, UCCNC_CONFIG, { ...baseOpts, pauseBetweenSetups: true })
    const lines = res.combined!.gcode.trimEnd().split('\n')

    const m0Indices = lines.map((l, i) => (l === 'M0' ? i : -1)).filter((i) => i >= 0)
    expect(m0Indices.length).toBe(setups.length - 1) // exactly one boundary pause

    const m0 = m0Indices[0]
    // The pause block stops the spindle (and coolant, which is on) before halting:
    // M5 ... M0. An M5 precedes the M0 (an M9 may sit between when coolant is on).
    const beforeM0 = lines.slice(0, m0)
    expect(beforeM0.lastIndexOf('M5')).toBeGreaterThanOrEqual(0)
    expect(lines[m0]).toBe('M0')
    // After the pause the spindle is restarted (M3 S####) BEFORE setup 2's cut.
    const after = lines.slice(m0 + 1)
    const m3After = after.findIndex((l) => /^M3 S\d+/.test(l))
    expect(m3After).toBeGreaterThanOrEqual(0)
    // The restart precedes setup 2's first feed move (X30 is the cut endpoint).
    const cutAfter = after.findIndex((l) => l.includes('X30'))
    expect(cutAfter).toBeGreaterThan(m3After)

    // Same tool -> NO tool change at the boundary.
    expect(after.some((l) => l === 'T1 M6')).toBe(false)
    // Still exactly one program end.
    expect(countOf(lines, (l) => l === 'M30')).toBe(1)
  })

  it('DIFFERENT-tool + pauseBetweenSetups: M0 AND a tool change (T2 M6) AND a spindle restart all present', () => {
    const { project, setups } = twoSetupDiffToolProject()
    const res = postProject(project, setups, UCCNC_CONFIG, { ...baseOpts, pauseBetweenSetups: true })
    expect(res.ok).toBe(true)
    const lines = res.combined!.gcode.trimEnd().split('\n')

    // The boundary pause M0 is present (note: UCCNC's M6 ceremony also emits an
    // M0, so assert on the tool-change token to disambiguate the real change).
    expect(lines.some((l) => l === 'M0')).toBe(true)
    expect(lines.some((l) => l === 'T2 M6')).toBe(true)
    // And the spindle is restarted after the change.
    const tcIdx = lines.indexOf('T2 M6')
    const after = lines.slice(tcIdx)
    expect(after.some((l) => /^M3 S\d+/.test(l))).toBe(true)
  })
})

// --- separate mode -----------------------------------------------------------

describe('postProject — separate mode', () => {
  it('returns N files with -G<nn>.<ext> names and standalone programs', () => {
    const { project, setups } = twoSetupProject()
    const res = postProject(project, setups, UCCNC_CONFIG, { ...baseOpts, mode: 'separate' })
    expect(res.ok).toBe(true)
    expect(res.files).toHaveLength(2)
    expect(res.files!.map((f) => f.filename)).toEqual(['part-G54.nc', 'part-G55.nc'])

    // Each file is a complete standalone program (own preamble + M30).
    for (const f of res.files!) {
      expect(f.result.ok).toBe(true)
      expect(f.result.gcode).toContain('G90 G94 G17 G21 G64')
      expect(f.result.gcode).toContain('M30')
    }
  })
})

// --- op selection + drop-empty + dup guard -----------------------------------

describe('postProject — selection, empty-drop, and fail-loud guard', () => {
  it('selectedOpIds filters operations to the kept set', () => {
    // Setup with two ops; keep only the second.
    const s1 = makeSetup('s1', 'Front', 54, [
      twoMoveOp('op-a', 'Profile A'),
      makeOp({
        id: 'op-b',
        name: 'Profile B',
        toolId: 't1',
        toolpathMoves: [move({ type: 'feed', x: 99, y: 99, z: 5, feed: 2000, role: 'cut' })],
      }),
    ])
    const project = makeProject([s1])
    const res = postProject(project, [s1], UCCNC_CONFIG, {
      ...baseOpts,
      selectedOpIds: { s1: ['op-b'] },
    })
    expect(res.ok).toBe(true)
    const g = res.combined!.gcode
    // Kept op's unique coordinate appears; dropped op's does not.
    expect(g).toContain('X99')
    expect(g).not.toContain('X10') // op-a's first rapid X
    expect(g).not.toContain('X30') // op-a's cut X
  })

  it('a setup filtered to ZERO ops is dropped (info diagnostic, no empty section)', () => {
    const s1 = makeSetup('s1', 'Front', 54, [twoMoveOp('op-a', 'Profile A')])
    const s2 = makeSetup('s2', 'Back', 55, [twoMoveOp('op-b', 'Profile B')])
    const project = makeProject([s1, s2])
    const res = postProject(project, [s1, s2], UCCNC_CONFIG, {
      ...baseOpts,
      selectedOpIds: { s2: [] }, // drop all of s2
    })
    expect(res.ok).toBe(true)
    const lines = res.combined!.gcode.trimEnd().split('\n')
    expect(lines).toContain('G54')
    expect(lines).not.toContain('G55') // dropped setup contributes no section
    expect(
      res.diagnostics.some((d) => d.code === 'SETUP_NO_OPS_SELECTED' && d.level === 'info'),
    ).toBe(true)
  })

  it('a selected setup with an OUTDATED op refuses to post (ok:false + OP_OUTDATED)', () => {
    // A stale op (e.g. a nest whose seed was edited flips its seed op to
    // 'outdated' -- confirmed) must block the whole run loud (ADR-0003). Status
    // is the sole signal here; nest staleness is just status==='outdated', so
    // this plain-outdated op proves the nest-seed case by equivalence.
    const stale = makeOp({
      id: 'op-stale',
      name: 'Stale Profile',
      status: 'outdated',
      toolId: 't1',
      toolpathMoves: [
        move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
        move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
      ],
    })
    const s1 = makeSetup('s1', 'Front', 54, [stale])
    const project = makeProject([s1])
    const res = postProject(project, [s1], UCCNC_CONFIG, baseOpts)
    expect(res.ok).toBe(false)
    const diag = res.diagnostics.find((d) => d.code === 'OP_OUTDATED')
    expect(diag).toBeDefined()
    expect(diag!.level).toBe('error')
    expect(diag!.opId).toBe('op-stale')
    expect(diag!.message).toContain('Stale Profile')
  })

  it('an OUTDATED op OUTSIDE the selection is ignored; only the selected ready op posts', () => {
    // Scope-limited: a stale op the user did NOT select must not block the run.
    const stale = makeOp({ id: 'op-stale', name: 'Stale', status: 'outdated', toolId: 't1' })
    const s1 = makeSetup('s1', 'Front', 54, [twoMoveOp('op-a', 'Profile A'), stale])
    const project = makeProject([s1])
    const res = postProject(project, [s1], UCCNC_CONFIG, {
      ...baseOpts,
      selectedOpIds: { s1: ['op-a'] }, // stale op not selected
    })
    expect(res.ok).toBe(true)
    expect(res.diagnostics.some((d) => d.code === 'OP_OUTDATED')).toBe(false)
  })

  it('a clean all-ready setup still posts ok (regression guard)', () => {
    const { project, setups } = twoSetupProject()
    const res = postProject(project, setups, UCCNC_CONFIG, baseOpts)
    expect(res.ok).toBe(true)
    expect(res.diagnostics.some((d) => d.level === 'error')).toBe(false)
  })

  it('duplicate work offsets -> ok:false + DUPLICATE_WORK_OFFSET, no output', () => {
    const s1 = makeSetup('s1', 'Front', 54, [twoMoveOp('op-a', 'Profile A')])
    const s2 = makeSetup('s2', 'Back', 54, [twoMoveOp('op-b', 'Profile B')]) // SAME G54
    const project = makeProject([s1, s2])
    const res = postProject(project, [s1, s2], UCCNC_CONFIG, baseOpts)
    expect(res.ok).toBe(false)
    expect(res.combined).toBeUndefined()
    expect(res.files).toBeUndefined()
    expect(res.diagnostics.some((d) => d.code === 'DUPLICATE_WORK_OFFSET' && d.level === 'error')).toBe(
      true,
    )
  })
})

// --- ADR 0026: one stock per setup (SETUP_MULTI_STOCK) -----------------------

describe('postProject — one stock per setup (ADR 0026)', () => {
  it('a SELECTED multi-stock setup refuses to post (ok:false + SETUP_MULTI_STOCK)', () => {
    // One setup whose two ops cut geometry on two distinct stocks.
    const s1 = makeSetup('s1', 'Mixed', 54, [
      opForGeo('op-a', 'Profile A', 'geo-a'),
      opForGeo('op-b', 'Profile B', 'geo-b'),
    ])
    const project = makeProject([s1], {
      geometry: [geoOnStock('geo-a', 'stock-a'), geoOnStock('geo-b', 'stock-b')],
      stocks: [physStock('stock-a', 'Plate A'), physStock('stock-b', 'Plate B')],
    })
    const res = postProject(project, [s1], UCCNC_CONFIG, baseOpts)
    expect(res.ok).toBe(false)
    expect(res.combined).toBeUndefined()
    expect(res.files).toBeUndefined()
    const diag = res.diagnostics.find((d) => d.code === 'SETUP_MULTI_STOCK')
    expect(diag).toBeDefined()
    expect(diag!.level).toBe('error')
    expect(diag!.message).toMatch(/Mixed/)
    expect(diag!.message).toMatch(/Plate A/)
    expect(diag!.message).toMatch(/Plate B/)
  })

  it('a clean SINGLE-stock setup still posts ok', () => {
    const s1 = makeSetup('s1', 'Clean', 54, [
      opForGeo('op-a', 'Profile A', 'geo-a'),
      opForGeo('op-b', 'Profile B', 'geo-b'),
    ])
    const project = makeProject([s1], {
      geometry: [geoOnStock('geo-a', 'stock-a'), geoOnStock('geo-b', 'stock-a')],
      stocks: [physStock('stock-a', 'Plate A')],
    })
    const res = postProject(project, [s1], UCCNC_CONFIG, baseOpts)
    expect(res.ok).toBe(true)
    expect(res.diagnostics.some((d) => d.code === 'SETUP_MULTI_STOCK')).toBe(false)
  })

  it('a multi-stock setup that is NOT selected does not block the run', () => {
    // s1 is clean (one stock); s2 mixes stocks but is NOT passed to postProject.
    const s1 = makeSetup('s1', 'Clean', 54, [opForGeo('op-a', 'Profile A', 'geo-a')])
    const s2 = makeSetup('s2', 'Mixed', 55, [
      opForGeo('op-b', 'Profile B', 'geo-b'),
      opForGeo('op-c', 'Profile C', 'geo-c'),
    ])
    const project = makeProject([s1, s2], {
      geometry: [
        geoOnStock('geo-a', 'stock-a'),
        geoOnStock('geo-b', 'stock-a'),
        geoOnStock('geo-c', 'stock-b'),
      ],
      stocks: [physStock('stock-a', 'Plate A'), physStock('stock-b', 'Plate B')],
    })
    // Only s1 is selected for posting -> s2's mix must not block.
    const res = postProject(project, [s1], UCCNC_CONFIG, baseOpts)
    expect(res.ok).toBe(true)
    expect(res.diagnostics.some((d) => d.code === 'SETUP_MULTI_STOCK')).toBe(false)
  })
})

// -- model-reference session verification (CAM-BINDING Stage 5, RISK 2) ------
// The load-boundary rehydration gap's postprocessor-side closure: postProject
// itself REFUSES an op carrying a ModelReference until the caller confirms
// (via options.modelRefsVerifiedSinceLoad) a real resolve pass ran this
// session - the "false-healthy-after-load" regression this gate exists to
// prevent (a stale-but-unflagged 'ready' op must NOT silently post).

function opWithBoundary(id: string, name: string): Operation {
  return makeOp({
    id, name, toolId: 't1',
    modelReferences: [{ bodyId: 'F1', stableIds: ['F1:face-1'], role: 'machining-boundary' }],
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}

describe('postProject — model-reference session verification (CAM-BINDING Stage 5)', () => {
  it('validates only model-bound operations in the effective emitted set', () => {
    const enabled = twoMoveOp('op-enabled', 'Enabled Profile')
    const modelBound = opWithBoundary('op-model', 'Model Boundary')
    modelBound.enabled = false
    const s1 = makeSetup('s1', 'Front', 54, [enabled, modelBound])
    const project = makeProject([s1])
    const unverified = { ...baseOpts, modelRefsVerifiedSinceLoad: false }

    const defaultExport = postProject(project, [s1], UCCNC_CONFIG, unverified)
    expect(defaultExport.ok).toBe(true)
    expect(defaultExport.diagnostics.some((d) => d.code === 'OP_MODEL_REFS_UNVERIFIED')).toBe(false)

    modelBound.enabled = true
    const selectedExport = postProject(project, [s1], UCCNC_CONFIG, {
      ...unverified,
      selectedOpIds: { s1: [modelBound.id] },
    })
    expect(selectedExport.ok).toBe(false)
    expect(selectedExport.diagnostics).toContainEqual(expect.objectContaining({
      code: 'OP_MODEL_REFS_UNVERIFIED',
      opId: modelBound.id,
    }))
  })

  it('a "ready" face-bound op posts fine when the session already verified (default byte-compatible behavior)', () => {
    const s1 = makeSetup('s1', 'Front', 54, [opWithBoundary('op-a', 'Boundary Op')])
    const project = makeProject([s1])
    const res = postProject(project, [s1], UCCNC_CONFIG, baseOpts) // no modelRefsVerifiedSinceLoad -> defaults true
    expect(res.ok).toBe(true)
  })

  // THE REGRESSION THIS GATE EXISTS TO PREVENT: a project loaded from disk
  // whose op is STILL marked 'ready' (its saved status, never re-verified)
  // must be REFUSED, not silently posted as if it were confirmed current.
  it('a "ready" face-bound op REFUSES to post when the session has NOT verified it yet - false-healthy-after-load', () => {
    const s1 = makeSetup('s1', 'Front', 54, [opWithBoundary('op-a', 'Boundary Op')])
    const project = makeProject([s1])
    const res = postProject(project, [s1], UCCNC_CONFIG, { ...baseOpts, modelRefsVerifiedSinceLoad: false })
    expect(res.ok).toBe(false)
    expect(res.diagnostics.some((d) => d.code === 'OP_MODEL_REFS_UNVERIFIED')).toBe(true)
  })

  it('once verified (Model tab opened, a real resolve pass ran), the SAME op posts fine', () => {
    const s1 = makeSetup('s1', 'Front', 54, [opWithBoundary('op-a', 'Boundary Op')])
    const project = makeProject([s1])
    const res = postProject(project, [s1], UCCNC_CONFIG, { ...baseOpts, modelRefsVerifiedSinceLoad: true })
    expect(res.ok).toBe(true)
  })

  it('an unverified session does NOT block a project with no model-bound ops at all', () => {
    const { project, setups } = twoSetupProject() // ordinary ops, no modelReferences
    const res = postProject(project, setups, UCCNC_CONFIG, { ...baseOpts, modelRefsVerifiedSinceLoad: false })
    expect(res.ok).toBe(true)
  })
})

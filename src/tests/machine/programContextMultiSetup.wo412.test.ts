// WO-412: the travelling program card carries several setups (V2).
//
// Proves: a combined export of 2 and 3 setups (mixed WCS, different stock per
// setup) writes ONE v=2 block that round-trips to the same version-2 context a
// direct build produces, through the real boundary; off = byte identity; the
// one-setup export is still the V1 block; a V1 reader refuses V2 with the
// contract's existing sentence and a V2 reader accepts V1; every guard still
// refuses what it refused (WO-397 foreign span, hand-labelled provenance,
// V1-with-setups, V2-without-setups, an operation naming no listed setup, a
// disagreeing fingerprint); the comparison is per setup (one stale setup does
// not hide the others); progress names setup + operation and follows the
// active setup; the Control chip reads "Setup: A -> B (G54, G55)".

import { describe, it, expect } from 'vitest'
import {
  buildMultiSetupProgramContext,
  buildProgramContext,
  buildProgramContextForSetups,
  compareProgramContext,
  compareProgramContextPerSetup,
  computeMotionDigest,
  deriveOperationProgress,
  describeOperationAtProgress,
  freezeProgramContext,
  isMultiSetupProgramContext,
  multiSetupProjectFingerprint,
  programContextSetupChipLabel,
  programContextSetups,
  setupAtSourceLine,
  transferCheckJobFromProgram,
  validateEmittedOperationSpansForSetups,
  type ProgramContextV1,
  type ProgramContextV2,
} from '../../lib/machine/programContext'
import {
  postProject,
  GRBL_CONFIG,
  LINUXCNC_CONFIG,
  UCCNC_CONFIG,
  BUILT_IN_DIALECTS,
  PROGRAM_CONTEXT_ENVELOPE_LIMITS,
  decodeProgramContextEnvelope,
  encodeProgramContextEnvelope,
  importProgramContextFromGcode,
  type PostConfig,
  type PostProjectOptions,
} from '../../lib/post'
import { prepareProgram } from '../../lib/gcode/text'
import { useMachineControl } from '../../store/machineControlStore'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from '../post/helpers'
import type { Operation, Project, Setup, Stock } from '../../types'

// ---- fixtures ---------------------------------------------------------------

function makeStock(width = 100, height = 20): Stock {
  return { type: 'rectangular', width, depth: 100, height, origin: { x: 0, y: 0, z: 0 }, material: 'aluminum' } as unknown as Stock
}
function twoMoveOp(id: string, name: string, toolId = 't1', x = 30): Operation {
  return makeOp({
    id, name, toolId,
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}
function makeSetup(id: string, name: string, fixtureOffset: number, ops: Operation[], notes: string, stockWidth = 100): Setup {
  return {
    id, name,
    wcs: makeWcs({ id: `wcs-${id}`, label: `G${fixtureOffset}`, fixtureOffset }),
    stock: makeStock(stockWidth),
    operations: ops,
    notes,
  }
}
function makeProject(setups: Setup[]): Project {
  const project: Project = {
    id: 'p-multi', name: 'Multi Part', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })],
    geometry: [], setups, activeSetupId: setups[0].id, activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  }
  for (const setup of setups) {
    for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary.find((t) => t.id === op.toolId)!)
  }
  return project
}
/** Two setups, G54 + G55, different stock widths, different notes. */
function twoSetupProject(): Project {
  return makeProject([
    makeSetup('s1', 'Top', 54, [twoMoveOp('opA', 'Face top'), twoMoveOp('opB', 'Pocket', 't2', 35)], 'Clamp on the left.', 100),
    makeSetup('s2', 'Bottom', 55, [twoMoveOp('opC', 'Face bottom', 't1', 40)], 'Flip on the pins.', 80),
  ])
}
/** Three setups with MIXED work offsets (G54, G57, G55 - not ascending) and three stocks. */
function threeSetupProject(): Project {
  return makeProject([
    makeSetup('s1', 'Top', 54, [twoMoveOp('opA', 'Face top')], 'Clamp on the left.', 100),
    makeSetup('s2', 'Side', 57, [twoMoveOp('opB', 'Drill side', 't2', 33), twoMoveOp('opC', 'Chamfer side', 't2', 36)], 'Vise jaw B.', 60),
    makeSetup('s3', 'Bottom', 55, [twoMoveOp('opD', 'Face bottom', 't1', 40)], 'Flip on the pins.', 80),
  ])
}
const OPTS: PostProjectOptions = { mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc' }
const CERTIFIED: PostConfig[] = [GRBL_CONFIG, UCCNC_CONFIG, LINUXCNC_CONFIG]

function blockLines(gcode: string): string[] {
  return gcode.split('\n').filter((l) => /LCX1/.test(l))
}
function nonBlockGcode(gcode: string): string {
  return gcode.split('\n').filter((l) => !/LCX1/.test(l)).join('\n')
}
function strip(ctx: ProgramContextV1): Omit<ProgramContextV1, 'source' | 'generatedAt'> {
  const { source: _s, generatedAt: _g, ...rest } = ctx
  return rest
}
function exportBoth(project: Project, config: PostConfig) {
  const plain = postProject(project, project.setups, config, OPTS).combined!
  const exported = postProject(project, project.setups, config, { ...OPTS, programContext: true }).combined!
  const direct = buildMultiSetupProgramContext(project, project.setups, config, plain.gcode, plain.operationSpans!)
  const imported = importProgramContextFromGcode(exported.gcode)
  return { plain, exported, direct, imported }
}

// ---------------------------------------------------------------------------

describe('WO-412: toggle off is byte identity; one setup is still the V1 block', () => {
  it('off / omitted = the historical output for 2 and 3 setups on every built-in post', () => {
    for (const config of BUILT_IN_DIALECTS) {
      for (const project of [twoSetupProject(), threeSetupProject()]) {
        const plain = postProject(project, project.setups, config, OPTS)
        const off = postProject(project, project.setups, config, { ...OPTS, programContext: false })
        expect(plain.ok).toBe(true)
        expect(off.combined!.gcode).toBe(plain.combined!.gcode)
        expect(plain.combined!.programContextEnvelope).toBeUndefined()
        expect(off.combined!.programContextEnvelope).toBeUndefined()
        expect(blockLines(plain.combined!.gcode)).toEqual([])
      }
    }
  })

  it('on = the plain program followed by one v=2 block; every non-LCX1 line identical, the streamer sees the same lines', () => {
    for (const config of CERTIFIED) {
      for (const project of [twoSetupProject(), threeSetupProject()]) {
        const plain = postProject(project, project.setups, config, OPTS).combined!.gcode
        const on = postProject(project, project.setups, config, { ...OPTS, programContext: true }).combined!
        expect(on.programContextEnvelope).toMatchObject({ included: true, version: 2, setupCount: project.setups.length })
        expect(nonBlockGcode(on.gcode)).toBe(plain)
        expect(on.gcode.startsWith(plain)).toBe(true)
        const block = blockLines(on.gcode)
        expect(block[0]).toMatch(/LCX1 v=2 n=\d+ bytes=\d+/)
        expect(block.filter((l) => /LCX1 v=/.test(l)).length).toBe(1)
        const limit = 80
        for (const line of block) expect(line.length).toBeLessThanOrEqual(limit)
        const a = prepareProgram(plain)
        const b = prepareProgram(on.gcode)
        expect(b.lines.map((l) => l.text)).toEqual(a.lines.map((l) => l.text))
        expect(b.overlongLines).toEqual([])
      }
    }
  })

  it('a one-setup combined export still writes the V1 block (v=1, setup: {...}) - the WO-381 wire format is untouched', () => {
    const project = makeProject([makeSetup('s1', 'Only', 54, [twoMoveOp('opA', 'Face')], 'n')])
    const on = postProject(project, project.setups, GRBL_CONFIG, { ...OPTS, programContext: true }).combined!
    expect(blockLines(on.gcode)[0]).toMatch(/LCX1 v=1 /)
    expect(on.programContextEnvelope).toMatchObject({ included: true, version: 1, setupCount: 1 })
    const d = decodeProgramContextEnvelope(on.gcode)
    expect(d.ok && d.payload.version === 1 && Object.keys(d.payload).includes('setup')).toBe(true)
    expect(d.ok && d.context.version).toBe(1)
    expect(d.ok && d.context.setups).toBeUndefined()
  })

  it('separate mode still gives each file its own V1 block', () => {
    const project = threeSetupProject()
    const r = postProject(project, project.setups, UCCNC_CONFIG, { ...OPTS, mode: 'separate', programContext: true })
    expect(r.files!.map((f) => f.result.programContextEnvelope)).toEqual(
      project.setups.map(() => expect.objectContaining({ included: true, version: 1, setupCount: 1 })),
    )
  })

  it('a partial operation selection in ANY listed setup refuses the block (the card describes whole setups)', () => {
    const project = twoSetupProject()
    const r = postProject(project, project.setups, GRBL_CONFIG, { ...OPTS, programContext: true, selectedOpIds: { s1: ['opA'] } })
    expect(blockLines(r.combined!.gcode)).toEqual([])
    expect((r.combined!.programContextEnvelope as { reason: string }).reason).toMatch(/deselected/)
    expect(r.combined!.gcode).toBe(postProject(project, project.setups, GRBL_CONFIG, { ...OPTS, selectedOpIds: { s1: ['opA'] } }).combined!.gcode)
  })
})

describe('WO-412: round trip - 2 setups, 3 setups, mixed WCS', () => {
  for (const [label, factory] of [['2 setups (G54, G55)', twoSetupProject], ['3 setups, mixed WCS (G54, G57, G55)', threeSetupProject]] as const) {
    for (const config of CERTIFIED) {
      it(`${label} on ${config.id}: the block decodes to the same version-2 context a direct build produces, and imports frozen as verified-export`, () => {
        const project = factory()
        const { plain, exported, direct, imported } = exportBoth(project, config)
        expect(direct.version).toBe(2)
        expect(isMultiSetupProgramContext(direct)).toBe(true)
        expect(direct.setups.map((s) => s.setup.id)).toEqual(project.setups.map((s) => s.id))
        expect(direct.setups.map((s) => s.wcs.fixtureOffset)).toEqual(project.setups.map((s) => s.wcs.fixtureOffset))
        expect(direct.setups.map((s) => s.notes)).toEqual(project.setups.map((s) => s.notes))
        // Every setup has its own stock snapshot (different widths) and its own fingerprint.
        expect(new Set(direct.setups.map((s) => s.stock.fingerprint)).size).toBe(project.setups.length)
        expect(new Set(direct.setups.map((s) => s.projectFingerprint)).size).toBe(project.setups.length)
        expect(direct.projectFingerprint).toBe(multiSetupProjectFingerprint(direct.setups.map((s) => s.projectFingerprint)))
        // Every emitted span is an operation naming its setup, in order, grouped by setup.
        expect(direct.operations.map((o) => [o.id, o.setupId, o.startLine, o.endLine]))
          .toEqual(plain.operationSpans!.map((s) => [s.opId, s.setupId, s.startLine, s.endLine]))
        // The lead setup is mirrored at the top level for one-setup readers.
        expect(direct.setup).toEqual(direct.setups[0].setup)
        expect(direct.wcs).toEqual(direct.setups[0].wcs)
        expect(direct.stock).toEqual(direct.setups[0].stock)

        const decoded = decodeProgramContextEnvelope(exported.gcode)
        expect(decoded.ok).toBe(true)
        if (!decoded.ok) return
        expect(decoded.payload.version).toBe(2)
        expect(strip(decoded.context)).toEqual(strip(direct))
        expect(decoded.context.motionDigest).toBe(computeMotionDigest(plain.gcode))

        expect(imported.warning).toBeNull()
        expect(imported.context?.source).toBe('verified-export')
        expect(imported.context?.version).toBe(2)
        expect(Object.isFrozen(imported.context)).toBe(true)
        expect(Object.isFrozen(imported.context!.setups)).toBe(true)
        expect(strip(imported.context!)).toEqual(strip(direct))
        expect(programContextSetupChipLabel(imported.context!)).toBe(
          `Setup: ${project.setups.map((s) => s.name).join(' -> ')} (${project.setups.map((s) => s.wcs.label).join(', ')})`,
        )
      })
    }
  }

  it('parses the real context-bearing G54/G55 combined post into both frames', () => {
    const { exported, imported } = exportBoth(twoSetupProject(), GRBL_CONFIG)
    expect(imported.context?.version).toBe(2)

    const frames = new Set(transferCheckJobFromProgram(exported.gcode).moves
      .filter((move) => move.coordinateFrame === 'work')
      .map((move) => move.workCoordinateSystem))
    expect(frames).toEqual(new Set(['G54', 'G55']))
  })

  it('the V2 payload is compact: per-setup entries carry setup/wcs/stock/targetParts/operations/projectFingerprint and nothing else; no project body', () => {
    const { exported } = exportBoth(threeSetupProject(), GRBL_CONFIG)
    const d = decodeProgramContextEnvelope(exported.gcode)
    if (!d.ok || d.payload.version !== 2) throw new Error('fixture')
    expect(Object.keys(d.payload).sort()).toEqual(['generatedAt', 'motionDigest', 'post', 'project', 'projectFingerprint', 'schemaName', 'setups', 'units', 'version'])
    for (const entry of d.payload.setups) {
      expect(Object.keys(entry).sort()).toEqual(['operations', 'projectFingerprint', 'setup', 'stock', 'targetParts', 'wcs'])
      expect(Object.keys(entry.setup).sort()).toEqual(['id', 'name', 'notes'])
      for (const op of entry.operations) expect('setupId' in op).toBe(false)
    }
    expect(JSON.stringify(d.payload)).not.toMatch(/toolpathMoves|http|script|macro|<|>/)
  })

  it('binds through the real store boundary (setProgram) as a frozen verified-export V2 context; a tampered program is refused', () => {
    const { exported, imported } = exportBoth(twoSetupProject(), GRBL_CONFIG)
    useMachineControl.getState().setProgram('part.nc', exported.gcode, [], imported.context)
    const stored = useMachineControl.getState().programContext!
    expect(stored.version).toBe(2)
    expect(stored.setups!.map((s) => s.setup.name)).toEqual(['Top', 'Bottom'])
    expect(Object.isFrozen(stored)).toBe(true)
    expect(() => { (stored.setups as unknown as unknown[]).push({}) }).toThrow()
    expect(() => useMachineControl.getState().setProgram('bad.nc', exported.gcode.replace('X40', 'X41'), [], imported.context)).toThrow()
    useMachineControl.getState().setProgram('', '', [], null)
  })

  it('a direct build of the same combined program equals buildProgramContextForSetups (1 setup -> V1, several -> V2)', () => {
    const project = twoSetupProject()
    const plain = postProject(project, project.setups, GRBL_CONFIG, OPTS).combined!
    const viaFor = buildProgramContextForSetups(project, project.setups, GRBL_CONFIG, plain.gcode, plain.operationSpans!)
    expect(viaFor.version).toBe(2)
    const one = postProject(project, [project.setups[0]], GRBL_CONFIG, OPTS).combined!
    const oneCtx = buildProgramContextForSetups(project, [project.setups[0]], GRBL_CONFIG, one.gcode, one.operationSpans!)
    expect(oneCtx.version).toBe(1)
    expect(strip(oneCtx)).toEqual(strip(buildProgramContext(project, project.setups[0], GRBL_CONFIG, one.gcode, one.operationSpans!)))
    expect(() => buildProgramContextForSetups(project, [], GRBL_CONFIG, one.gcode, one.operationSpans!)).toThrow(/no setups/)
  })
})

describe('WO-412: V1 readers refuse V2 with the existing sentence; V2 readers accept V1', () => {
  it('a V1-only reader refuses a real v=2 block: "unknown LCX1 envelope version 2"; the program still loads', () => {
    const { exported } = exportBoth(twoSetupProject(), GRBL_CONFIG)
    const v1Only = decodeProgramContextEnvelope(exported.gcode, PROGRAM_CONTEXT_ENVELOPE_LIMITS, [1])
    expect(v1Only).toEqual({ ok: false, status: 'invalid', reason: 'unknown LCX1 envelope version 2' })
    expect(prepareProgram(exported.gcode).lines.length).toBeGreaterThan(0)
  })

  it('the V2 reader accepts a V1 block (a one-setup export) unchanged', () => {
    const project = makeProject([makeSetup('s1', 'Only', 54, [twoMoveOp('opA', 'Face')], 'n')])
    const exported = postProject(project, project.setups, GRBL_CONFIG, { ...OPTS, programContext: true }).combined!
    const d = decodeProgramContextEnvelope(exported.gcode) // default = [1, 2]
    expect(d.ok && d.payload.version).toBe(1)
    expect(importProgramContextFromGcode(exported.gcode).context?.setup.name).toBe('Only')
  })

  it('a v=2 header over a v=1 payload (or the reverse) is refused; an unknown version 3 is refused', () => {
    const { exported } = exportBoth(twoSetupProject(), GRBL_CONFIG)
    const relabelled = exported.gcode.replace('LCX1 v=2 ', 'LCX1 v=1 ')
    const d = decodeProgramContextEnvelope(relabelled)
    expect(d.ok === false && d.status === 'invalid' && d.reason).toMatch(/unknown LCX1 payload version 2/)
    const v3 = decodeProgramContextEnvelope(exported.gcode.replace('LCX1 v=2 ', 'LCX1 v=3 '))
    expect(v3.ok === false && v3.status === 'invalid' && v3.reason).toBe('unknown LCX1 envelope version 3')
  })
})

describe('WO-412: no guard is weakened', () => {
  function fixtures() {
    const project = twoSetupProject()
    const plain = postProject(project, project.setups, GRBL_CONFIG, OPTS).combined!
    const direct = buildMultiSetupProgramContext(project, project.setups, GRBL_CONFIG, plain.gcode, plain.operationSpans!)
    return { project, plain, direct }
  }

  it('buildProgramContext (one setup) still refuses a span owned by another setup with the WO-397 sentence', () => {
    const { project, plain } = fixtures()
    const own = plain.operationSpans!.filter((s) => s.setupId === 's1')
    const relabelled = own.map((s, i) => (i === 0 ? { ...s, setupId: 's2' } : s))
    expect(() => buildProgramContext(project, project.setups[0], GRBL_CONFIG, plain.gcode, relabelled))
      .toThrow(/owned by setup 's2' in context 's1'.*exactly ONE setup.*not supported \(WO-397\)/)
    // And the whole combined span list (it holds setup 2's operations) is refused too.
    expect(() => buildProgramContext(project, project.setups[0], GRBL_CONFIG, plain.gcode, plain.operationSpans!)).toThrow(/Refusing an emitted span/)
  })

  it('the multi-setup span check accepts spans from every listed setup and refuses any other, by name', () => {
    const { project, plain } = fixtures()
    const spans = plain.operationSpans!
    expect(validateEmittedOperationSpansForSetups(plain.gcode, project.setups, spans)).toBe(spans)
    const foreign = spans.map((s, i) => (i === 0 ? { ...s, setupId: 'setup-Z' } : s))
    expect(() => validateEmittedOperationSpansForSetups(plain.gcode, project.setups, foreign))
      .toThrow(/owned by setup 'setup-Z'.*binds only the setups 's1', 's2'/)
    expect(() => buildMultiSetupProgramContext(project, project.setups, GRBL_CONFIG, plain.gcode, foreign)).toThrow(/owned by setup 'setup-Z'/)
    // A listed setup that emitted nothing is refused; so is a list of fewer than two.
    expect(() => validateEmittedOperationSpansForSetups(plain.gcode, project.setups, spans.filter((s) => s.setupId === 's1')))
      .toThrow(/every listed setup must own at least one span/)
    expect(() => buildMultiSetupProgramContext(project, [project.setups[0]], GRBL_CONFIG, plain.gcode, spans)).toThrow(/fewer than two setups/)
    // Disabled / unknown operation, overlapping lines, non-executable span: unchanged refusals.
    expect(() => validateEmittedOperationSpansForSetups(plain.gcode, project.setups, [{ ...spans[0], opId: 'nope' }, ...spans.slice(1)])).toThrow(/unknown or disabled operation 'nope'/)
    expect(() => validateEmittedOperationSpansForSetups(plain.gcode, project.setups, [spans[0], { ...spans[1], startLine: spans[0].startLine }, ...spans.slice(2)])).toThrow(/invalid or overlapping/)
    expect(() => validateEmittedOperationSpansForSetups(plain.gcode, project.setups, [])).toThrow(/without emitted operation spans/)
  })

  it('freezeProgramContext refuses V1-with-setups, V2-without-setups, an operation naming no listed setup, a disagreeing fingerprint, a hand-labelled verified-export, and an unknown version', () => {
    const { direct } = fixtures()
    const mutable = JSON.parse(JSON.stringify(direct)) as ProgramContextV2
    expect(freezeProgramContext(mutable)!.version).toBe(2)
    expect(() => freezeProgramContext({ ...mutable, version: 1 } as unknown as ProgramContextV1)).toThrow(/version-1.*setup list/)
    expect(() => freezeProgramContext({ ...mutable, setups: undefined } as unknown as ProgramContextV1)).toThrow(/version 2 must list its setups/)
    expect(() => freezeProgramContext({ ...mutable, setups: [] } as unknown as ProgramContextV1)).toThrow(/version 2 must list its setups/)
    expect(() => freezeProgramContext({ ...mutable, version: 3 } as unknown as ProgramContextV1)).toThrow(/invalid program-context snapshot/)
    expect(() => freezeProgramContext({ ...mutable, source: 'verified-export' })).toThrow(/invalid program-context snapshot/)
    expect(() => freezeProgramContext({ ...mutable, source: 'foreign' })).toThrow(/invalid program-context snapshot/)
    const orphan = { ...mutable, operations: mutable.operations.map((o, i) => (i === 0 ? { ...o, setupId: 'ghost' } : o)) }
    expect(() => freezeProgramContext(orphan)).toThrow(/names no listed setup/)
    const unstamped = { ...mutable, operations: mutable.operations.map(({ setupId: _s, ...o }) => o) }
    expect(() => freezeProgramContext(unstamped as unknown as ProgramContextV1)).toThrow(/names no listed setup/)
    const badFp = { ...mutable, projectFingerprint: mutable.setups[0].projectFingerprint }
    expect(() => freezeProgramContext(badFp)).toThrow(/project fingerprint disagrees/)
    const twice = { ...mutable, setups: [mutable.setups[0], mutable.setups[0]], projectFingerprint: multiSetupProjectFingerprint([mutable.setups[0].projectFingerprint, mutable.setups[0].projectFingerprint]) }
    expect(() => freezeProgramContext(twice)).toThrow(/same setup twice/)
    const ungrouped = { ...mutable, operations: [mutable.operations[0], mutable.operations[2], mutable.operations[1]].map((o, i) => ({ ...o, startLine: 10 + i * 2, endLine: 11 + i * 2 })) }
    expect(() => freezeProgramContext(ungrouped)).toThrow(/not grouped in the listed setup order/)
    const wrongLead = { ...mutable, setup: mutable.setups[1].setup }
    expect(() => freezeProgramContext(wrongLead)).toThrow(/lead setup disagrees/)
    // A V1 context from buildProgramContext is accepted exactly as before.
    const project = makeProject([makeSetup('s1', 'Only', 54, [twoMoveOp('opA', 'Face')], 'n')])
    const one = postProject(project, project.setups, GRBL_CONFIG, OPTS).combined!
    const v1 = buildProgramContext(project, project.setups[0], GRBL_CONFIG, one.gcode, one.operationSpans!)
    expect(freezeProgramContext(v1)!.version).toBe(1)
    expect(programContextSetups(v1)).toHaveLength(1)
  })

  it('the emit side refuses a V2 payload over any parser limit (notes over 4 KiB in the second setup)', () => {
    const { direct } = fixtures()
    const big = JSON.parse(JSON.stringify(direct)) as ProgramContextV2
    const setups = big.setups.map((s, i) => (i === 1 ? { ...s, notes: 'n'.repeat(5000) } : s))
    const r = encodeProgramContextEnvelope({ ...big, setups }, GRBL_CONFIG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/string longer than 4096/)
  })
})

describe('WO-412: the comparison is per setup; progress names setup + operation', () => {
  it('all current; edit setup 2 -> setup 2 stale while setup 1 stays current, program verdict project-changed; motion drift -> every setup program-changed', () => {
    const project = threeSetupProject()
    const { plain, exported, direct, imported } = exportBoth(project, GRBL_CONFIG)
    const ctx = imported.context!
    expect(compareProgramContext(direct, project, plain.gcode, GRBL_CONFIG)).toBe('current')
    expect(compareProgramContext(ctx, project, exported.gcode, GRBL_CONFIG)).toBe('current')
    expect(compareProgramContextPerSetup(ctx, project, exported.gcode, GRBL_CONFIG).map((v) => [v.setup.name, v.wcsLabel, v.verdict]))
      .toEqual([['Top', 'G54', 'current'], ['Side', 'G57', 'current'], ['Bottom', 'G55', 'current']])

    const edited: Project = { ...project, setups: project.setups.map((s) => (s.id === 's2' ? { ...s, notes: 'Vise jaw C.' } : s)) }
    expect(compareProgramContext(ctx, edited, exported.gcode, GRBL_CONFIG)).toBe('project-changed')
    expect(compareProgramContextPerSetup(ctx, edited, exported.gcode, GRBL_CONFIG).map((v) => v.verdict))
      .toEqual(['current', 'project-changed', 'current'])

    const removed: Project = { ...project, setups: project.setups.filter((s) => s.id !== 's3') }
    expect(compareProgramContextPerSetup(ctx, removed, exported.gcode, GRBL_CONFIG).map((v) => v.verdict))
      .toEqual(['current', 'current', 'project-changed'])

    const drifted = exported.gcode.replace('X40', 'X41')
    expect(compareProgramContext(ctx, project, drifted, GRBL_CONFIG)).toBe('program-changed')
    expect(compareProgramContextPerSetup(ctx, project, drifted, GRBL_CONFIG).map((v) => v.verdict))
      .toEqual(['program-changed', 'program-changed', 'program-changed'])
    const other: Project = { ...project, id: 'someone-else' }
    expect(compareProgramContextPerSetup(ctx, other, exported.gcode, GRBL_CONFIG).map((v) => v.verdict))
      .toEqual(['project-changed', 'project-changed', 'project-changed'])
    expect(compareProgramContextPerSetup(null, project, exported.gcode, GRBL_CONFIG)).toEqual([])
  })

  it('a one-setup (V1) context has exactly one per-setup verdict, equal to the program verdict', () => {
    const project = makeProject([makeSetup('s1', 'Only', 54, [twoMoveOp('opA', 'Face')], 'n')])
    const plain = postProject(project, project.setups, GRBL_CONFIG, OPTS).combined!
    const v1 = buildProgramContext(project, project.setups[0], GRBL_CONFIG, plain.gcode, plain.operationSpans!)
    expect(compareProgramContextPerSetup(v1, project, plain.gcode, GRBL_CONFIG)).toEqual([{ setup: { id: 's1', name: 'Only' }, wcsLabel: 'G54', verdict: 'current' }])
    expect(programContextSetupChipLabel(v1)).toBe('Setup: Only (G54)')
  })

  it('progress names the setup and the operation, and the active setup follows the cursor; setupAtSourceLine agrees', () => {
    const project = threeSetupProject()
    const { plain, direct } = exportBoth(project, GRBL_CONFIG)
    const text = plain.gcode
    const ops = direct.operations
    expect(ops.map((o) => o.setupId)).toEqual(['s1', 's2', 's2', 's3'])
    const armed = deriveOperationProgress(direct, text, { phase: 'ready', ackedSourceLine: 0 })!
    expect(armed.headline).toBe('Next: Top: Face top (2D contour), operation 1 of 4')
    expect(armed.activeSetup?.setup.name).toBe('Top')
    expect(armed.entries.map((e) => e.setup?.name)).toEqual(['Top', 'Side', 'Side', 'Bottom'])
    const inSide = deriveOperationProgress(direct, text, { phase: 'streaming', ackedSourceLine: armed.entries[1].firstExecutableLine })!
    expect(inSide.headline).toBe('Running Side: Drill side (2D contour), operation 2 of 4')
    expect(inSide.activeSetup?.setup.name).toBe('Side')
    expect(inSide.activeSetup?.wcs.label).toBe('G57')
    expect(setupAtSourceLine(direct, ops[1].startLine)?.setup.id).toBe('s2')
    expect(setupAtSourceLine(direct, ops[3].endLine)?.setup.id).toBe('s3')
    expect(setupAtSourceLine(direct, 1)).toBeNull()
    const held = deriveOperationProgress(direct, text, { phase: 'paused', ackedSourceLine: armed.entries[3].firstExecutableLine })!
    expect(held.headline).toBe('Held in Bottom: Face bottom (2D contour), operation 4 of 4')
    expect(describeOperationAtProgress(direct, text, { phase: 'streaming', ackedSourceLine: armed.entries[3].firstExecutableLine })).toBe('Bottom: Face bottom (2D contour), operation 4 of 4')
    const done = deriveOperationProgress(direct, text, { phase: 'complete', ackedSourceLine: armed.entries[3].lastExecutableLine })!
    expect(done.headline).toBe('All 4 operations complete')
    expect(done.activeSetup?.setup.name).toBe('Bottom')
    // A V1 context is unchanged: no setup prefix, entries carry setup null.
    const one = makeProject([makeSetup('s1', 'Only', 54, [twoMoveOp('opA', 'Face')], 'n')])
    const onePlain = postProject(one, one.setups, GRBL_CONFIG, OPTS).combined!
    const v1 = buildProgramContext(one, one.setups[0], GRBL_CONFIG, onePlain.gcode, onePlain.operationSpans!)
    const p1 = deriveOperationProgress(v1, onePlain.gcode, { phase: 'ready', ackedSourceLine: 0 })!
    expect(p1.headline).toBe('Next: Face (2D contour), operation 1 of 1')
    expect(p1.entries[0].setup).toBeNull()
    expect(p1.activeSetup?.setup.name).toBe('Only')
  })
})

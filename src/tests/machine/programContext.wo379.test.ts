import { describe, it, expect } from 'vitest'
import {
  buildProgramContext,
  compareProgramContext,
  programIntentIdentity,
  PROGRAM_INTENT_PROJECT_FIELDS,
  computeMotionDigest,
  freezeProgramContext,
  mintVerifiedExportContext,
  sha256Hex,
  PROGRAM_CONTEXT_SCHEMA,
  PROGRAM_CONTEXT_VERSION,
} from '../../lib/machine/programContext'
import {
  GRBL_CONFIG,
  UCCNC_CONFIG,
  postProgram,
  postCombined,
} from '../../lib/post'
import {
  makeMachine,
  makeOp,
  makeStock,
  makeTool,
  makeWcs,
  move,
} from '../post/helpers'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import type {
  ImportedGeometry,
  PhysicalStock,
  Project,
  Setup,
  ToolpathMove,
} from '../../types'
import type { PostInput, PostOperation } from '../../lib/post'

function makePhysicalStock(over: Partial<PhysicalStock> = {}): PhysicalStock {
  return {
    id: 'stock1',
    name: 'Stock 1',
    mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 100, y: 80, z: 20 },
      size: { x: 100, y: 80, z: 20 },
      center: { x: 50, y: 40, z: 10 },
    },
    position: { x: 0, y: 0, z: 0 },
    fixtureOffset: 54,
    ...over,
  }
}

function makeSetup(over: Partial<Setup> = {}): Setup {
  return {
    id: 'setup1',
    name: 'Setup 1',
    wcs: makeWcs({ fixtureOffset: 54, label: 'G54', stockId: 'stock1' }),
    stock: makeStock({ material: 'aluminum' }),
    operations: [
      makeOp({ id: 'op1', name: 'Face', type: 'face', generationFingerprint: 'gf-op1' }),
      makeOp({ id: 'op2', name: 'Pocket', type: 'pocket_2d', generationFingerprint: 'gf-op2' }),
    ],
    notes: 'Flip once before drilling.',
    ...over,
  }
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj1',
    name: 'Demo part',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })],
    geometry: [],
    setups: [makeSetup()],
    activeSetupId: 'setup1',
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    stocks: [makePhysicalStock()],
    notes: '',
    ...over,
  }
}

const GCODE = [
  '%',
  'G21 G90 G54',
  '(Demo part - posted from Setup 1)',
  '',
  'M3 S12000',
  'G0 X0 Y0',
  'G0 Z5',
  'G1 Z-2 F300 ; first plunge',
  'G1 X10 Y0 F800 (cut)',
  'G1 X10 Y10',
  'G0 Z5',
  'M5',
  'M30',
  '%',
].join('\n')

const SPANS = [
  { opId: 'op1', setupId: 'setup1', startLine: 3, endLine: 10 },
  { opId: 'op2', setupId: 'setup1', startLine: 11, endLine: 13 },
]

describe('WO-379: SHA-256 canonical motion identity', () => {
  it('implements FIPS 180-4 SHA-256 against known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    )
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    )
    expect(sha256Hex('LienCAM-\u2603-\u{1F680}')).toBe(
      '7b53220a5f6a03eb01ffc81d5132f5f580d323676dd88a5465b5cf4a9ddd82ef',
    )
  })

  it('identifies the algorithm in the stored value', () => {
    const digest = computeMotionDigest('G1 X10 F500')
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(digest).toBe(`sha256:${sha256Hex('G1 X10 F500')}`)
  })

  it('excludes blanks, percent markers, and both comment styles', () => {
    const clean = ['G21 G90 G54', 'G0 X0 Y0', 'G1 X10 F500', 'M5', 'M30'].join('\n')
    const messy = [
      '%',
      'G21 G90 G54',
      '',
      '   ',
      '(header comment)',
      '; another comment',
      'G0 X0 Y0',
      'G1 X10 F500 ; inline',
      '(between)',
      'M5',
      'M30',
      '%',
    ].join('\n')
    expect(computeMotionDigest(messy)).toBe(computeMotionDigest(clean))
  })

  it('is invariant to comment-only and whitespace-only changes', () => {
    expect(computeMotionDigest('G1 X10 Y0 F500 (roughing)')).toBe(
      computeMotionDigest('G1 X10 Y0 F500 (finishing)'),
    )
    expect(computeMotionDigest('G1 X10 Y0 F500 (x)')).toBe(computeMotionDigest('G1 X10 Y0 F500'))
  })

  it('changes when real executable motion changes', () => {
    expect(computeMotionDigest('G1 X10 Y0 F500')).not.toBe(computeMotionDigest('G1 X11 Y0 F500'))
    expect(computeMotionDigest('G1 X10 Y0 F500')).not.toBe(computeMotionDigest('G1 X10 Y0 F600'))
  })

  it('follows the real streamer comment rules for parentheses and semicolons', () => {
    expect(computeMotionDigest('G1 X10 (G0 Z-99)')).toBe(computeMotionDigest('G1 X10'))
    expect(computeMotionDigest('G1 X10 ; G0 Z-99')).toBe(computeMotionDigest('G1 X10'))
    expect(computeMotionDigest('(tool change T3)\nG1 X10')).toBe(computeMotionDigest('G1 X10'))
    expect(computeMotionDigest('; spindle on\nG1 X10')).toBe(computeMotionDigest('G1 X10'))
  })
})

describe('WO-379: emitted operation source-line spans come from the post pipeline', () => {
  function postOp(id: string, name: string, toolNumber: number, moves: ToolpathMove[]): PostOperation {
    const tool = makeTool({ id: `t${toolNumber}`, toolNumber, name: `T${toolNumber}` })
    return {
      op: makeOp({ id, name, status: 'ready', toolId: tool.id }),
      tool,
      feeds: resolveFeedrates(tool, undefined, 5000),
      spindle: { rpm: 12000, dir: 'cw' },
      coolant: 'none',
      moves,
    }
  }

  function postInput(ops: PostOperation[], setupId?: string): PostInput {
    return {
      machine: makeMachine(),
      setup: { wcs: makeWcs({ fixtureOffset: 54, label: 'G54' }), operations: ops },
      ...(setupId ? { setupId } : {}),
    }
  }

  const twoMoves = (x: number): ToolpathMove[] => [
    move({ type: 'rapid', x, y: 0, z: 5, role: 'rapid' }),
    move({ type: 'feed', x: x + 20, y: 0, z: 5, feed: 2000, role: 'cut' }),
  ]

  it('emits one ordered, non-overlapping span per operation in emitted order', () => {
    const result = postProgram(
      postInput([
        postOp('op-a', 'Profile A', 1, twoMoves(10)),
        postOp('op-b', 'Profile B', 1, twoMoves(50)),
      ], 'setup1'),
      GRBL_CONFIG,
    )
    expect(result.ok).toBe(true)
    const spans = result.operationSpans!
    expect(spans.map((s) => s.opId)).toEqual(['op-a', 'op-b'])
    expect(spans.every((s) => s.setupId === 'setup1')).toBe(true)

    const lines = result.gcode.split('\n')
    // Each span is a valid, non-empty, in-order, non-overlapping line range.
    for (let i = 0; i < spans.length; i++) {
      expect(spans[i].startLine).toBeGreaterThanOrEqual(1)
      expect(spans[i].startLine).toBeLessThanOrEqual(spans[i].endLine)
      expect(spans[i].endLine).toBeLessThanOrEqual(lines.length)
      if (i > 0) expect(spans[i].startLine).toBeGreaterThan(spans[i - 1].endLine)
    }
    // Each span actually covers its operation's distinguishing motion.
    const aSlice = lines.slice(spans[0].startLine - 1, spans[0].endLine).join('\n')
    const bSlice = lines.slice(spans[1].startLine - 1, spans[1].endLine).join('\n')
    expect(aSlice).toContain('X30') // op-a's cut endpoint
    expect(aSlice).not.toContain('X70') // op-b's cut endpoint is elsewhere
    expect(bSlice).toContain('X70')
  })

  it('reports reordered operations in the order they were emitted', () => {
    const result = postProgram(
      postInput([
        postOp('op-b', 'Profile B', 1, twoMoves(50)),
        postOp('op-a', 'Profile A', 1, twoMoves(10)),
      ]),
      GRBL_CONFIG,
    )
    expect(result.operationSpans!.map((s) => s.opId)).toEqual(['op-b', 'op-a'])
  })

  it('reports repeated sections (shared opId, e.g. nest expansion) as repeated spans', () => {
    const result = postProgram(
      postInput([
        postOp('op-seed', 'Nest Seed', 1, twoMoves(10)),
        postOp('op-seed', 'Nest Seed', 1, twoMoves(40)),
      ]),
      GRBL_CONFIG,
    )
    const spans = result.operationSpans!
    expect(spans.map((s) => s.opId)).toEqual(['op-seed', 'op-seed'])
    expect(spans[1].startLine).toBeGreaterThan(spans[0].endLine)
  })

  it('omitted operations (not in the input) have no span', () => {
    const result = postProgram(postInput([postOp('op-a', 'Profile A', 1, twoMoves(10))]), GRBL_CONFIG)
    expect(result.operationSpans!.map((s) => s.opId)).toEqual(['op-a'])
  })

  it('combined mode labels each span with its owning setup and spans all sections', () => {
    const result = postCombined(
      [
        postInput([postOp('op-a', 'Profile A', 1, twoMoves(10))], 'setup1'),
        postInput([postOp('op-b', 'Profile B', 2, twoMoves(50))], 'setup2'),
      ],
      GRBL_CONFIG,
      { pauseBetweenSetups: false },
    )
    expect(result.ok).toBe(true)
    const spans = result.operationSpans!
    expect(spans.map((s) => [s.opId, s.setupId])).toEqual([
      ['op-a', 'setup1'],
      ['op-b', 'setup2'],
    ])
    // The two sections do not overlap and are ordered.
    expect(spans[1].startLine).toBeGreaterThan(spans[0].endLine)
  })
})

describe('WO-379: buildProgramContext from a direct setup load', () => {
  it('creates a versioned, live-setup ProgramContextV1 with every required field', () => {
    const project = makeProject()
    const ctx = buildProgramContext(project, project.setups[0], GRBL_CONFIG, GCODE, SPANS)

    expect(ctx.version).toBe(1)
    expect(PROGRAM_CONTEXT_VERSION).toBe(1)
    expect(ctx.schemaName).toBe(PROGRAM_CONTEXT_SCHEMA)
    expect(ctx.source).toBe('live-setup')
    expect(ctx.project).toEqual({ id: 'proj1', name: 'Demo part' })
    expect(ctx.setup).toEqual({ id: 'setup1', name: 'Setup 1' })
    expect(ctx.units).toBe(GRBL_CONFIG.format.units)
    expect(ctx.wcs.label).toBe('G54')
    expect(ctx.wcs.fixtureOffset).toBe(54)
    expect(ctx.wcs.origin).toEqual({ x: 0, y: 0, z: 0 })
    expect(ctx.notes).toBe('Flip once before drilling.')
    expect(ctx.post).toEqual({ id: GRBL_CONFIG.id, label: GRBL_CONFIG.label })
    expect(ctx.motionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(ctx.projectFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(typeof ctx.generatedAt).toBe('number')
  })

  it('binds the exact stock snapshot, WCS, emitted operations, post, and G-code', () => {
    const project = makeProject()
    const ctx = buildProgramContext(project, project.setups[0], GRBL_CONFIG, GCODE, SPANS)

    expect(ctx.stock).not.toBeNull()
    expect(ctx.stock?.id).toBe('stock1')
    expect(ctx.stock?.name).toBe('Stock 1')
    expect(ctx.stock?.mode).toBe('explicit')
    expect(ctx.stock?.material).toBe('aluminum')
    expect(ctx.stock?.bounds.max).toEqual({ x: 100, y: 80, z: 20 })
    expect(ctx.stock?.fixtureOffset).toBe(54)
    expect(ctx.stock.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)

    // Operations are the EMITTED set (from spans), in emitted order, with spans.
    expect(ctx.operations.map((o) => o.id)).toEqual(['op1', 'op2'])
    expect(ctx.operations.map((o) => o.name)).toEqual(['Face', 'Pocket'])
    expect(ctx.operations.map((o) => [o.startLine, o.endLine])).toEqual([
      [3, 10],
      [11, 13],
    ])
    expect(ctx.operations[0].tool).toMatchObject({
      id: 't1', name: 'Test Tool', toolNumber: 1, type: 'flat_end_mill', diameter: 6,
    })
    expect(ctx.motionDigest).toBe(computeMotionDigest(GCODE))
  })

  it('falls back to authored stock and captures a compact target-part proxy', () => {
    const target: ImportedGeometry = {
      id: 'part1',
      name: 'Target part',
      filename: 'target.stl',
      type: 'mesh',
      format: 'stl',
      boundingBox: {
        min: { x: 1, y: 2, z: 3 }, max: { x: 11, y: 12, z: 8 },
        size: { x: 10, y: 10, z: 5 }, center: { x: 6, y: 7, z: 5.5 },
      },
      position: { x: 4, y: 5, z: 6 },
      rotation: { x: 0, y: 0, z: 90 },
      loaded: true,
      stockId: 'stock1',
    }
    delete target.stockId
    const setup = makeSetup({
      wcs: makeWcs({ fixtureOffset: 54, label: 'G54', stockId: undefined }),
    })
    const project = makeProject({ stocks: [], geometry: [target], setups: [setup] })
    const ctx = buildProgramContext(project, project.setups[0], GRBL_CONFIG, GCODE, SPANS)

    expect(ctx.stock.provenance).toBe('authored')
    expect(ctx.stock.coordinateSpace).toBe('setup-wcs')
    expect(ctx.stock.bounds.max).toEqual({ x: 100, y: 80, z: 20 })
    expect(ctx.targetParts).toEqual([{
      id: 'part1', name: 'Target part', format: 'stl',
      bounds: { min: { x: 1, y: 2, z: 3 }, max: { x: 11, y: 12, z: 8 } },
      position: { x: 4, y: 5, z: 6 }, rotation: { x: 0, y: 0, z: 90 },
    }])
  })

  it('refuses spans that do not exactly match the post-resolved emitted sections', () => {
    const project = makeProject()
    expect(() => buildProgramContext(project, project.setups[0], GRBL_CONFIG, GCODE, [
      { opId: 'op2', setupId: 'setup1', startLine: 1, endLine: 4 },
    ])).toThrow(/resolved 2 sections but emitted 1 span/)
  })

  it('refuses missing setup ownership and invalid source spans', () => {
    const project = makeProject()
    expect(() => buildProgramContext(project, project.setups[0], GRBL_CONFIG, GCODE, [
      { opId: 'op1', startLine: 3, endLine: 10 },
      SPANS[1],
    ])).toThrow(/owned by setup/)
    expect(() => buildProgramContext(project, project.setups[0], GRBL_CONFIG, GCODE, [
      SPANS[0],
      { ...SPANS[1], endLine: 999 },
    ])).toThrow(/invalid or overlapping emitted lines/)
  })
})

describe('WO-379: freezeProgramContext enforces immutability at the boundary', () => {
  it('validates the version/schema/source shape and refuses malformed input', () => {
    expect(freezeProgramContext(null)).toBeNull()
    expect(freezeProgramContext(undefined)).toBeNull()
    expect(() => freezeProgramContext({ version: 99 } as never)).toThrow()
    expect(() => freezeProgramContext({ version: 1, schemaName: 'x', source: 'live-setup' } as never)).toThrow()
    expect(() => freezeProgramContext({ version: 1, schemaName: PROGRAM_CONTEXT_SCHEMA, source: 'bogus' } as never)).toThrow()
    const valid = buildProgramContext(makeProject(), makeProject().setups[0], GRBL_CONFIG, GCODE, SPANS)
    expect(() => freezeProgramContext({ ...valid, source: 'verified-export' } as never)).toThrow()
    expect(() => freezeProgramContext({ ...valid, stock: { id: 'forged' } } as never)).toThrow()
  })

  it('deep-copies and deep-freezes a mutable caller object', () => {
    const project = makeProject()
    const mutable = JSON.parse(JSON.stringify(buildProgramContext(project, project.setups[0], GRBL_CONFIG, GCODE, SPANS)))
    const frozen = freezeProgramContext(mutable)
    expect(frozen).not.toBeNull()
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen!.operations)).toBe(true)
    expect(Object.isFrozen(frozen!.stock)).toBe(true)
    expect(Object.isFrozen(frozen!.wcs)).toBe(true)

    // Mutate the caller's ORIGINAL object and nested values afterward: the
    // stored snapshot must be a separate copy and unchanged.
    mutable.notes = 'mutated after load'
    mutable.operations[0].name = 'mutated'
    mutable.stock.name = 'mutated stock'
    mutable.wcs.label = 'G55'
    expect(frozen!.notes).toBe('Flip once before drilling.')
    expect(frozen!.operations[0].name).toBe('Face')
    expect(frozen!.stock!.name).toBe('Stock 1')
    expect(frozen!.wcs.label).toBe('G54')
  })
})

describe('WO-379: immutability of the stored snapshot', () => {
  it('deep-freezes nested data and does not share references with the live project', () => {
    const project = makeProject()
    const setup = project.setups[0]
    const stock = project.stocks![0]
    const ctx = buildProgramContext(project, setup, GRBL_CONFIG, GCODE, SPANS)

    expect(Object.isFrozen(ctx)).toBe(true)
    expect(Object.isFrozen(ctx.operations)).toBe(true)
    expect(Object.isFrozen(ctx.operations[0])).toBe(true)
    expect(Object.isFrozen(ctx.stock)).toBe(true)
    expect(Object.isFrozen(ctx.wcs)).toBe(true)

    const mutable = ctx as unknown as {
      notes: string
      operations: Array<{ name: string }>
      wcs: { label: string }
    }
    expect(() => { mutable.notes = 'hacked' }).toThrow(TypeError)
    expect(() => { mutable.operations[0].name = 'hacked' }).toThrow(TypeError)
    expect(() => { mutable.wcs.label = 'G55' }).toThrow(TypeError)

    // Mutating the live source objects after build does not reach the snapshot.
    setup.notes = 'edited after load'
    stock.name = 'Renamed stock'
    setup.operations[0].name = 'Renamed op'
    expect(ctx.notes).toBe('Flip once before drilling.')
    expect(ctx.stock?.name).toBe('Stock 1')
    expect(ctx.operations[0].name).toBe('Face')
  })
})

describe('WO-379: complete manufacturing-intent drift detection', () => {
  const project = makeProject()
  const setup = project.setups[0]
  const ctx = buildProgramContext(project, setup, GRBL_CONFIG, GCODE, SPANS)

  it('WO-398: digest bytes are unchanged by the canonicalizer hardening (pinned from the pre-WO-398 code, 2026-08-20)', () => {
    // WO-381 added two capability fields to GRBL_CONFIG (maxLineLength and
    // programContextEnvelope). The post config is an intent input, so the live
    // fingerprint legitimately moved with it; the CANONICALIZER pin is kept by
    // hashing the same inputs the pin was taken from - the config as it was.
    const { maxLineLength: _l, programContextEnvelope: _e, ...preWo381Capabilities } = GRBL_CONFIG.capabilities
    const preWo381 = buildProgramContext(project, setup, { ...GRBL_CONFIG, capabilities: preWo381Capabilities }, GCODE, SPANS)
    expect(preWo381.projectFingerprint).toBe('sha256:a3565c9cf0297c87fffb70ebfd6e44955c01d5735ff289eca21b2a9fb2f2a182')
    expect(ctx.motionDigest).toBe('sha256:0fe34611fe2a6ff5cee9ac63fb8d12d5521577d6186f3f4844a692bbebde207a')
  })

  it('WO-398: the digest refuses, by name and path, every value it cannot represent losslessly', () => {
    class Odd { #hidden = 1; visible = 2; get h() { return this.#hidden } }
    const cases: Array<[string, unknown, RegExp]> = [
      ['Map', new Map([['a', 1]]), /Cannot digest a Map at \$\.operations\[0\]\.params\.odd/],
      ['Set', new Set([1]), /Cannot digest a Set at/],
      ['Date', new Date(0), /Cannot digest a Date at/],
      ['ArrayBuffer', new ArrayBuffer(4), /Cannot digest a ArrayBuffer at/],
      ['class instance', new Odd(), /Cannot digest a Odd instance at/],
    ]
    for (const [, odd, re] of cases) {
      const p = makeProject()
      const op0 = p.setups[0].operations[0]
      ;(op0.params as Record<string, unknown>).odd = odd
      expect(() => buildProgramContext(p, p.setups[0], GRBL_CONFIG, GCODE, SPANS)).toThrow(re)
    }
  })

  it('WO-398: a cyclic input is a clear refusal, not a stack overflow', () => {
    const p = makeProject()
    const op0 = p.setups[0].operations[0]
    const cyc: Record<string, unknown> = { name: 'loop' }
    cyc.self = cyc
    ;(op0.params as Record<string, unknown>).cyc = cyc
    expect(() => buildProgramContext(p, p.setups[0], GRBL_CONFIG, GCODE, SPANS)).toThrow(/cyclic structure \(revisited at/)
  })

  it('WO-398: an unknown fault in the comparison surfaces instead of reading as project-changed', () => {
    const p = makeProject()
    const op0 = p.setups[0].operations[0]
    ;(op0.params as Record<string, unknown>).odd = new Map()
    expect(() => compareProgramContext(ctx, p, GCODE, GRBL_CONFIG)).toThrow(/Cannot digest a Map/)
  })

  it('WO-398: a setup that can no longer resolve its work offset is the one NAMED condition that reads as project-changed', () => {
    // The live project lost the stock the setup's WCS is bound to: posting would refuse
    // (WorkOffsetResolutionError). That is a project change, reported as such - and the
    // only exception the comparison is allowed to translate.
    const p = makeProject({ stocks: [] })
    expect(compareProgramContext(ctx, p, GCODE, GRBL_CONFIG)).toBe('project-changed')
  })

  it('WO-398: a span-count mismatch names the operation that has no span', () => {
    expect(() => buildProgramContext(project, setup, GRBL_CONFIG, GCODE, SPANS.slice(0, 1)))
      .toThrow(/no span for 'Pocket' \(op2\)/)
  })

  it('WO-398: the snapshot carries one fixture offset - the posted one - in both branches', () => {
    expect(ctx.stock.provenance).toBe('physical')
    expect(ctx.stock.fixtureOffset).toBe(ctx.wcs.fixtureOffset)
    const setup2 = makeSetup({ wcs: makeWcs({ fixtureOffset: 55, label: 'G55', stockId: undefined }) })
    const authoredOnly = makeProject({ stocks: [], setups: [setup2] })
    const c2 = buildProgramContext(authoredOnly, authoredOnly.setups[0], GRBL_CONFIG, GCODE, SPANS)
    expect(c2.stock.provenance).toBe('authored')
    expect(c2.stock.fixtureOffset).toBe(55)
    expect(c2.stock.fixtureOffset).toBe(c2.wcs.fixtureOffset)
  })

  it('WO-396: the intent digest reads no project field outside programIntentIdentity (Proxy-recorded)', () => {
    const reads = new Set<string>()
    const p = makeProject()
    const spy = new Proxy(p, { get(t, k) { if (typeof k === 'string') reads.add(k); return (t as unknown as Record<string | symbol, unknown>)[k] } }) as Project
    expect(compareProgramContext(ctx, spy, GCODE, GRBL_CONFIG)).toBe('current')
    buildProgramContext(spy, p.setups[0], GRBL_CONFIG, GCODE, SPANS)
    const uncovered = [...reads].filter((k) => !(PROGRAM_INTENT_PROJECT_FIELDS as readonly string[]).includes(k))
    expect(uncovered).toEqual([])
    // And the identity tuple is exactly those references (a tree click leaves every one of them alone).
    const id1 = programIntentIdentity(p, p.toolLibrary)
    const id2 = programIntentIdentity({ ...p, activeSetupId: 'other', activeOperationId: 'op2' }, p.toolLibrary)
    expect(id2).toEqual(id1)
    expect(id2.every((v, i) => Object.is(v, id1[i]))).toBe(true)
    const id3 = programIntentIdentity({ ...p, setups: [...p.setups] }, p.toolLibrary)
    expect(id3.every((v, i) => Object.is(v, id1[i]))).toBe(false)
  })

  it('reports current when project, program, and post are unchanged', () => {
    expect(compareProgramContext(ctx, makeProject(), GCODE, GRBL_CONFIG)).toBe('current')
  })

  it("WO-397: a program with no context is 'no-context', never 'current'", () => {
    expect(compareProgramContext(null, makeProject(), GCODE, GRBL_CONFIG)).toBe('no-context')
    expect(compareProgramContext(null, makeProject(), null, GRBL_CONFIG)).toBe('no-context')
  })

  it('WO-397: a context from another project is project-changed by identity, before any setup lookup', () => {
    const other = { ...makeProject(), id: 'some-other-project' }
    // Same setup id and same intent otherwise: only the project identity differs.
    expect(compareProgramContext(ctx, other, GCODE, GRBL_CONFIG)).toBe('project-changed')
  })

  it('WO-397: a span owned by another setup is refused with a message naming multi-setup as unsupported', () => {
    const foreign = SPANS.map((s, i) => (i === 0 ? { ...s, setupId: 'setup-B' } : s))
    expect(() => buildProgramContext(project, setup, GRBL_CONFIG, GCODE, foreign))
      .toThrow(/exactly ONE setup.*not supported/)
  })

  it('reports program changed on executable drift', () => {
    expect(compareProgramContext(ctx, makeProject(), GCODE.replace('G1 X10 Y0 F800 (cut)', 'G1 X11 Y0 F800 (cut)'), GRBL_CONFIG)).toBe('program-changed')
  })

  it('a comment-only change does NOT report program changed', () => {
    const commented = GCODE.replace('(Demo part - posted from Setup 1)', '(changed comment)')
    expect(compareProgramContext(ctx, makeProject(), commented, GRBL_CONFIG)).toBe('current')
  })

  it('reports project changed on a stock change', () => {
    const moved = makeProject({ stocks: [makePhysicalStock({ bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 25 },
      size: { x: 100, y: 80, z: 25 }, center: { x: 50, y: 40, z: 12.5 },
    } })] })
    expect(compareProgramContext(ctx, moved, GCODE, GRBL_CONFIG)).toBe('project-changed')

    const shifted = makeProject({ stocks: [makePhysicalStock({ position: { x: 5, y: 0, z: 0 } })] })
    expect(compareProgramContext(ctx, shifted, GCODE, GRBL_CONFIG)).toBe('project-changed')

    const reoffset = makeProject({ stocks: [makePhysicalStock({ fixtureOffset: 55 })] })
    expect(compareProgramContext(ctx, reoffset, GCODE, GRBL_CONFIG)).toBe('project-changed')
  })

  it('reports project changed on a tool definition change (not just the tool id)', () => {
    const retooled = makeProject({ toolLibrary: [makeTool({ id: 't1', toolNumber: 1, diameter: 12 }), makeTool({ id: 't2', toolNumber: 2 })] })
    expect(compareProgramContext(ctx, retooled, GCODE, GRBL_CONFIG)).toBe('project-changed')
  })

  it('reports project changed on an operation setting or ordering change', () => {
    const changed = makeProject({
      setups: [makeSetup({
        operations: [
          makeOp({ id: 'op1', name: 'Face', type: 'face', generationFingerprint: 'gf-op1', params: { depth: 7 } }),
          makeOp({ id: 'op2', name: 'Pocket', type: 'pocket_2d', generationFingerprint: 'gf-op2' }),
        ],
      })],
    })
    expect(compareProgramContext(ctx, changed, GCODE, GRBL_CONFIG)).toBe('project-changed')

    // Reordering the enabled operations changes the emitted order -> drift.
    const reordered = makeProject({
      setups: [makeSetup({
        operations: [
          makeOp({ id: 'op2', name: 'Pocket', type: 'pocket_2d', generationFingerprint: 'gf-op2' }),
          makeOp({ id: 'op1', name: 'Face', type: 'face', generationFingerprint: 'gf-op1' }),
        ],
      })],
    })
    expect(compareProgramContext(ctx, reordered, GCODE, GRBL_CONFIG)).toBe('project-changed')
  })

  it('reports project changed when the exact resolved toolpath motion changes', () => {
    const changedMotion = makeProject({
      setups: [makeSetup({
        operations: [
          makeOp({
            id: 'op1', name: 'Face', type: 'face', generationFingerprint: 'gf-op1',
            toolpathMoves: [move({ x: 123.456 })],
          }),
          makeOp({ id: 'op2', name: 'Pocket', type: 'pocket_2d', generationFingerprint: 'gf-op2' }),
        ],
      })],
    })
    expect(compareProgramContext(ctx, changedMotion, GCODE, GRBL_CONFIG)).toBe('project-changed')
  })

  it('reports project changed on a setup, WCS, or notes change', () => {
    expect(compareProgramContext(ctx, makeProject({ setups: [makeSetup({ notes: 'edited later' })] }), GCODE, GRBL_CONFIG)).toBe('project-changed')
    expect(compareProgramContext(ctx, makeProject({ setups: [makeSetup({ name: 'Setup 2' })] }), GCODE, GRBL_CONFIG)).toBe('project-changed')
    const movedWcs = makeSetup({ wcs: makeWcs({ fixtureOffset: 54, label: 'G54', stockId: 'stock1', origin: { x: 3, y: 0, z: 0 } }) })
    expect(compareProgramContext(ctx, makeProject({ setups: [movedWcs] }), GCODE, GRBL_CONFIG)).toBe('project-changed')
  })

  it('reports project changed on a post configuration change', () => {
    expect(compareProgramContext(ctx, makeProject(), GCODE, UCCNC_CONFIG)).toBe('project-changed')
  })

  it('reports project changed when the project identity changes or the setup is gone', () => {
    expect(compareProgramContext(ctx, makeProject({ id: 'proj2' }), GCODE, GRBL_CONFIG)).toBe('project-changed')
    expect(compareProgramContext(ctx, makeProject({ setups: [] }), GCODE, GRBL_CONFIG)).toBe('project-changed')
  })

  it('does NOT report drift for irrelevant UI state edits', () => {
    // activeSetupId / activeOperationId / updatedAt are UI/session state, not
    // manufacturing intent, so they must not change the comparison.
    expect(compareProgramContext(ctx, makeProject({ activeSetupId: 'some-other-setup' }), GCODE, GRBL_CONFIG)).toBe('current')
    expect(compareProgramContext(ctx, makeProject({ activeOperationId: 'op2' }), GCODE, GRBL_CONFIG)).toBe('current')
    expect(compareProgramContext(ctx, makeProject({ updatedAt: '2099-01-01' }), GCODE, GRBL_CONFIG)).toBe('current')
  })

  it('never mutates the snapshot while comparing', () => {
    const before = JSON.stringify(ctx)
    void compareProgramContext(ctx, makeProject({ name: 'changed' }), GCODE, GRBL_CONFIG)
    void compareProgramContext(ctx, makeProject(), GCODE.replace('G1 X10', 'G1 X99'), GRBL_CONFIG)
    expect(JSON.stringify(ctx)).toBe(before)
  })
})

describe('WO-381: the boundary accepts verified-export only from the envelope importer', () => {
  it('a minted verified-export context is accepted; the same object hand-labelled is still refused', () => {
    const project = makeProject()
    const direct = buildProgramContext(project, project.setups[0], GRBL_CONFIG, GCODE, SPANS)
    // Hand-labelling is refused exactly as WO-379 pinned above.
    expect(() => freezeProgramContext({ ...direct, source: 'verified-export' })).toThrow()
    // The importer's mint (after its own wire checks) is the one accepted path,
    // and it binds the context to the program's motion.
    const minted = mintVerifiedExportContext({ ...direct, source: 'verified-export' }, GCODE)
    expect(minted.source).toBe('verified-export')
    expect(Object.isFrozen(minted)).toBe(true)
    expect(freezeProgramContext(minted)?.source).toBe('verified-export')
    expect(() => mintVerifiedExportContext({ ...direct, source: 'verified-export' }, GCODE.replace('G1 X10', 'G1 X99'))).toThrow(/motion digest/)
    expect(() => mintVerifiedExportContext({ ...direct, source: 'foreign' }, GCODE)).toThrow()
  })
})

// WO-381: the portable program-context envelope - emit side + wire format.
//
// Proves: off-mode byte identity; every certified dialect emits a dialect-
// correct, line-limited, comment-only block after M30 that round-trips to the
// same context; the streamer sees the same executable lines with or without
// the block; the V1 one-setup boundary (multi-setup combined = no block, each
// separate file = its own); uncertified posts fail closed; every emit and
// parser limit refuses; malformed / truncated / duplicate / tampered / unknown
// blocks are refused while the program still loads.

import { describe, it, expect } from 'vitest'
import {
  postProject,
  GRBL_CONFIG,
  LINUXCNC_CONFIG,
  UCCNC_CONFIG,
  GENERIC_CONFIG,
  BUILT_IN_DIALECTS,
  PROGRAM_CONTEXT_ENVELOPE_LIMITS,
  appendProgramContextEnvelope,
  decodeProgramContextEnvelope,
  encodeProgramContextEnvelope,
  importProgramContextFromGcode,
  postSupportsProgramContextEnvelope,
  programContextEnvelopeLineLength,
  type PostConfig,
  type PostProjectOptions,
} from '../../lib/post'
import {
  base64urlDecode,
  base64urlEncode,
  envelopePayloadFromContext,
} from '../../lib/post/programContextEnvelope'
import {
  buildProgramContext,
  canonicalJson,
  computeMotionDigest,
  sha256Hex,
  type ProgramContextV1,
} from '../../lib/machine/programContext'
import { prepareProgram } from '../../lib/gcode/text'
import { lintGcode } from '../../lib/gcode'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from './helpers'
import type { Operation, Project, Setup, Stock } from '../../types'

// ---- fixtures (mirror src/tests/post/postProject.test.ts) -------------------

function makeStock(): Stock {
  return {
    type: 'rectangular',
    width: 100,
    depth: 100,
    height: 20,
    origin: { x: 0, y: 0, z: 0 },
    material: 'aluminum',
  } as unknown as Stock
}

function twoMoveOp(id: string, name: string, toolId = 't1'): Operation {
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

function makeSetup(id: string, name: string, fixtureOffset: number, ops: Operation[], notes = 'Deburr edges after op 2.'): Setup {
  return {
    id,
    name,
    wcs: makeWcs({ id: `wcs-${id}`, label: `G${fixtureOffset}`, fixtureOffset }),
    stock: makeStock(),
    operations: ops,
    notes,
  }
}

function makeProject(setups: Setup[]): Project {
  const project: Project = {
    id: 'p-envelope',
    name: 'Envelope Part',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })],
    geometry: [],
    setups,
    activeSetupId: null,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  }
  for (const setup of setups) {
    for (const op of setup.operations) {
      const tool = project.toolLibrary.find((t) => t.id === op.toolId)!
      stampGenerationCurrent(project, setup, op, tool)
    }
  }
  return project
}

function oneSetupProject(): Project {
  return makeProject([makeSetup('s1', 'Setup One', 54, [twoMoveOp('opA', 'Face (rough)'), twoMoveOp('opB', 'Pocket; deep', 't2')])])
}

const BASE_OPTS: PostProjectOptions = { mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc' }

const CERTIFIED: PostConfig[] = [UCCNC_CONFIG, GRBL_CONFIG, LINUXCNC_CONFIG]

function blockLines(gcode: string): string[] {
  return gcode.split('\n').filter((l) => /LCX1/.test(l))
}
function nonBlockGcode(gcode: string): string {
  return gcode.split('\n').filter((l) => !/LCX1/.test(l)).join('\n')
}
function strip(ctx: ProgramContextV1): Omit<ProgramContextV1, 'source'> {
  const { source: _source, ...rest } = ctx
  return rest
}

/** A raw block (header/chunks/footer, paren style) from an arbitrary payload
 *  string, for the parser's adversarial tests. */
function rawBlock(payloadJson: string, opts: { version?: number; style?: 'paren' | 'semicolon'; digest?: string; bytes?: number; n?: number; width?: number } = {}): string[] {
  const style = opts.style ?? 'paren'
  const wrap = (c: string) => (style === 'semicolon' ? `; ${c}` : `( ${c} )`)
  const bytes = new TextEncoder().encode(payloadJson)
  const encoded = base64urlEncode(bytes)
  const width = opts.width ?? 60
  const chunks: string[] = []
  for (let i = 0; i < encoded.length; i += width) chunks.push(encoded.slice(i, i + width))
  if (chunks.length === 0) chunks.push('')
  const n = opts.n ?? chunks.length
  const lines = [
    wrap(`LCX1 v=${opts.version ?? 1} n=${n} bytes=${opts.bytes ?? bytes.length}`),
    wrap(`LCX1 sha256=${opts.digest ?? sha256Hex(payloadJson)}`),
  ]
  chunks.forEach((c, i) => lines.push(wrap(`LCX1 ${i + 1}/${chunks.length} ${c}`)))
  lines.push(wrap('LCX1 end'))
  return lines
}

const FOREIGN = ['G21 G90 G54', 'M3 S12000', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G0 Z5', 'M5', 'M30', ''].join('\n')

// ---------------------------------------------------------------------------

describe('WO-381: off mode is byte-for-byte the historical output', () => {
  it('omitting the option and passing false both produce the same gcode as today, with no envelope status', () => {
    for (const config of BUILT_IN_DIALECTS) {
      const project = oneSetupProject()
      const plain = postProject(project, project.setups, config, BASE_OPTS)
      const off = postProject(project, project.setups, config, { ...BASE_OPTS, programContext: false })
      expect(plain.ok).toBe(true)
      expect(off.combined!.gcode).toBe(plain.combined!.gcode)
      expect(plain.combined!.programContextEnvelope).toBeUndefined()
      expect(off.combined!.programContextEnvelope).toBeUndefined()
      expect(blockLines(plain.combined!.gcode)).toEqual([])
    }
  })

  it('on mode changes nothing but appends the block: every non-LCX1 line is identical, in order', () => {
    for (const config of CERTIFIED) {
      const project = oneSetupProject()
      const plain = postProject(project, project.setups, config, BASE_OPTS).combined!.gcode
      const on = postProject(project, project.setups, config, { ...BASE_OPTS, programContext: true }).combined!
      expect(on.programContextEnvelope?.included).toBe(true)
      expect(nonBlockGcode(on.gcode)).toBe(plain)
      expect(on.gcode.startsWith(plain)).toBe(true)
    }
  })
})

describe('WO-381: every certified dialect emits a dialect-correct, bounded, comment-only block after M30', () => {
  it('built-in grbl, uccnc and linuxcnc declare readiness; generic does not', () => {
    expect(CERTIFIED.every(postSupportsProgramContextEnvelope)).toBe(true)
    expect(postSupportsProgramContextEnvelope(GENERIC_CONFIG)).toBe(false)
    expect(CERTIFIED.map(programContextEnvelopeLineLength)).toEqual([80, 80, 80])
  })

  for (const config of CERTIFIED) {
    it(`${config.id}: comment style, delimiters, line length, placement`, () => {
      const project = oneSetupProject()
      const result = postProject(project, project.setups, config, { ...BASE_OPTS, programContext: true }).combined!
      const lines = result.gcode.split('\n')
      expect(lines[lines.length - 1]).toBe('') // trailing newline convention kept
      const body = lines.slice(0, -1)
      const block = blockLines(result.gcode)
      expect(block.length).toBeGreaterThanOrEqual(4)
      // The block is the last thing in the file, directly after M30.
      expect(body.slice(-block.length)).toEqual(block)
      expect(body[body.length - block.length - 1]).toBe('M30')
      const limit = programContextEnvelopeLineLength(config)
      for (const line of block) {
        expect(line.length).toBeLessThanOrEqual(limit)
        if (config.capabilities.comment === 'semicolon') {
          expect(line.startsWith('; LCX1')).toBe(true)
          expect(line.slice(1)).not.toMatch(/[;()%]/)
        } else {
          expect(line.startsWith('( LCX1')).toBe(true)
          expect(line.endsWith(' )')).toBe(true)
          expect(line.slice(1, -1)).not.toMatch(/[;()%]/)
        }
      }
      // The linter (the same one Control runs) raises nothing on a paren-style
      // block. (Semicolon style is not asserted: the gcode tokenizer's structural
      // pass does not strip ';' comments - a pre-existing limitation that already
      // affects every LinuxCNC section comment, recorded in the WO-381 landing.)
      if (config.capabilities.comment === 'paren') {
        const firstBlockLine = body.length - block.length + 1
        const blockFindings = lintGcode(result.gcode, { commentStyle: 'paren' })
          .filter((f) => f.line >= firstBlockLine)
        expect(blockFindings).toEqual([])
      }
      expect(block[0]).toMatch(/LCX1 v=1 n=\d+ bytes=\d+/)
      expect(block[1]).toMatch(/LCX1 sha256=[0-9a-f]{64}/)
      expect(block[block.length - 1]).toMatch(/LCX1 end/)
      const status = result.programContextEnvelope!
      expect(status.included && status.lines === block.length && status.chunks === block.length - 3).toBe(true)
    })

    it(`${config.id}: the block round-trips to the same context a direct load builds (minus source)`, () => {
      const project = oneSetupProject()
      const plain = postProject(project, project.setups, config, BASE_OPTS).combined!
      const on = postProject(project, project.setups, config, { ...BASE_OPTS, programContext: true }).combined!
      const direct = buildProgramContext(project, project.setups[0], config, plain.gcode, plain.operationSpans!)
      const decoded = decodeProgramContextEnvelope(on.gcode)
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) return
      // generatedAt is the export's own stamp; every other field is identical.
      expect(strip({ ...decoded.context, generatedAt: direct.generatedAt })).toEqual(strip(direct))
      expect(decoded.context.source).toBe('verified-export')
      expect(decoded.payload.version === 1 && decoded.payload.setup.notes).toBe('Deburr edges after op 2.')
      expect(decoded.context.motionDigest).toBe(computeMotionDigest(on.gcode))
      expect(decoded.context.motionDigest).toBe(computeMotionDigest(plain.gcode))
      // The verified importer accepts it and binds it to the exported text.
      const imported = importProgramContextFromGcode(on.gcode)
      expect(imported.warning).toBeNull()
      expect(imported.context?.source).toBe('verified-export')
      expect(Object.isFrozen(imported.context)).toBe(true)
      expect(strip({ ...imported.context!, generatedAt: direct.generatedAt })).toEqual(strip(direct))
    })

    it(`${config.id}: the streamer sees the same executable lines with or without the block`, () => {
      const project = oneSetupProject()
      const plain = postProject(project, project.setups, config, BASE_OPTS).combined!.gcode
      const on = postProject(project, project.setups, config, { ...BASE_OPTS, programContext: true }).combined!.gcode
      const a = prepareProgram(plain)
      const b = prepareProgram(on)
      expect(b.lines.map((l) => l.text)).toEqual(a.lines.map((l) => l.text))
      expect(b.overlongLines).toEqual([])
      expect(b.skipped).toBe(a.skipped + blockLines(on).length)
    })
  }

  it('the payload carries only the compact context - no project body, geometry bytes, scripts or URLs', () => {
    const project = oneSetupProject()
    const on = postProject(project, project.setups, GRBL_CONFIG, { ...BASE_OPTS, programContext: true }).combined!
    const decoded = decodeProgramContextEnvelope(on.gcode)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(Object.keys(decoded.payload).sort()).toEqual([
      'generatedAt', 'motionDigest', 'operations', 'post', 'project', 'projectFingerprint',
      'schemaName', 'setup', 'stock', 'targetParts', 'units', 'version', 'wcs',
    ])
    if (decoded.payload.version !== 1) throw new Error('a one-setup export is the V1 payload')
    expect(decoded.payload.operations.map((o) => [o.id, o.startLine, o.endLine, o.tool.toolNumber, o.tool.diameter]))
      .toEqual(on.operationSpans!.map((s, i) => [s.opId, s.startLine, s.endLine, i + 1, 6]))
    const json = JSON.stringify(decoded.payload)
    expect(json).not.toMatch(/toolpathMoves|http|script|macro|<|>/)
  })

  it('a closing % marker stays last: the block goes between the program end and the %', () => {
    const out = appendProgramContextEnvelope('%\nG90\nM30\n%\n', ['( LCX1 a )', '( LCX1 end )'])
    expect(out).toBe('%\nG90\nM30\n( LCX1 a )\n( LCX1 end )\n%\n')
    expect(appendProgramContextEnvelope('G90\nM30\n', ['; LCX1 x'])).toBe('G90\nM30\n; LCX1 x\n')
    expect(appendProgramContextEnvelope('G90\nM30', ['; LCX1 x'])).toBe('G90\nM30\n; LCX1 x')
  })
})

describe('WO-381: one setup = V1 block (WO-412 lifted the multi-setup boundary: see programContextMultiSetup.wo412.test.ts) and fail-closed posts', () => {
  const twoSetups = () => makeProject([
    makeSetup('s1', 'Setup One', 54, [twoMoveOp('opA', 'Face')]),
    makeSetup('s2', 'Setup Two', 55, [twoMoveOp('opB', 'Pocket', 't2')]),
  ])

  it('a combined export of several setups carries ONE v=2 block listing every setup; a one-setup export stays v=1', () => {
    const project = twoSetups()
    const r = postProject(project, project.setups, GRBL_CONFIG, { ...BASE_OPTS, programContext: true })
    expect(r.ok).toBe(true)
    const block = blockLines(r.combined!.gcode)
    expect(block[0]).toMatch(/LCX1 v=2 n=\d+ bytes=\d+/)
    expect(r.combined!.programContextEnvelope).toMatchObject({ included: true, setupCount: 2, version: 2 })
    const d = decodeProgramContextEnvelope(r.combined!.gcode)
    expect(d.ok && d.context.version === 2 && d.context.setups?.map((s) => s.setup.id)).toEqual(['s1', 's2'])
    // Off is still byte-identical, and one setup is still the V1 wire format.
    expect(nonBlockGcode(r.combined!.gcode)).toBe(postProject(project, project.setups, GRBL_CONFIG, BASE_OPTS).combined!.gcode)
    const one = postProject(oneSetupProject(), oneSetupProject().setups, GRBL_CONFIG, { ...BASE_OPTS, programContext: true })
    expect(blockLines(one.combined!.gcode)[0]).toMatch(/LCX1 v=1 /)
  })

  it('separate mode gives each file its own block describing its own setup', () => {
    const project = twoSetups()
    const r = postProject(project, project.setups, UCCNC_CONFIG, { ...BASE_OPTS, mode: 'separate', programContext: true })
    expect(r.ok).toBe(true)
    expect(r.files!.length).toBe(2)
    const ids = r.files!.map((f) => {
      expect(f.result.programContextEnvelope?.included).toBe(true)
      const d = decodeProgramContextEnvelope(f.result.gcode)
      expect(d.ok).toBe(true)
      return d.ok ? d.context.setup.id : null
    })
    expect(ids).toEqual(['s1', 's2'])
  })

  it('a partial operation selection carries no block (the context describes the whole setup)', () => {
    const project = oneSetupProject()
    const r = postProject(project, project.setups, GRBL_CONFIG, {
      ...BASE_OPTS, programContext: true, selectedOpIds: { s1: ['opA'] },
    })
    expect(r.ok).toBe(true)
    expect(blockLines(r.combined!.gcode)).toEqual([])
    expect(r.combined!.programContextEnvelope).toMatchObject({ included: false })
    expect((r.combined!.programContextEnvelope as { reason: string }).reason).toMatch(/deselected/)
  })

  it('an uncertified post (generic, or a user-authored copy of a built-in) fails closed', () => {
    const project = oneSetupProject()
    const generic = postProject(project, project.setups, GENERIC_CONFIG, { ...BASE_OPTS, programContext: true })
    expect(blockLines(generic.combined!.gcode)).toEqual([])
    expect((generic.combined!.programContextEnvelope as { reason: string }).reason).toMatch(/not certified/)
    // A user post parsed from JSON never carries the capability.
    const userPost: PostConfig = {
      ...structuredClone(GRBL_CONFIG),
      id: 'shop-grbl', label: 'Shop GRBL', builtin: false,
      capabilities: { ...structuredClone(GRBL_CONFIG.capabilities), programContextEnvelope: undefined },
    }
    expect(postSupportsProgramContextEnvelope(userPost)).toBe(false)
    const user = postProject(project, project.setups, userPost, { ...BASE_OPTS, programContext: true })
    expect(blockLines(user.combined!.gcode)).toEqual([])
  })
})

describe('WO-381: emit limits refuse (and the file is still exported without a block)', () => {
  function bigContext(overrides: Partial<ProgramContextV1>): ProgramContextV1 {
    const project = oneSetupProject()
    const plain = postProject(project, project.setups, GRBL_CONFIG, BASE_OPTS).combined!
    const ctx = buildProgramContext(project, project.setups[0], GRBL_CONFIG, plain.gcode, plain.operationSpans!)
    return { ...ctx, ...overrides }
  }

  it('payload over 64 KiB', () => {
    const ops = Array.from({ length: 400 }, (_, i) => ({ ...bigContext({}).operations[0], id: `op-${i}`, name: `Operation number ${i} with a long descriptive name`, startLine: 10 + i * 2, endLine: 11 + i * 2 }))
    const ctx = bigContext({ operations: ops })
    expect(new TextEncoder().encode(canonicalJson(envelopePayloadFromContext(ctx))).length).toBeGreaterThan(PROGRAM_CONTEXT_ENVELOPE_LIMITS.maxPayloadBytes)
    const r = encodeProgramContextEnvelope(ctx, GRBL_CONFIG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/over the 65536-byte limit/)
  })

  it('more than 512 chunk lines at the post line length (payload under 64 KiB)', () => {
    const ops = Array.from({ length: 110 }, (_, i) => ({ ...bigContext({}).operations[0], id: `op-${i}`, name: `Operation number ${i} with a long descriptive name`, startLine: 10 + i * 2, endLine: 11 + i * 2 }))
    const ctx = bigContext({ operations: ops })
    const bytes = new TextEncoder().encode(canonicalJson(envelopePayloadFromContext(ctx))).length
    expect(bytes).toBeLessThan(PROGRAM_CONTEXT_ENVELOPE_LIMITS.maxPayloadBytes)
    expect(bytes).toBeGreaterThan(512 * 63 * 3 / 4) // 512 chunks x 63 base64url chars at 80-char lines
    const r = encodeProgramContextEnvelope(ctx, GRBL_CONFIG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/over the 512-line limit/)
  })

  it('a line limit too short to carry a chunk or the header', () => {
    const tiny: PostConfig = { ...GRBL_CONFIG, capabilities: { ...GRBL_CONFIG.capabilities, programContextEnvelope: { ready: true, maxLineLength: 20 } } }
    const r = encodeProgramContextEnvelope(bigContext({}), tiny)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/too short/)
  })

  it('parser limits bind on emit too: a single string over 4 KiB is refused before it is written', () => {
    const r = encodeProgramContextEnvelope(bigContext({ notes: 'n'.repeat(5000) }), GRBL_CONFIG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/string longer than 4096/)
  })

  it('a refused envelope leaves the exported program intact and reports the reason on the result', () => {
    const project = oneSetupProject()
    project.setups[0].notes = 'n'.repeat(5000)
    const on = postProject(project, project.setups, GRBL_CONFIG, { ...BASE_OPTS, programContext: true })
    const off = postProject(project, project.setups, GRBL_CONFIG, BASE_OPTS)
    expect(on.ok).toBe(true)
    expect(on.combined!.gcode).toBe(off.combined!.gcode)
    expect(on.combined!.programContextEnvelope).toMatchObject({ included: false })
  })
})

describe('WO-381: the parser refuses every malformed, oversized, tampered or unknown block', () => {
  const exported = () => {
    const project = oneSetupProject()
    return postProject(project, project.setups, GRBL_CONFIG, { ...BASE_OPTS, programContext: true }).combined!.gcode
  }
  const invalidReason = (text: string, limits = PROGRAM_CONTEXT_ENVELOPE_LIMITS): string => {
    const d = decodeProgramContextEnvelope(text, limits)
    expect(d.ok).toBe(false)
    if (d.ok) return ''
    expect(d.status).toBe('invalid')
    return d.status === 'invalid' ? d.reason : ''
  }
  const withBlock = (lines: string[]) => FOREIGN + lines.join('\n') + '\n'

  it('a foreign file with no block is absent - no warning, no context', () => {
    expect(decodeProgramContextEnvelope(FOREIGN)).toEqual({ ok: false, status: 'absent' })
    expect(importProgramContextFromGcode(FOREIGN)).toEqual({ context: null, warning: null })
    expect(decodeProgramContextEnvelope('')).toEqual({ ok: false, status: 'absent' })
  })

  it('file-bytes limit: an oversized file is not scanned', () => {
    const text = exported()
    expect(invalidReason(text, { ...PROGRAM_CONTEXT_ENVELOPE_LIMITS, maxFileBytes: 100 })).toMatch(/larger than 100 bytes/)
    expect(decodeProgramContextEnvelope(text).ok).toBe(true)
  })

  it('chunk-count limit: a header declaring more than 512 chunks', () => {
    expect(invalidReason(withBlock(rawBlock('{"a":1}', { n: 513 })))).toMatch(/declares 513 chunks/)
  })

  it('decoded-size limit: a header declaring more than 64 KiB, and a payload whose byte count disagrees with its header', () => {
    expect(invalidReason(withBlock(rawBlock('{"a":1}', { bytes: 70000 })))).toMatch(/declares 70000 payload bytes/)
    expect(invalidReason(withBlock(rawBlock('{"a":1}', { bytes: 6 })))).toMatch(/more data than its header declares/)
    expect(invalidReason(withBlock(rawBlock('{"a":1}', { bytes: 8 })))).toMatch(/decodes to 7 bytes but the header declares 8/)
  })

  it('nesting limit: deeper than 16', () => {
    const deep = '['.repeat(17) + ']'.repeat(17)
    expect(invalidReason(withBlock(rawBlock(deep)))).toMatch(/nesting deeper than 16/)
    const ok16 = '['.repeat(16) + ']'.repeat(16)
    expect(invalidReason(withBlock(rawBlock(ok16)))).not.toMatch(/nesting/)
  })

  it('string-length limit: a string over 4 KiB', () => {
    expect(invalidReason(withBlock(rawBlock(JSON.stringify({ a: 's'.repeat(4097) }))))).toMatch(/string longer than 4096/)
    expect(invalidReason(withBlock(rawBlock(JSON.stringify({ ['k'.repeat(4097)]: 1 }))))).toMatch(/key longer than 4096/)
  })

  it('collection-count limit: more than 512 entries', () => {
    const arr = JSON.stringify(Array.from({ length: 513 }, (_, i) => i))
    expect(invalidReason(withBlock(rawBlock(arr)))).toMatch(/array of more than 512/)
    const obj: Record<string, number> = {}
    for (let i = 0; i < 513; i++) obj[`k${i}`] = i
    expect(invalidReason(withBlock(rawBlock(canonicalJson(obj))))).toMatch(/object of more than 512/)
  })

  it('payload digest mismatch (tampered)', () => {
    expect(invalidReason(withBlock(rawBlock('{"a":1}', { digest: sha256Hex('{"a":2}') })))).toMatch(/digest does not match/)
    // Flip one character inside a real chunk.
    const text = exported()
    const lines = text.split('\n')
    const i = lines.findIndex((l) => /LCX1 1\//.test(l))
    const ch = lines[i][lines[i].length - 4]
    lines[i] = lines[i].slice(0, -4) + (ch === 'A' ? 'B' : 'A') + lines[i].slice(-3)
    expect(importProgramContextFromGcode(lines.join('\n')).context).toBeNull()
  })

  it('truncation: a missing chunk line, a missing end line, a chunk out of order', () => {
    const text = exported()
    const lines = text.split('\n')
    const last = lines.findIndex((l) => /LCX1 end/.test(l))
    const noEnd = [...lines.slice(0, last), ...lines.slice(last + 1)].join('\n')
    expect(invalidReason(noEnd)).toMatch(/no end line \(truncated\)/)
    const noChunk = [...lines.slice(0, last - 1), ...lines.slice(last)].join('\n')
    expect(invalidReason(noChunk)).toMatch(/truncated or tampered/)
    const swapped = [...lines]
    const c1 = lines.findIndex((l) => /LCX1 1\//.test(l))
    ;[swapped[c1], swapped[c1 + 1]] = [swapped[c1 + 1], swapped[c1]]
    expect(invalidReason(swapped.join('\n'))).toMatch(/out of order/)
    const headerOnly = withBlock([lines.find((l) => /LCX1 v=/.test(l))!])
    expect(invalidReason(headerOnly)).toMatch(/no end line/)
    const cut = text.slice(0, text.lastIndexOf('LCX1') - 10)
    expect(importProgramContextFromGcode(cut).context).toBeNull()
    expect(importProgramContextFromGcode(cut).warning).toMatch(/Ignoring the LienCAM setup information/)
  })

  it('duplicate blocks', () => {
    const text = exported()
    const block = blockLines(text)
    expect(invalidReason(text + block.join('\n') + '\n')).toMatch(/2 LCX1 header lines/)
  })

  it('unknown envelope or payload version, unknown schema', () => {
    expect(invalidReason(withBlock(rawBlock('{"a":1}', { version: 3 })))).toMatch(/unknown LCX1 envelope version 3/)
    // A V1-only reader (WO-381's) refuses a v=2 block with the same sentence.
    const v1Only = decodeProgramContextEnvelope(withBlock(rawBlock('{"a":1}', { version: 2 })), PROGRAM_CONTEXT_ENVELOPE_LIMITS, [1])
    expect(v1Only.ok === false && v1Only.status === 'invalid' && v1Only.reason).toBe('unknown LCX1 envelope version 2')
    // A v=2 header over a payload that is not a setup list is refused too.
    expect(invalidReason(withBlock(rawBlock('{"a":1}', { version: 2 })))).toMatch(/payload version|missing its setup/)
    const text = exported()
    const d = decodeProgramContextEnvelope(text)
    if (!d.ok) throw new Error('fixture')
    const v9 = canonicalJson({ ...d.payload, version: 9 })
    expect(invalidReason(withBlock(rawBlock(v9)))).toMatch(/unknown LCX1 payload version 9/)
    const badSchema = canonicalJson({ ...d.payload, schemaName: 'liencam.other' })
    expect(invalidReason(withBlock(rawBlock(badSchema)))).toMatch(/unknown LCX1 payload schema/)
  })

  it('non-canonical payload, invalid base64url, invalid UTF-8, invalid JSON, LCX1 lines outside the block', () => {
    expect(invalidReason(withBlock(rawBlock('{ "a": 1 }')))).toMatch(/not in canonical form/)
    expect(invalidReason(withBlock(rawBlock('{"b":1,"a":2}')))).toMatch(/not in canonical form/)
    const badB64 = withBlock(rawBlock('{"a":1}')).replace(/LCX1 1\/1 (\S+)/, 'LCX1 1/1 $1*')
    expect(invalidReason(badB64)).toMatch(/malformed|base64url|more data/)
    const notJson = withBlock(rawBlock('{"a":'))
    expect(invalidReason(notJson)).toMatch(/not valid JSON/)
    const invalidUtf8 = withBlock([
      '( LCX1 v=1 n=1 bytes=2 )',
      `( LCX1 sha256=${sha256Hex('xx')} )`,
      `( LCX1 1/1 ${base64urlEncode(new Uint8Array([0xff, 0xfe]))} )`,
      '( LCX1 end )',
    ])
    expect(invalidReason(invalidUtf8)).toMatch(/not valid UTF-8/)
    expect(invalidReason('( LCX1 stray )\n' + FOREIGN)).toMatch(/no header line/)
    expect(invalidReason('( LCX1 end )\n' + withBlock(rawBlock('{"a":1}')))).toMatch(/more than one LCX1 end line/)
  })

  it('a valid block whose payload is not a context shape is refused at the boundary, and the program still imports as no-context with one warning', () => {
    const notContext = canonicalJson({ version: 1, schemaName: 'liencam.program-context-envelope', project: {}, setup: { notes: '' }, post: {} })
    const text = withBlock(rawBlock(notContext))
    expect(decodeProgramContextEnvelope(text).ok).toBe(true)
    const imported = importProgramContextFromGcode(text)
    expect(imported.context).toBeNull()
    expect(imported.warning).toMatch(/Ignoring the LienCAM setup information/)
  })

  it('motion digest mismatch: a real block on a program whose motion changed is refused with one warning, and the program loads', () => {
    const text = exported().replace('X30', 'X31')
    expect(decodeProgramContextEnvelope(text).ok).toBe(true) // the block itself is intact
    const imported = importProgramContextFromGcode(text)
    expect(imported.context).toBeNull()
    expect(imported.warning).toMatch(/motion digest does not match/)
    expect(prepareProgram(text).lines.length).toBeGreaterThan(0)
  })

  it('both comment styles are recognised on import regardless of the exporting dialect', () => {
    const project = oneSetupProject()
    for (const config of CERTIFIED) {
      const text = postProject(project, project.setups, config, { ...BASE_OPTS, programContext: true }).combined!.gcode
      expect(importProgramContextFromGcode(text).context?.post.id).toBe(config.id)
    }
  })
})

describe('WO-381: base64url', () => {
  it('round-trips every byte length and refuses non-canonical input', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = new Uint8Array(n)
      for (let i = 0; i < n; i++) bytes[i] = (i * 37 + n) & 255
      const enc = base64urlEncode(bytes)
      expect(enc).not.toMatch(/[=+/]/)
      expect(Array.from(base64urlDecode(enc)!)).toEqual(Array.from(bytes))
    }
    expect(base64urlDecode('A')).toBeNull()
    expect(base64urlDecode('AB=')).toBeNull()
    expect(base64urlDecode('AC')).toBeNull() // non-zero trailing bits
    expect(base64urlDecode('AQ')).toEqual(new Uint8Array([1]))
  })
})

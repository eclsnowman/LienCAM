import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { postProgram, postCombined, postProject, importPostFile, BUILT_IN_DIALECTS, UCCNC_CONFIG, LINUXCNC_CONFIG } from '../../lib/post'
import { parseGcode } from '../../lib/gcode/parse'
import { decodeProgramContextEnvelope, importProgramContextFromGcode } from '../../lib/post/programContextEnvelope'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import { evidenceOutDir } from '../helpers/evidenceScratch'
import { vendorJob } from './fixtures/wo2292/job'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from './helpers'
import type { Project, Setup, Stock } from '../../types'
import type { PostConfig, PostInput, PostResult } from '../../lib/post/types'

const evidence = 'src/tests/evidence/WO-3132'
function input(): PostInput {
  const machine = makeMachine(), tool = makeTool(), op = makeOp()
  const moves = [move({ type: 'rapid', x: 10, z: 10 }), move({ x: 10, z: -1, feed: 400 }), move({ x: 20, z: -1, feed: 2000 })]
  return { machine, setup: { wcs: makeWcs(), operations: [{ op, tool, moves,
    feeds: resolveFeedrates(tool, undefined, machine.rapidRate), spindle: resolveSpindle(op, tool, machine), coolant: resolveCoolant(tool, machine) }] } }
}
const config = (step = 5): PostConfig => ({ ...UCCNC_CONFIG, format: { ...UCCNC_CONFIG.format, lineNumbers: true, lineNumberStep: step } })
const strip = (s: string) => s.replace(/^(\s*\/\s*)?N\d+ /gm, '$1')
const withoutContext = (s: string) => s.replace(/^[;(] LCX1 .*\n/gm, '')
const hash = (s: string) => createHash('sha256').update(s).digest('hex')

describe('WO-3132 sequence numbers', () => {
  it('numbers built-in output from N10 by the configured increment without changing spans or bytes beneath N', () => {
    const source = input(), off = postProgram(source, UCCNC_CONFIG), on = postProgram(source, config())
    expect(on.ok).toBe(true)
    expect(on.gcode.split('\n')[0]).toMatch(/^N10 /)
    expect(on.gcode.split('\n')[1]).toMatch(/^N15 /)
    expect(strip(on.gcode)).toBe(off.gcode)
    expect(on.operationSpans).toEqual(off.operationSpans)
    expect(on.meta).toEqual(off.meta)
    expect(parseGcode(on.gcode).segments).toEqual(parseGcode(off.gcode).segments)
  })
  it.each([1, 7, 1000])('honors step %s and restarts for each file', step => {
    const a = postProgram(input(), config(step)), b = postProgram(input(), config(step))
    expect(a.gcode.split('\n').slice(0, 2).map(l => l.match(/^N\d+/)?.[0])).toEqual(['N10', `N${10 + step}`])
    expect(a.gcode).toBe(b.gcode)
  })
  describe.each(['router-mm.pp', 'router-mm.cps', 'router-mm.scpost', 'router-mm.pst'])('restores imported %s convention', name => {
    it.each(['combined', 'separate'] as const)('starts at the configured step through %s posting and preserves intent', mode => {
      const folder = /scpost|pst$/.test(name) ? 'wo2300' : 'wo2292'
      const imported = importPostFile(readFileSync(`src/tests/post/fixtures/${folder}/${name}`, 'utf8'), name)
      expect(imported.ok).toBe(true)
      if (!imported.ok) throw new Error(imported.error)
      const job = vendorJob()
      const original = structuredClone(job)
      // Exercise the imported default and unrelated custom steps, without
      // changing the imported defaults or the existing vendor test oracles.
      for (const step of [imported.config.format.lineNumberStep, 2, 11, 1000]) {
        const cfg = { ...imported.config, format: { ...imported.config.format, lineNumberStep: step } }
        const options = { mode, pauseBetweenSetups: false, baseName: 'vendor', ext: 'nc', programContext: true }
        const on = postProject(job, job.setups, cfg, options)
        const off = postProject(job, job.setups, { ...cfg, format: { ...cfg.format, lineNumbers: false } }, options)
        expect(on.ok && off.ok).toBe(true)
        const programs = (r: typeof on) => r.combined ? [r.combined] : r.files!.map(f => f.result)
        programs(on).forEach((p, i) => {
          const plain = programs(off)[i]
          const body = withoutContext(p.gcode)
          const numbers = body.split('\n').filter(l => l.trim() && l.trim() !== '%').map(l => Number(/^N(\d+) /.exec(l)?.[1]))
          expect(numbers).toEqual(numbers.map((_, n) => step * (n + 1)))
          expect(strip(body)).toBe(withoutContext(plain.gcode))
          expect(p.operationSpans).toEqual(plain.operationSpans)
          expect(parseGcode(p.gcode).segments).toEqual(parseGcode(plain.gcode).segments)
          // Imported posts retain their existing uncertified-envelope status.
          expect(p.programContextEnvelope).toEqual(plain.programContextEnvelope)
          expect(p.programContextEnvelope?.included).toBe(false)
          expect(importProgramContextFromGcode(p.gcode).context).toBeNull()
        })
      }
      expect(job).toEqual(original)
    })
  })
  it('retains the legacy vendor zero-step fallback without changing built-in fallback', () => {
    const cfg = config(0)
    cfg.options = { ...cfg.options, vendorPost: 'cps' }
    expect(postProgram(input(), cfg).gcode.split('\n').slice(0, 2)).toEqual(expect.arrayContaining([expect.stringMatching(/^N10 /), expect.stringMatching(/^N20 /)]))
  })
  it.each([0, -1, 2.5, 1001, NaN, Infinity, undefined])('uses the visible default step for unsupported imported value %s', step => {
    const cfg = config(); cfg.format.lineNumberStep = step as number
    expect(postProgram(input(), cfg).gcode.split('\n').slice(0, 2).map(l => l.match(/^N\d+/)?.[0])).toEqual(['N10', 'N15'])
  })
  it('preserves framing CR bytes, blanks, delimiters, authored labels and block delete order', () => {
    const cfg = config()
    cfg.framing = { ...cfg.framing, programStart: ['%', '', '( header )\r', '/ G90', 'N30 G21', 'G17'], programEnd: ['M30', '%'] }
    cfg.options = { ...cfg.options, programEndMode: 'custom', programEndCustom: 'M30\n%' }
    const off = postProgram(input(), { ...cfg, format: { ...cfg.format, lineNumbers: false } })
    const on = postProgram(input(), cfg)
    expect(on.gcode.startsWith('%\n\nN10 ( header )\r\n/ N15 G90\nN30 G21\nN20 G17\n')).toBe(true)
    expect(on.gcode).not.toMatch(/^N\d+ %/m)
    expect(on.gcode.match(/^N30 /gm)).toHaveLength(1)
    expect(on.gcode.endsWith('%\n')).toBe(true)
    expect(on.gcode.replace(/^(?!N30 )((?:\/ )?)N\d+ /gm, '$1')).toBe(off.gcode)
  })
  describe.each(['single', 'combined'] as const)('%s authored framing', route => {
    it.each(['N30#1=1', 'N 30 G21', 'N 3\t0G21', '/ n\t30#1=1\r', 'N 3 0 . 0 #1=1', 'N30(comment)'])('preserves and reserves legal authored label %j', authored => {
      const cfg: PostConfig = { ...LINUXCNC_CONFIG,
        format: { ...LINUXCNC_CONFIG.format, lineNumbers: true, lineNumberStep: 5 },
        framing: { ...LINUXCNC_CONFIG.framing, programStart: [authored, 'G90', 'G90', 'G90', 'G90', 'G90'] } }
      const post = (c: PostConfig) => route === 'single' ? postProgram(input(), c) : postCombined([input()], c, { pauseBetweenSetups: false })
      const off = post({ ...cfg, format: { ...cfg.format, lineNumbers: false } }), on = post(cfg)
      expect(off.ok && on.ok).toBe(true)
      expect(off.gcode.split('\n')[0]).toBe(authored)
      expect(on.gcode.split('\n')[0]).toBe(authored)
      expect(on.gcode.split('\n').slice(1, 6)).toEqual(['N10 G90', 'N15 G90', 'N20 G90', 'N25 G90', 'N35 G90'])
      expect(on.gcode.split('\n').slice(1).join('\n')).not.toMatch(/^N30 /m)
      expect([authored, strip(on.gcode.split('\n').slice(1).join('\n'))].join('\n')).toBe(off.gcode)
      expect(on.operationSpans).toEqual(off.operationSpans)
    })
  })
  it.each(BUILT_IN_DIALECTS)('$id: comment-only and empty separate exports keep zero motion', dialect => {
    const op = makeOp({ toolpathMoves: [move({ type: 'rapid', z: 10 })] })
    const setup: Setup = { id: 's1', name: 'Setup', wcs: makeWcs(), operations: [op], notes: '',
      stock: { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 } } as unknown as Stock }
    const project: Project = { id: 'p', name: 'Empty cut', version: '1', createdAt: '', updatedAt: '', machine: makeMachine(),
      toolLibrary: [makeTool()], geometry: [], setups: [setup], activeSetupId: null, activeOperationId: null, sceneStock: {} as Project['sceneStock'], notes: '' }
    stampGenerationCurrent(project, setup, op, project.toolLibrary[0])
    for (const mode of ['combined', 'separate'] as const) {
      const result = postProject(project, [setup], { ...dialect, format: { ...dialect.format, lineNumbers: true, lineNumberStep: 5 } },
        { mode, pauseBetweenSetups: false, baseName: 'empty', ext: 'nc', programContext: true })
      expect(result.ok).toBe(true)
      const posted = result.combined ?? result.files![0].result
      expect(posted.gcode).toMatch(/^N10 [;(].*nothing left to cut/)
      expect(parseGcode(posted.gcode).segments).toEqual([])
      expect(posted.operationSpans).toEqual([])
    }
    expect(postProject(project, [], config(), { mode: 'separate', pauseBetweenSetups: false, baseName: 'empty', ext: 'nc' }).files).toEqual([])
  })
  it('preserves empty-job framing and wraps long programs into valid integer labels', () => {
    const empty = postCombined([], config(), { pauseBetweenSetups: false })
    expect(empty.meta?.opCount).toBe(0)
    expect(strip(empty.gcode)).toBe(postCombined([], UCCNC_CONFIG, { pauseBetweenSetups: false }).gcode)
    const cfg = config(1000)
    cfg.framing = { ...cfg.framing, programStart: Array.from({ length: 10020 }, () => 'G90') }
    const posted = postProgram(input(), cfg)
    const numbers = posted.gcode.split('\n').filter(Boolean).map(l => Number(/^N(\d+) /.exec(l)?.[1]))
    expect(numbers).toHaveLength(posted.meta!.lineCount)
    expect(numbers.every(n => Number.isInteger(n) && n >= 10 && n <= 99999)).toBe(true)
    expect(numbers.slice(98, 102)).toEqual([98010, 99010, 10, 1010])
  })
  it('production Open/stage/Post preview/download and every dialect/scope retain motion, context and exact off bytes', { timeout: 600000 }, async () => {
    const out = evidenceOutDir(evidence)
    // Async: a 50 s execFileSync starves vitest's worker RPC (onTaskUpdate timeout).
    await promisify(execFile)(process.execPath, [join(evidence, 'production.mjs'), out], { timeout: 540000, maxBuffer: 64 * 1024 * 1024 })
    type Run = { dialect: string; route: string; on: boolean; ok: boolean; diagnostics: unknown; programs: PostResult[] }
    type Data = { runs: Run[]; ui: Array<{ on: boolean; preview: string; downloaded: string }>; vendorUi: Array<{ name: string; step: number; preview: string; downloaded: string }> }
    const data = JSON.parse(readFileSync(join(out, 'production.json'), 'utf8')) as Data
    const before = JSON.parse(readFileSync(join(evidence, 'before/production.json'), 'utf8')) as Data
    expect(data.runs).toHaveLength(70)
    for (const run of data.runs) {
      expect(run.ok, `${run.dialect}/${run.route}: ${JSON.stringify(run.diagnostics)}`).toBe(true)
      const off = data.runs.find(r => r.dialect === run.dialect && r.route === run.route && !r.on)!
      const baseline = before.runs.find(r => r.dialect === run.dialect && r.route === run.route && !r.on)!
      for (const [i, p] of run.programs.entries()) {
        if (!run.on) expect(hash(p.gcode)).toBe(hash(baseline.programs[i].gcode))
        else {
          const first = run.dialect === 'vendor-import' ? 5 : 10
          expect(p.gcode.split('\n')[0]).toMatch(new RegExp(`^N${first} `))
          expect(p.gcode.split('\n')[1]).toMatch(new RegExp(`^N${first + 5} `))
          const body = withoutContext(p.gcode).split('\n').filter(l => l.trim() && l.trim() !== '%')
          expect(body.map(l => l.match(/^N\d+ /)?.[0])).toEqual(body.map((_, n) => `N${first + 5 * n} `))
          expect(strip(withoutContext(p.gcode))).toBe(withoutContext(off.programs[i].gcode))
          expect(p.operationSpans).toEqual(off.programs[i].operationSpans)
          expect(p.diagnostics).toEqual(off.programs[i].diagnostics)
          expect(parseGcode(p.gcode).segments).toEqual(parseGcode(off.programs[i].gcode).segments)
          if (p.programContextEnvelope?.included) {
            const numbered = decodeProgramContextEnvelope(p.gcode), plain = decodeProgramContextEnvelope(off.programs[i].gcode)
            expect(numbered.ok && plain.ok).toBe(true)
            if (numbered.ok && plain.ok) {
              // programIntentInputs hashes the COMPLETE post, including this
              // format switch. Both config fingerprints must change as well
              // as the exact-text motion digest; setup/tool/stock intent cannot.
              expect(numbered.payload.projectFingerprint).not.toBe(plain.payload.projectFingerprint)
              expect(numbered.payload.motionDigest).not.toBe(plain.payload.motionDigest)
              const intent = (payload: typeof numbered.payload) => ({ ...payload, motionDigest: '', projectFingerprint: '',
                ...('setups' in payload ? { setups: payload.setups.map(s => ({ ...s, projectFingerprint: '' })) } : {}) })
              expect(intent(numbered.payload)).toEqual(intent(plain.payload))
              if ('setups' in numbered.payload && 'setups' in plain.payload) {
                const previous = plain.payload.setups
                numbered.payload.setups.forEach((s, n) => expect(s.projectFingerprint).not.toBe(previous[n].projectFingerprint))
              }
            }
            expect(importProgramContextFromGcode(p.gcode).context).not.toBeNull()
          }
          if (run.route === 'arcs-off') expect(p.gcode).not.toMatch(/\bG[23]\b/)
        }
      }
    }
    expect(data.vendorUi).toHaveLength(8)
    for (const ui of data.vendorUi) {
      expect(ui.downloaded).toBe(ui.preview)
      const numbers = ui.downloaded.split('\n').filter(l => l.trim() && l.trim() !== '%').map(l => Number(/^N(\d+) /.exec(l)?.[1]))
      expect(numbers).toEqual(numbers.map((_, n) => ui.step * (n + 1)))
    }
    for (const ui of data.ui) {
      expect(ui.downloaded).toBe(ui.preview)
      if (ui.on) expect(ui.downloaded).toMatch(/^N10 /)
      else expect(ui.downloaded).toBe(before.ui.find(u => !u.on)!.downloaded)
    }
  })
})

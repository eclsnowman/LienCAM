import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as Post from '../../lib/post'
const { parseUserPostConfig, postProject, serializeUserPostConfig, UCCNC_CONFIG } = Post
// Keep the pre-fix production JSON path callable for the main negative control.
const importPostFile: typeof Post.importPostFile = Post.importPostFile ?? ((source: string, _name: string) => parseUserPostConfig(source))
import { vendorJob } from './fixtures/wo2292/job'
import { move, stampGenerationCurrent } from './helpers'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/wo2292/${name}`, import.meta.url), 'utf8')
const options = { mode: 'combined' as const, pauseBetweenSetups: false, baseName: 'vendor', ext: 'nc' }

describe('WO-2292 vendor post import through postProject', () => {
  for (const name of ['router-mm.pp', 'router-inch.pp', 'router-mm.cps', 'router-inch.cps']) {
    for (const mode of ['combined', 'separate'] as const) {
      it(`${name} carries declared output through ${mode} posting`, () => {
        const imported = importPostFile(fixture(name), name)
        expect(imported.ok, !imported.ok ? imported.error : '').toBe(true)
        if (!imported.ok) return
        const { config } = imported
        expect(parseUserPostConfig(serializeUserPostConfig(config))).toMatchObject({ ok: true, config })
        const inch = name.includes('inch')
        expect(config.format).toMatchObject({ units: inch ? 'inch' : 'mm', xyzDecimals: inch ? 5 : 4, feedDecimals: inch ? 3 : 2 })
        const job = vendorJob()
        const result = postProject(job, job.setups, config, { ...options, mode })
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
        const gcode = result.combined?.gcode ?? result.files?.[0].result.gcode ?? ''
        const plain = gcode.replace(/^N\d+ /gm, '')
        expect(plain).toContain(name.endsWith('pp') ? inch ? 'PP INCH HEADER' : 'PP HEADER' : inch ? 'CPS INCH HEADER' : 'CPS HEADER')
        expect(plain).toContain('FOOTER')
        expect(plain).toContain(inch ? 'G20' : 'G21')
        expect(plain).toContain(inch ? 'X1.00049' : 'X25.4123')
        expect(plain).toContain(inch ? 'F79.226' : 'F2012.35')
        expect(plain).toMatch(/G[23] /)
        expect(plain).toMatch(inch ? / R-?\d+(?:\.\d+)?/ : / I-?\d+(?:\.\d+)? J-?\d+(?:\.\d+)?/)
        expect(plain).toContain(inch ? 'M0\n' : 'T2 M6\n')
        if (inch) expect(plain).not.toContain('M6')
        else {
          expect(plain).toContain('M13 S12000')
          expect(plain).toContain('M18\n')
          expect(plain).toContain('M15\nM19\n')
          expect(config.wordTable.entries).toContainEqual(expect.objectContaining({ word: 'M18', category: 'coolant' }))
          const numbers = gcode.split('\n').filter(Boolean).map((line) => Number(/^N(\d+)/.exec(line)?.[1]))
          const step = name.endsWith('pp') ? 7 : 9
          expect(numbers).toEqual(numbers.map((_, i) => step * (i + 1)))
          expect(imported.report?.join('\n')).toContain(name.endsWith('pp') ? 'PROBE' : 'onCyclePoint')
        }
        expect(imported.report?.join('\n')).toContain('Mapped')
        expect(imported.report?.join('\n')).toContain('Defaulted')
        expect(plain).not.toContain('CONDITIONAL MUST NOT LEAK')
        expect(plain).not.toMatch(/\[[NXYZIF]\]|writeBlock/)
      })
    }
  }
  it('never executes vendor source or calls side-effect functions', () => {
    const effect = vi.fn()
    vi.stubGlobal('sideEffect', effect)
    expect(importPostFile(fixture('router-mm.cps'), 'unsafe.CPS').ok).toBe(true)
    expect(effect).not.toHaveBeenCalled()
    expect((globalThis as unknown as Record<string, unknown>).WO2292Executed).toBeUndefined()
    vi.unstubAllGlobals()
  })
  it('keeps readable partial posts, reports expressions and ignores commented declarations', () => {
    const imported = importPostFile('description = "Partial";\n// unit = IN;\nproperties = { showSequenceNumbers: readSetting(), sequenceNumberIncrement: 3 * 2 };\nfunction onOpen() { if (true) writeBlock("BAD"); writeBlock("GOOD"); }', 'partial.cps')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.config.format.units).toBe('mm')
    expect(imported.config.framing.programStart).not.toContain('BAD')
    expect(imported.report?.join('\n')).toContain('expression')
  })
  it('supports lines-only PP posts without importing unresolved header tokens', () => {
    const imported = importPostFile('POST_NAME = "Lines"\nUNITS = "MM"\nbegin HEADER\n"G90"\n"G0 Z[ZH]"\nbegin FEED_MOVE\n"G1[X][Y]"', 'lines.pp')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.config.capabilities.arcs).toBe(false)
    expect(imported.config.framing.programStart).toEqual(['G90', '{units}'])
    expect(imported.report?.join('\n')).toContain('dynamic vendor tokens')
  })
  it('preserves portable JSON and rejects unreadable files', () => {
    const json = serializeUserPostConfig(UCCNC_CONFIG)
    expect(importPostFile(json, 'existing.lienpost.json')).toEqual(parseUserPostConfig(json))
    expect(importPostFile('hello', 'wrong.pp').ok).toBe(false)
    expect(importPostFile('globalThis.sideEffect()', 'wrong.cps').ok).toBe(false)
  })
  it('posts existing explicit arcs as lines or R semicircles without mutating the ready job', () => {
    for (const linesOnly of [true, false]) {
      const imported = importPostFile(fixture('router-inch.pp'), 'router-inch.pp')
      if (!imported.ok) throw new Error(imported.error)
      imported.config.capabilities.arcs = !linesOnly
      const job = vendorJob()
      const setup = job.setups[0]
      const op = setup.operations[0]
      op.toolpathMoves = [
        move({ type: 'rapid', x: 25.4, y: 0, z: 10, role: 'rapid' }),
        move({ type: 'feed', x: 25.4, y: 0, z: -1, feed: 400, role: 'cut' }),
        move({ type: 'arc_ccw', x: 25.4, y: 0, z: -1, cx: 0, cy: 0, feed: 2012.3456, role: 'cut', dwellMs: 100 }),
      ]
      stampGenerationCurrent(job, setup, op, job.toolLibrary[0])
      const original = structuredClone(job)
      const result = postProject(job, [setup], imported.config, { ...options, selectedOpIds: { [setup.id]: [op.id] } })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      expect(job).toEqual(original)
      const code = result.combined!.gcode
      expect(code).not.toMatch(/\b[IJ]-?\d/)
      expect(code.match(/G4 /g)).toHaveLength(1)
      if (linesOnly) expect(code).not.toMatch(/\bG[23]\b/)
      else expect(code.match(/\bR1\b/g)).toHaveLength(2)
    }
  })
  it('keeps imported word mappings through a multi-setup pause and tool change', () => {
    const imported = importPostFile(fixture('router-mm.cps'), 'router-mm.cps')
    if (!imported.ok) throw new Error(imported.error)
    const job = vendorJob()
    job.setups[0].operations = [job.setups[0].operations[0]]
    const second = structuredClone(job.setups[0])
    second.id = 'back'; second.name = 'Back'; second.wcs.fixtureOffset = 55
    second.operations[0].id = 'back-cut'; second.operations[0].toolId = 't2'
    job.setups.push(second)
    for (const setup of job.setups) stampGenerationCurrent(job, setup, setup.operations[0], job.toolLibrary.find(tool => tool.id === setup.operations[0].toolId)!)
    const result = postProject(job, job.setups, imported.config, { ...options, pauseBetweenSetups: true })
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    const code = result.combined!.gcode.replace(/^N\d+ /gm, '')
    expect(code).toContain('M15\nM19\nM0')
    expect(code).toContain('T2 M6')
    expect(code.match(/M13 S12000/g)).toHaveLength(2)
    expect(result.combined!.operationSpans).toHaveLength(2)
  })
  it('leaves built-in output byte-identical and frames vendor literals without remapping them', () => {
    const job = vendorJob()
    const before = postProject(job, job.setups, UCCNC_CONFIG, options)
    const copy = structuredClone(UCCNC_CONFIG)
    copy.options.vendorSpindleCW = 'M13'
    expect(postProject(job, job.setups, copy, options)).toEqual(before)
    const vendor = importPostFile(fixture('router-mm.pp'), 'router-mm.pp')
    if (!vendor.ok) throw new Error(vendor.error)
    vendor.config.framing.programStart.unshift('M3 S6000 (literal header)')
    const result = postProject(job, job.setups, vendor.config, options)
    expect(result.combined?.gcode).toContain('M3 S6000 (literal header)')
    expect(result.combined?.operationSpans?.length).toBe(2)
    vendor.config.format.units = 'inch'
    const inchResult = postProject(job, job.setups, vendor.config, options)
    expect(inchResult.combined?.gcode).toContain('G90 G20')
    expect(inchResult.combined?.gcode).not.toContain('G90 G21')
  })
})

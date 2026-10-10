// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importPostFile, parseUserPostConfig, postProject, serializeUserPostConfig, syncUserPostControllers } from '../../lib/post'
import { vendorJob } from './fixtures/wo2292/job'
import { move, stampGenerationCurrent } from './helpers'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key), clear: () => memory.clear(),
} })
const { useCamStore } = await import('../../store')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const names = ['router-mm.scpost', 'router-inch.scpost', 'router-mm.pst', 'router-inch.pst']
const fixture = (name: string) => readFileSync(`src/tests/post/fixtures/wo2300/${name}`, 'utf8')
const options = { mode: 'combined' as const, pauseBetweenSetups: false, baseName: 'wo2300', ext: 'nc' }

beforeEach(() => {
  memory.clear(); syncUserPostControllers([])
  const project = vendorJob()
  act(() => useCamStore.setState({ project, toolLibrary: project.toolLibrary, consoleEvents: [], activeModal: null,
    appSettings: { ...useCamStore.getState().appSettings, exportUnits: 'mm' } }))
})
afterEach(() => { cleanup(); syncUserPostControllers([]); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('WO-2300 static SheetCAM and Mastercam imports', () => {
  for (const name of names) {
    for (const mode of ['combined', 'separate'] as const) {
      it(`${name} round-trips and emits its settings through ${mode} postProject`, () => {
        const imported = importPostFile(fixture(name), name.toUpperCase())
        expect(imported.ok, !imported.ok ? imported.error : '').toBe(true)
        if (!imported.ok) return
        const { config } = imported
        expect(parseUserPostConfig(serializeUserPostConfig(config))).toMatchObject({ ok: true, config })
        const inch = name.includes('inch')
        expect(config.format).toMatchObject({ units: inch ? 'inch' : 'mm', xyzDecimals: inch ? 5 : 4, feedDecimals: inch ? 3 : 2, lineNumbers: !inch })
        expect(config.capabilities).toMatchObject({ arcCenterMode: inch ? 'r' : 'ijk', toolChange: inch ? 'pause' : 'm6', comment: inch ? 'semicolon' : 'paren' })
        const job = vendorJob()
        const result = postProject(job, job.setups, config, { ...options, mode })
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
        const rawCode = mode === 'combined' ? result.combined!.gcode : result.files![0].result.gcode
        const code = rawCode.replace(/^N\d+ /gm, '')
        expect(code).toContain(inch ? 'G90 G20' : 'G90 G21')
        expect(code).toContain(inch ? 'X1.00049' : 'X25.4123')
        expect(code).toContain(inch ? 'F79.226' : 'F2012.35')
        expect(code).toContain('HEADER')
        expect(code).toContain('FOOTER')
        expect(code.trim().endsWith(inch ? 'M30' : 'M2')).toBe(true)
        expect(code).not.toContain('CONDITIONAL MUST NOT LEAK')
        expect(code).not.toMatch(/post\.|pbld|\*sm|WO2300_SIDE_EFFECT/)
        if (inch) {
          expect(code).not.toMatch(/\b[IJ]-?\d/)
          expect(code).toMatch(/\bR-?\d/)
          expect(code).toContain('M0')
          expect(code).not.toContain('M6')
        } else {
          expect(code).toMatch(/\bI-?\d/)
          expect(code).toContain('T2 M6')
          expect(code).not.toContain('\nM0\n')
          expect(code).toContain('M13 S12000')
          expect(code).toContain('M18')
          expect(config.wordTable.entries).toContainEqual(expect.objectContaining({ word: 'M13', category: 'spindle' }))
          const numbered = rawCode.match(/^N(\d+)/gm)!
          expect(numbered.slice(0, 3)).toEqual(['N7', 'N14', 'N21'])
        }
        expect(imported.report?.join('\n')).toContain('Mapped')
        expect(imported.report?.join('\n')).toContain('Defaulted')
        expect(imported.report?.join('\n')).toContain('Not supported:')
      })
    }
    it(`${name} saves and selects via the real modal, previews and reports`, async () => {
      render(createElement(PostProcessModal))
      act(() => useCamStore.getState().openModal('post-process'))
      const input = screen.getByTestId('post-import-input') as HTMLInputElement
      expect(input.accept).toContain('.scpost')
      expect(input.accept).toContain('.pst')
      fireEvent.click(screen.getByRole('button', { name: 'Import Post...' }))
      const source = fixture(name)
      await act(async () => fireEvent.change(input, { target: { files: [{ name, size: source.length, text: async () => source }] } }))
      await waitFor(() => expect(JSON.parse(memory.get('liencam.userPosts') ?? '[]')).toHaveLength(1))
      const [saved] = JSON.parse(memory.get('liencam.userPosts')!)
      expect(screen.getByTestId('post-definition-select').textContent).toContain(saved.label)
      expect(saved.builtin).toBe(false)
      expect(parseUserPostConfig(serializeUserPostConfig(saved)).ok).toBe(true)
      const events = useCamStore.getState().consoleEvents
      for (const prefix of ['Mapped', 'Defaulted', 'Not supported:']) expect(events.some(event => event.message.startsWith(prefix))).toBe(true)
      expect(events.some(event => event.severity === 'error')).toBe(false)
      const preview = screen.getByTestId('post-gcode-preview').textContent!
      expect(preview).toContain(name.includes('inch') ? 'X1.00049' : 'X25.4123')
      expect(preview).toContain(name.includes('inch') ? 'G20' : 'G21')
      const project = useCamStore.getState().project
      const result = postProject(project, project.setups, saved, options)
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      expect(result.combined!.gcode).toContain('FOOTER')
    })
  }
  it('never executes source, even side-effecting Lua', () => {
    const effect = vi.fn()
    vi.stubGlobal('sideEffect', effect)
    vi.stubGlobal('os', { execute: effect })
    expect(importPostFile(fixture('router-mm.scpost'), 'unsafe.scpost').ok).toBe(true)
    expect(effect).not.toHaveBeenCalled()
    expect((globalThis as unknown as Record<string, unknown>).WO2300Executed).toBeUndefined()
  })
  it('handles nested Lua blocks, escaped strings, dead callbacks and the last definition', () => {
    const source = `--[[ function OnInit() post.Text("BAD") end ]]
function OnInit() post.Text("OLD\\n") end
function OnInit()
  post.Text("(if end -- \\"quoted\\")\\nG21\\n")
  if true then for i = 1, 2 do while true do post.Text("BAD\\n") end end end
  post.Text("GOOD\\n")
end
function OnFinish() post.Text("M30\\n") end`
    const imported = importPostFile(source, 'nested.scpost')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.config.framing.programStart.join('\n')).toContain('GOOD')
    expect(imported.config.framing.programStart.join('\n')).not.toMatch(/BAD|OLD/)
    expect(imported.config.framing.programEnd).toEqual(['M30'])
  })
  it('retains partial readable posts and rejects files without post structure', () => {
    expect(importPostFile('function OnMove() post.ModalText("G01") end', 'partial.scpost').ok).toBe(true)
    expect(importPostFile('arcoutput : 0\n', 'partial.pst').ok).toBe(true)
    for (const ext of ['scpost', 'pst']) expect(importPostFile('sideEffect("hello")', `wrong.${ext}`).ok).toBe(false)
  })
  it('isolates Mastercam blocks and does not import a dynamic footer or commented settings', () => {
    const source = '# arcoutput : 1\narcoutput : 0\npheader\n  pbld, "G21", e\npeof\n  if tool > 0, "BAD", e\n  pbld, "M30", e\npother\n  pbld, "LEAK", e\n'
    const imported = importPostFile(source, 'partial.pst')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.config.capabilities.arcCenterMode).toBe('ijk')
    expect(imported.config.framing.programEnd).toEqual(['M30'])
    expect(imported.report?.join('\n')).toContain('conditional output')
  })
  it('does not treat Lua strings as callback declarations or nested calls as direct output', () => {
    const source = `function OnInit() post.Text("GOOD\\nG21\\n") end
message = [=[function OnInit() post.Text("BAD\\n") end]=]
function OnFinish() sideEffect(post.Text("NESTED MUST NOT LEAK\\n")) post.Text("M30\\n") end`
    const imported = importPostFile(source, 'strings.scpost')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.config.framing.programStart).toContain('GOOD')
    expect(imported.config.framing.programStart.join('\n')).not.toContain('BAD')
    expect(imported.config.framing.programEnd).toEqual(['M30'])
  })
  it('omits bracketed Mastercam conditional output from framing and tool changes', () => {
    const source = `arcoutput : 0
pheader
  if tool > 0,
    [
    pbld, "BAD", e
    ]
  pbld, "G21", e
ptlchg
  if tool > 0, [
    pbld, "M0", e
    ]
  pbld, "T", t, "M6", e
peof
  pbld, "M30", e`
    const imported = importPostFile(source, 'branches.pst')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.config.framing.programStart).toEqual(['{units}'])
    expect(imported.config.capabilities.toolChange).toBe('m6')
    expect(imported.config.options.toolChangePause).toBe(false)
    expect(imported.config.framing.programEnd).toEqual(['M30'])
  })
  it('keeps unit selection in a SheetCAM header whose only output is conditional units', () => {
    const imported = importPostFile('function OnInit()\nif scale == metric then post.Text("G21\\n") else post.Text("G20\\n") end\nend\nfunction OnFinish() post.Text("M30\\n") end', 'units.scpost')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.config.framing.programStart).toEqual(['{units}'])
    const job = vendorJob()
    for (const units of ['mm', 'inch'] as const) {
      imported.config.format.units = units
      expect(postProject(job, job.setups, imported.config, options).combined!.gcode.split('\n')[0]).toBe(units === 'mm' ? 'G21' : 'G20')
    }
  })
  it.each(['Text', 'ModalText'])('preserves static framing after newline-terminated dynamic SheetCAM %s', async method => {
    const source = `postName = "Mach3 stock-shaped header"
function OnInit()
  post.${method}(" (Filename: ", filename, ")\\n")
  post.${method}(" (Post processor: ", postName, ")\\n")
  post.${method}(" (Date: ", date, ")\\n")
  post.Text (" G53 G90 G40\\n F1\\n G21\\n")
end
function OnFinish()
  post.${method}(" (Finished: ", date, ")\\n")
  post.Text("M30\\n")
end`
    const imported = importPostFile(source, 'stock.scpost')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.config.framing.programStart).toEqual(['G53 G90 G40', 'F1', '{units}'])
    expect(imported.config.framing.programEnd).toEqual(['M30'])
    expect(imported.report?.join('\n')).toContain('Mapped program start: 3 lines')
    expect(imported.report?.join('\n')).toContain('OnInit dynamic output')
    const job = vendorJob()
    for (const mode of ['combined', 'separate'] as const) {
      const result = postProject(job, job.setups, imported.config, { ...options, mode })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const code = mode === 'combined' ? result.combined!.gcode : result.files![0].result.gcode
      expect(code).toContain('G53 G90 G40\nF1\nG21\n')
      expect(code.trim().endsWith('M30')).toBe(true)
      expect(code).not.toMatch(/Filename:|Post processor:|Date:|Finished:/)
    }
    render(createElement(PostProcessModal))
    act(() => useCamStore.getState().openModal('post-process'))
    const input = screen.getByTestId('post-import-input')
    await act(async () => fireEvent.change(input, { target: { files: [{ name: 'stock.scpost', size: source.length, text: async () => source }] } }))
    await waitFor(() => expect(JSON.parse(memory.get('liencam.userPosts') ?? '[]')).toHaveLength(1))
    const [saved] = JSON.parse(memory.get('liencam.userPosts')!)
    expect(saved.framing.programStart).toEqual(imported.config.framing.programStart)
    expect(screen.getByTestId('post-definition-select').textContent).toContain(saved.label)
    expect(screen.getByTestId('post-gcode-preview').textContent).toContain('G53 G90 G40\nF1\nG21\n')
  })
  it('keeps SheetCAM dynamic output pending until a literal newline boundary', () => {
    const imported = importPostFile(`function OnInit()
  post.Text(" (Date: ", date, ")")
  post.Text(" MUST NOT LEAK\\n")
  post.ModalText(" (File: ", filename, ")\\nG53 G90 G40\\n")
  post.Text("F1\\n")
end`, 'boundaries.scpost')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.config.framing.programStart).toEqual(['G53 G90 G40', 'F1', '{units}'])
  })
  it('posts explicit full circles through R and lines-only SheetCAM without mutating the job', () => {
    for (const linesOnly of [false, true]) {
      const imported = importPostFile(fixture('router-inch.scpost'), 'radius.scpost')
      if (!imported.ok) throw new Error(imported.error)
      imported.config.capabilities.arcs = !linesOnly
      const job = vendorJob()
      const setup = job.setups[0]; const op = setup.operations[0]
      op.toolpathMoves = [move({ type: 'rapid', x: 25.4, y: 0, z: 10, role: 'rapid' }),
        move({ type: 'feed', x: 25.4, y: 0, z: -1, feed: 400, role: 'cut' }),
        move({ type: 'arc_ccw', x: 25.4, y: 0, z: -1, cx: 0, cy: 0, feed: 400, role: 'cut' })]
      stampGenerationCurrent(job, setup, op, job.toolLibrary[0])
      const original = structuredClone(job)
      const result = postProject(job, [setup], imported.config, { ...options, selectedOpIds: { [setup.id]: [op.id] } })
      expect(result.ok).toBe(true)
      expect(job).toEqual(original)
      const code = result.combined!.gcode
      if (linesOnly) expect(code).not.toMatch(/\bG[23]\b/)
      else expect(code.match(/\bR1\b/g)).toHaveLength(2)
    }
  })
})

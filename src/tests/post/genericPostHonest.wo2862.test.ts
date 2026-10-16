import { execFile } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'

type Selection = { checked: boolean; mixed: boolean; selectedOps: number }
type Output = { id: string; label: string; gcode: string; inch?: string; separate?: string; linear?: string }
let report: {
  posted: Output[]; label: string; initial: Selection; partial: Selection; restored: Selection;
  none: Selection; all: Selection; multiInitial: Selection; multiActiveOnly: boolean[];
  noEnabledSetupScopes: { kind: string; master: Selection; setupChecks: boolean[]; title: string; duplicateWorkOffset: boolean }[];
  multiAll: Selection; nestedEscapeKeepsDialog: boolean; escapeClosesDialog: boolean; differences: string[]
}

beforeAll(async () => {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['src/tests/evidence/WO-2862/exercise.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout))
  })
  const result = stdout.split('\n').find(line => line.startsWith('WO2862_RESULT='))
  expect(result, stdout).toBeDefined()
  report = JSON.parse(result!.slice('WO2862_RESULT='.length))
}, 330_000)

function generic() { return report.posted.find(p => p.id === 'generic')! }
function expectModes(gcode: string, units: string) {
  const lines = gcode.split(/\r?\n/)
  const move = lines.findIndex(line => /\bG0?[0123]\b.*\b[XYZ]/.test(line))
  expect(move).toBeGreaterThan(0)
  const prefix = lines.slice(0, move).join('\n')
  expect(prefix).toMatch(/\bG90\b/)
  expect(prefix).toMatch(new RegExp(`\\b${units}\\b`))
}

describe('WO-2862 production Fixture Plate posting and dialog', () => {
  it('names the arc-capable Generic post honestly in the config and dialog', () => {
    expect(generic().label).toBe('Generic')
    expect(report.label).toBe('Generic')
  })
  it('states absolute metric modes before the first combined move', () => {
    expectModes(generic().gcode, 'G21')
    expect(generic().gcode).toMatch(/\bG[23]\b.*\b[IJ]/)
  })
  it('states absolute inch modes before the first move', () => {
    expectModes(generic().inch!, 'G20')
    expect(generic().inch).not.toMatch(/\bG21\b/)
  })
  it('states modes in a separate file and still allows Emit arcs to be turned off', () => {
    expectModes(generic().separate!, 'G21')
    expectModes(generic().linear!, 'G21')
    expect(generic().linear).not.toMatch(/\bG[23]\b/)
  })
  it('keeps all four controller dialect files byte-identical to main', () => {
    expect(report.posted.filter(p => p.id !== 'generic')).toHaveLength(4)
    expect(report.differences).toEqual([])
  })
  it('checks All operations when all children are selected on opening', () => {
    expect(report.initial.checked).toBe(true)
    expect(report.initial.mixed).toBe(false)
    expect(report.initial.selectedOps).toBeGreaterThan(1)
  })
  it('shows mixed selection and returns to checked when a child is restored', () => {
    expect(report.partial).toMatchObject({ checked: false, mixed: true })
    expect(report.restored).toMatchObject({ checked: true, mixed: false })
  })
  it('selects none and then all from the master checkbox', () => {
    expect(report.none).toEqual({ checked: false, mixed: false, selectedOps: 0 })
    expect(report.all).toEqual(report.initial)
  })
  it('retains active-setup scope on opening a multi-setup project', () => {
    expect(report.multiActiveOnly).toEqual([true, false])
    expect(report.multiInitial).toMatchObject({ checked: false, mixed: true })
    expect(report.multiAll).toMatchObject({ checked: true, mixed: false })
  })
  for (const kind of ['empty', 'disabled-only']) {
    it(`excludes an unchecked ${kind} setup even when every enabled operation is selected`, () => {
      const scope = report.noEnabledSetupScopes.find(scope => scope.kind === kind)!
      expect(scope.master).toMatchObject({ checked: true, mixed: false, selectedOps: 5 })
      expect(scope.setupChecks).toEqual([true, false])
      expect(scope.title).toContain('1 setup, 5 operations')
      expect(scope.duplicateWorkOffset).toBe(false)
    })
  }
  it('lets the listbox consume Escape before closing the Post dialog', () => {
    expect(report.nestedEscapeKeepsDialog).toBe(true)
    expect(report.escapeClosesDialog).toBe(true)
  })
})

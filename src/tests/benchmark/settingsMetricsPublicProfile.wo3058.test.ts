import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { machineViolations } from './settingsMetrics.alpha3'
import fixture from '../fixtures/benchmark/settingsMetricsProfile.json'

const ROOT = resolve(__dirname, '../../..')
const ENTRY = 'src/tests/benchmark/settingsMetrics.alpha3.ts'
const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true }

// Every repo file the module can reach through relative imports.
function importClosure(entry: string): string[] {
  const seen = new Set<string>()
  const visit = (path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    if (!/\.[cm]?[jt]sx?$/.test(path)) return
    const text = readFileSync(join(ROOT, path), 'utf8')
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      if (!fileName.startsWith('.')) continue
      const input = fileName.split(/[?#]/)[0]
      const resolved = ts.resolveModuleName(input, join(ROOT, path), options, ts.sys).resolvedModule?.resolvedFileName
        ?? (existsSync(resolve(ROOT, dirname(path), input)) ? resolve(ROOT, dirname(path), input) : null)
      if (resolved) visit(relative(ROOT, resolved).replaceAll('\\', '/'))
    }
  }
  visit(entry)
  return [...seen]
}

describe('WO-3058: settings metrics read a public machine fixture', () => {
  it('imports nothing under docs/machine/profiles, directly or through its imports', () => {
    const closure = importClosure(ENTRY)
    expect(closure.filter(path => path.startsWith('docs/machine/profiles/'))).toEqual([])
    expect(closure).toContain('src/tests/fixtures/benchmark/settingsMetricsProfile.json')
  })

  it('the fixture carries exactly the fields settingsMetrics reads, with the LienCNC V2 values', () => {
    expect(fixture).toEqual({
      id: 'liencnc-v2', minSpindleRpm: 8000, maxSpindleRpm: 24000, rapidRate: 8000,
      axisLimits: { x: { maxCutting: 9000 }, y: { maxCutting: 10000 }, z: { maxCutting: 8000 } },
    })
  })

  it('the axis and spindle limits still decide M-SET-1 the same way', () => {
    const at = (x: number, y: number, z: number, feed?: number) => ({ type: 'feed' as const, x, y, z, feed })
    expect(machineViolations(7999, [])).toBe(1)
    expect(machineViolations(24001, [])).toBe(1)
    expect(machineViolations(18000, [])).toBe(0)
    expect(machineViolations(18000, [at(0, 0, 0), at(10, 0, 0, 9001)])).toBe(1)
    expect(machineViolations(18000, [at(0, 0, 0), at(10, 0, 0, 9000)])).toBe(0)
    expect(machineViolations(18000, [at(0, 0, 0), at(0, 10, 0, 10001)])).toBe(1)
    expect(machineViolations(18000, [at(0, 0, 0), at(0, 0, 10, 8001)])).toBe(1)
    expect(machineViolations(18000, [at(0, 0, 0), at(0, 0, 10, 8000)])).toBe(0)
  })
})

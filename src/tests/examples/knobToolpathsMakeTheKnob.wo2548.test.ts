import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../..')
const part = path.join(root, 'examples/06-knob-handwheel/knob-handwheel.camproject')
// A test run writes to an ignored folder; the committed src/tests/evidence/WO-2548/ is never touched by a gate.
const evidence = path.join(root, '.worktrees/wo2548-run')
const negative = process.env.WO2548_BASELINE_REF
const input = negative ? path.join(evidence, 'main/knob-handwheel.camproject') : part
if (negative) {
  mkdirSync(path.dirname(input), { recursive: true })
  writeFileSync(input, execFileSync('git', ['show', `${negative}:examples/06-knob-handwheel/knob-handwheel.camproject`], { cwd: root, maxBuffer: 20_000_000 }))
}
const project = JSON.parse(readFileSync(input, 'utf8'))

describe('WO-2548: the shipped knob recipe makes the knob', () => {
  it('roughs first, then finishes the dome and walls with reachable appropriate cutters', () => {
    const ops = project.setups[0].operations
    expect(ops.map((o: { type: string }) => o.type)).toEqual(['adaptive_3d', 'parallel_3d', 'waterline_3d'])
    for (const [index, op] of ops.slice(1).entries()) {
      expect(project.toolLibrary.find((t: { id: string }) => t.id === op.toolId)).toMatchObject({ type: index === 0 ? 'ball_end_mill' : 'flat_end_mill', diameter: 3, fluteLength: 18 })
      expect(op.params.finishDepth).toBe(16.5)
      expect(op.params.stepover ?? op.params.stepdown).toBe(0.2)
      expect(op.params.tolerance).toBe(index === 0 ? 0.05 : 0.025)
    }
    expect(ops[2].params).toMatchObject({ minSlopeDeg: 0, flatAreaDetection: false })
  })

  it('opens the shipped project, Generates all, and measures the completed production stock surface', async () => {
    const pending = promisify(execFile)(process.execPath, ['tools/examples/verify-knob-finish.mjs', '--generate', ...(negative ? ['--baseline'] : [])], {
      cwd: root, env: { ...process.env, WO2548_PROJECT: input, WO2548_OUT_DIR: evidence }, timeout: 2_400_000, maxBuffer: 10_000_000,
    })
    mkdirSync(evidence, { recursive: true })
    pending.child.stdout?.on('data', chunk => process.stdout.write(chunk))
    pending.child.stderr?.on('data', chunk => process.stderr.write(chunk))
    const { stdout: output } = await pending
    writeFileSync(path.join(evidence, negative ? 'main-test-output.txt' : 'focused-test-output.txt'), output)
    const report = JSON.parse(readFileSync(path.join(evidence, negative ? 'main' : 'finish', 'verification.json'), 'utf8'))
    expect(report.generated).toBe(true)
    expect(report.completed).toBe(true)
    expect(report.operations.map((o: { status: string }) => o.status)).toEqual(['ready', 'ready', 'ready'])
    expect(report.deviation.samples).toBeGreaterThan(10_000)
    expect(report.deviation.maxMm).toBeLessThanOrEqual(0.25)
    if (!negative) expect(report.deviation.rmsMm).toBeLessThan(report.roughDeviation.rmsMm / 10)
  }, 2_400_000)
})

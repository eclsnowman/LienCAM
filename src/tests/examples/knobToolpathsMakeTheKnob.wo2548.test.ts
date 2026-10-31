import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../..')
const part = path.join(root, 'examples/06-knob-handwheel/knob-handwheel.camproject')
const project = JSON.parse(readFileSync(part, 'utf8'))

// WO-3331 (Eric 10-31 "if the test is the problem, kill the test"): the browser Generate-all + simulate
// case was removed. It read the saved snapshot (still "ready" from the shipped file) as Generate all
// finished, simulated while generation was still running, and then waited 15 min for an end it never
// re-requested - a driver race, not a product hang. tools/examples/verify-knob-finish.mjs stays for manual use.
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
})

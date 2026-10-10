import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project, Tool } from '../../types'
import { placedBoundingBox, resolveWorkholdingPlacements, setupScopeIncludes } from '../../lib/workholding/resolveWorkholding'
import { clampEdgeLost } from '../../lib/workholding/clamps'
import { checkWorkholdingContact } from '../../lib/simulation/workholdingContact'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'

const root = path.resolve(__dirname, '../../..')
const part = path.join(root, 'examples/04-tool-storage-bar')
const evidence = path.join(root, 'src/tests/evidence/WO-2443')
const project = JSON.parse(readFileSync(path.join(part, 'tool-storage-bar.camproject'), 'utf8')) as Project & { toolLibrary: Tool[] }
const reopened = JSON.parse(readFileSync(path.join(evidence, 'readback.json'), 'utf8')).project as Project
const verification = JSON.parse(readFileSync(path.join(evidence, 'verification.json'), 'utf8'))

function holders(setupId: string) {
  return resolveWorkholdingPlacements(project, setupId).placements.map(placement => {
    const row = project.geometry.find(g => g.id === placement.geometryId)!
    return { placement, mesh: placedBoundingBox(placement, row)! }
  })
}

describe('WO-2443: tool storage bar workholding from the production builder', () => {
  it('reopens both setups with all six operations current and the same holding plan', () => {
    expect(reopened.id).toBe(project.id)
    expect(reopened.workholding).toEqual(project.workholding)
    expect(reopened.setups).toHaveLength(2)
    expect(reopened.setups.flatMap(s => s.operations)).toHaveLength(6)
    for (const setup of reopened.setups) {
      expect(setup.holdingMethod).toBe('clamps')
      expect(setup.operations.map(op => op.status)).toEqual(['ready', 'ready', 'ready'])
      expect(setup.notes).toContain('flip end-for-end about Y, back against the stop, re-clamp')
    }
    expect(project.setups[0].wcs.fixtureOffset).toBe(54)
    expect(project.setups[1].wcs.fixtureOffset).toBe(55)
    expect(project.setups[1].wcs.origin).toEqual(project.setups[0].wcs.origin)
    expect(project.setups[1].wcs.origin).toEqual({ x: -80, y: -25, z: 0 })
    expect(project.setups[1].flipOf).toEqual({ setupId: project.setups[0].id, axis: 'y' })
    expect(reopened.setups.map(s => s.wcs)).toEqual(project.setups.map(s => s.wcs))
  })

  it('places the two example 02 toe clamps beyond X +/-62 and a touching X-minus stop in each setup', () => {
    expect(project.workholding).toBeDefined()
    expect(project.workholding!.definitions).toHaveLength(1)
    expect(project.workholding!.definitions[0].kind).toBe('clamp')
    expect(project.workholding!.instances).toHaveLength(4)
    for (const setup of project.setups) {
      const clamps = project.workholding!.instances.filter(i => setupScopeIncludes(i.setupScope, setup.id))
      expect(clamps).toHaveLength(2)
      expect(clamps.map(i => i.worldPose.position.x).sort((a, b) => a - b)).toEqual([-99, 99])
      for (const clamp of clamps) {
        expect(clamp.placement?.kind).toBe('boundary')
        expect(clampEdgeLost(project, clamp)).toBe(false)
        expect(clamp.worldPose.position.y).toBeCloseTo(0)
        expect(clamp.worldPose.position.z).toBe(0)
      }
      const boxes = holders(setup.id)
      expect(boxes).toHaveLength(3)
      for (const { placement, mesh } of boxes) {
        const xs = Array.from(mesh.positions).filter((_, i) => i % 3 === 0)
        if (placement.source === 'instance') {
          expect(Math.min(...xs) >= 62 || Math.max(...xs) <= -62).toBe(true)
          expect(Math.min(...xs) > 0 ? Math.min(...xs) : -Math.max(...xs)).toBeCloseTo(69)
        } else {
          expect(placement.name).toBe('fixed-end-stop')
          expect(Math.min(...xs)).toBe(-88)
          expect(Math.max(...xs)).toBe(-80)
        }
      }
    }
  })

  it('preserves the hole pattern and the through drill (-13) and bore (-12.5) depths on Top with a chamfer-only Bottom', () => {
    const circles = (name: string) => [...readFileSync(path.join(part, name), 'utf8').matchAll(/<circle cx="([^"]+)" cy="25" r="([^"]+)"/g)]
      .map(m => [Number(m[1]), Number(m[2])])
    expect(circles('top.svg')).toEqual([[25, 3.25], [68, 4.25], [121, 6.25]])
    expect(circles('bottom.svg')).toEqual([[135, 3.25], [92, 4.25], [39, 6.25]])
    const [top, bottom] = project.setups
    expect(top.operations.map(op => op.type)).toEqual(['drill', 'bore', 'chamfer'])
    expect(bottom.operations.map(op => op.type)).toEqual(['chamfer'])
    const endOffset = (op: (typeof top.operations)[number]) =>
      (op.smartHeight as any).intent.machining.end.value.plane.offsetMm
    expect(top.operations[0].params).toMatchObject({ cycleType: 'peck', peckDepth: 3 })
    expect(endOffset(top.operations[0])).toBe(-13)
    expect(endOffset(top.operations[1])).toBe(-12.5)
  })

  it('keeps the actual saved cuts and leads clear of all holder boxes and simulates both sides without contact', () => {
    for (const setup of project.setups) {
      const workholding = holders(setup.id).map(h => h.mesh)
      for (const op of setup.operations) {
        expect(op.toolpathMoves!.length).toBeGreaterThan(0)
        const tool = project.toolLibrary.find(t => t.id === op.toolId)!
        // Computed application moves are in world coordinates, like the resolved holders.
        const sampled = sampleArcMovesForLinearConsumers(op.toolpathMoves!, {})
        for (const move of sampled) {
          if (move.type !== 'rapid') expect(Math.abs(move.x) + tool.diameter / 2).toBeLessThan(62)
        }
        expect(checkWorkholdingContact({ moves: op.toolpathMoves!, tool, workholding, allowanceMm: 0 }).hits).toEqual([])
      }
    }
    expect(verification.simulations).toHaveLength(2)
    for (const simulation of verification.simulations) {
      expect(simulation.reachedEnd).toBe(true)
      expect(simulation.removedVolumeMm3).toBeGreaterThan(0)
      expect(simulation.contacts).toEqual([])
    }
    expect(verification.errors).toEqual([])
  })

  it('downloads a production job sheet with two clamps, the stop, and the flip instruction for both setups', () => {
    const text = readFileSync(path.join(part, 'job-sheet.txt'), 'utf8')
    expect(text.match(/Method: Clamps/g)).toHaveLength(2)
    expect(text.match(/Clamp: "example-02-toe-clamp" x 2/g)).toHaveLength(2)
    expect(text.match(/Holder: "fixed-end-stop"/g)).toHaveLength(2)
    expect(text.match(/flip end-for-end about Y, back against the stop, re-clamp/g)).toHaveLength(2)
    expect(readFileSync(path.join(part, 'job-sheet.pdf')).subarray(0, 4).toString()).toBe('%PDF')
  })
})

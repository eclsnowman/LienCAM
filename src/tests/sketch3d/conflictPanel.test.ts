// Criterion 4: conflict / redundant panel - ids from the solver, human labels + entityIds from
// the panel model, and "delete the flagged constraint -> solvable again" for both severities.
import { afterEach, describe, expect, it } from 'vitest'
import { computeConflictPanel, createSketch3dSolveService, removeConstraint } from '../../sketch3d'
import { bracketFixture } from './fixtures/bracketFixture'

const openServices: { dispose: () => void }[] = []

afterEach(() => {
  while (openServices.length > 0) openServices.pop()?.dispose()
})

async function solver() {
  const service = await createSketch3dSolveService()
  openServices.push(service)
  return service
}

describe('sketch3d conflict / redundant panel (criterion 4)', () => {
  it('surfaces a conflicting constraint as an id + human label, and removing it restores solvability', async () => {
    const service = await solver()
    const base = bracketFixture()
    const conflicted = {
      ...base,
      constraints: [
        ...base.constraints,
        { id: 'bd1-conflict', kind: 'distance' as const, a: { entityId: 'bl1', site: 'start' as const }, b: { entityId: 'bl1', site: 'end' as const }, value: 999 },
      ],
    }

    const result = service.solve(conflicted)
    expect(result.status).toBe('conflicting')
    expect(result.conflicting).toContain('bd1-conflict')

    const panel = computeConflictPanel(conflicted, result)
    expect(panel.isEmpty).toBe(false)
    const entry = panel.conflicting.find((e) => e.constraintId === 'bd1-conflict')
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe('distance')
    expect(entry!.label).toContain('999')
    expect(entry!.entityIds).toContain('bl1')

    const repaired = removeConstraint(conflicted, 'bd1-conflict')
    const repairedResult = service.solve(repaired)
    expect(repairedResult.status).toBe('success')
    expect(computeConflictPanel(repaired, repairedResult).isEmpty).toBe(true)
  })

  it('surfaces a redundant (non-conflicting) constraint as an id + human label, and removing it restores the non-redundant solve', async () => {
    const service = await solver()
    const base = bracketFixture()
    const withRedundant = {
      ...base,
      constraints: [
        ...base.constraints,
        // bl1 is already horizontal (bh1) - a duplicate horizontal constraint is consistent
        // (not contradictory) but adds no new information: redundant, not conflicting.
        { id: 'bh1-redundant', kind: 'horizontal' as const, line: 'bl1' },
      ],
    }

    const result = service.solve(withRedundant)
    expect(result.status).toBe('redundant')
    expect(result.redundant).toContain('bh1-redundant')
    expect(result.conflicting).toEqual([])

    const panel = computeConflictPanel(withRedundant, result)
    expect(panel.isEmpty).toBe(false)
    const entry = panel.redundant.find((e) => e.constraintId === 'bh1-redundant')
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe('horizontal')
    expect(entry!.severity).toBe('redundant')

    const repaired = removeConstraint(withRedundant, 'bh1-redundant')
    const repairedResult = service.solve(repaired)
    expect(repairedResult.status).toBe('success')
    expect(repairedResult.redundant).toEqual([])
  })
})

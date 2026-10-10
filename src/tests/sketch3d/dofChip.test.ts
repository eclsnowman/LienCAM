import { afterEach, describe, expect, it } from 'vitest'
import { computeDofChip, createSketch3dSolveService } from '../../sketch3d'
import { bracketFixture, bracketPartialFixture, emptySketchFixture } from './fixtures/bracketFixture'

const openServices: { dispose: () => void }[] = []

afterEach(() => {
  while (openServices.length > 0) openServices.pop()?.dispose()
})

async function solver() {
  const service = await createSketch3dSolveService()
  openServices.push(service)
  return service
}

describe('sketch3d DOF chip (criterion 3)', () => {
  it('reports 0 DOF, unconstrained (not fully_constrained), for an empty sketch', async () => {
    const service = await solver()
    const doc = emptySketchFixture()
    const result = service.solve(doc)
    expect(result.status).toBe('success')
    expect(result.dof).toBe(0)
    const chip = computeDofChip(result, doc.constraints.length > 0)
    expect(chip.dof).toBe(0)
    // An empty sketch has nothing constrained, so it must never read as the
    // "you're done" fully_constrained state - that would be a false positive
    // at the M2 gate demo. Fails under the pre-R1 ordering, which returned
    // 'fully_constrained' here because the dof===0 check ran before the
    // hasConstraints check.
    expect(chip.status).toBe('unconstrained')
    expect(chip.label).toBe('Empty sketch')
  })

  it('matches the planegcs ground truth DOF count exactly for a partially constrained bracket', async () => {
    const service = await solver()
    const doc = bracketPartialFixture()
    const result = service.solve(doc)
    expect(result.status).toBe('success')
    // Ground truth from the live solver, not a hand-derivation - see bracketFixture.ts's comment
    // for the expected arithmetic (2 dropped length dimensions -> 2 DOF).
    expect(result.dof).toBe(2)
    const chip = computeDofChip(result, true)
    expect(chip.status).toBe('partially_constrained')
    expect(chip.dof).toBe(2)
  })

  it('reports 0 DOF and fully-constrained state for the closed bracket demo fixture', async () => {
    const service = await solver()
    const doc = bracketFixture()
    const result = service.solve(doc)
    expect(result.status).toBe('success')
    expect(result.dof).toBe(0)
    const chip = computeDofChip(result, true)
    expect(chip.dof).toBe(0)
    expect(chip.status).toBe('fully_constrained')
    expect(chip.label).toBe('Fully constrained')
  })
})

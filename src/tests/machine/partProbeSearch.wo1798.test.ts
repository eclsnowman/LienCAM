import { describe, expect, it } from 'vitest'
import {
  partProbeFineSearchMm,
  partProbeTargetAtOrAboveBottom,
  planPartProbeSearch,
} from '../../lib/machine/partProbeSearch'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import {
  createDefaultControllerDefinition,
  type ControllerSettingRef,
  type ControllerType,
  type MachineConfig,
} from '../../types'

/**
 * WO-1798 follow-up: a bottom exists only with PROVENANCE. `stated` writes
 * the app-owned statement pair the Machine area edits (`axisSoftLimitEdit.ts`
 * `writeSoftLimits`); `uccnc` writes the pair the profile importer carries
 * (`definitionStatesAxisSoftLimits`); the other modes state one end or none,
 * which is raw numbers without a declaration.
 */
type Provenance = 'stated' | 'none' | 'min-only' | 'max-only' | 'uccnc'

function machine(
  bottom: number | null,
  maxTravelOverride: number | undefined,
  top: number = bottom === null ? 0 : bottom + 100,
  provenance: Provenance = 'stated',
): Pick<MachineConfig, 'controller' | 'controllerDefinition' | 'probeOverrides'> {
  const controller: ControllerType = provenance === 'uccnc' ? 'uccnc' : 'grbl'
  const controllerDefinition = bottom === null ? undefined : createDefaultControllerDefinition()
  const z = controllerDefinition?.axes.find((axis) => axis.axis === 'Z')
  if (z) {
    z.softLimitMin = bottom!
    z.softLimitMax = top
  }
  if (controllerDefinition && provenance !== 'none') {
    const stated: ControllerSettingRef[] = []
    if (provenance === 'stated' || provenance === 'min-only') {
      stated.push({ controller, key: axisSoftLimitStatementKey('Z', 'min') })
    }
    if (provenance === 'stated' || provenance === 'max-only') {
      stated.push({ controller, key: axisSoftLimitStatementKey('Z', 'max') })
    }
    if (provenance === 'uccnc') {
      stated.push({ controller: 'uccnc', key: 'axessettingscontrolZ.Softlimitnegative' })
      stated.push({ controller: 'uccnc', key: 'axessettingscontrolZ.Softlimitpositive' })
    }
    controllerDefinition.stated = stated
  }
  return {
    controller,
    controllerDefinition,
    probeOverrides: maxTravelOverride === undefined ? undefined : { maxTravel: maxTravelOverride },
  }
}

describe('WO-1798 part-Z search resolution', () => {
  it.each([
    { label: 'negative range', start: 80, bottom: -20, travel: 100, target: -20 },
    { label: 'positive range', start: 130, bottom: 10, travel: 120, target: 10 },
  ])('uses the declared bottom with no explicit override in a $label', ({ start, bottom, travel, target }) => {
    expect(planPartProbeSearch(machine(bottom, undefined), start, 50)).toEqual({
      basis: 'machine-limit',
      startMachineZ: start,
      bottomMachineZ: bottom,
      targetMachineZ: target,
      travelMm: travel,
    })
  })

  it('honors a shorter explicit override and caps a longer one at the bottom', () => {
    expect(planPartProbeSearch(machine(-20, 25), 80, 25)).toMatchObject({
      basis: 'operator-override',
      targetMachineZ: 55,
      travelMm: 25,
    })
    expect(planPartProbeSearch(machine(-20, 300), 80, 300)).toMatchObject({
      basis: 'operator-override',
      targetMachineZ: -20,
      travelMm: 100,
    })
  })

  it('treats key absence as inherited even when the inherited number equals a former override', () => {
    const cleared = machine(-20, undefined)
    expect(planPartProbeSearch(cleared, 80, 25)).toMatchObject({
      basis: 'machine-limit',
      travelMm: 100,
    })
  })

  it('retains the finite configured distance when the bottom or start coordinate is unknown', () => {
    expect(planPartProbeSearch(machine(null, undefined), 80, 50)).toEqual({
      basis: 'configured-fallback',
      startMachineZ: 80,
      bottomMachineZ: null,
      targetMachineZ: 30,
      travelMm: 50,
    })
    expect(planPartProbeSearch(machine(-20, undefined), null, 50)).toEqual({
      basis: 'configured-fallback',
      startMachineZ: null,
      bottomMachineZ: -20,
      targetMachineZ: null,
      travelMm: 50,
    })
  })

  it('treats a blank, equal, inverted or non-finite Z span as no stated bottom', () => {
    const unusable: Array<[string, number, number]> = [
      ['blank default 0/0', 0, 0],
      ['equal non-zero endpoints', 5, 5],
      ['inverted span', 20, 10],
      ['non-finite min', Number.NaN, 100],
      ['non-finite max', -20, Number.POSITIVE_INFINITY],
    ]
    for (const [label, min, max] of unusable) {
      const plan = planPartProbeSearch(machine(min, undefined, max), 80, 50)
      expect(plan, label).toEqual({
        basis: 'configured-fallback',
        startMachineZ: 80,
        bottomMachineZ: null,
        targetMachineZ: 30,
        travelMm: 50,
      })
    }
  })

  it('treats nonzero numbers WITHOUT any statement keys as no stated bottom', () => {
    const plan = planPartProbeSearch(machine(-20, undefined, 80, 'none'), 80, 50)
    expect(plan).toEqual({
      basis: 'configured-fallback',
      startMachineZ: 80,
      bottomMachineZ: null,
      targetMachineZ: 30,
      travelMm: 50,
    })
  })

  it.each(['min-only', 'max-only'] as const)(
    'treats a %s provenance as no stated bottom, keeping the configured distance',
    (provenance) => {
      const plan = planPartProbeSearch(machine(-20, undefined, 80, provenance), 80, 50)
      expect(plan, provenance).toEqual({
        basis: 'configured-fallback',
        startMachineZ: 80,
        bottomMachineZ: null,
        targetMachineZ: 30,
        travelMm: 50,
      })
    },
  )

  it('keeps the machine-limit basis for both explicitly stated app limits', () => {
    expect(planPartProbeSearch(machine(-20, undefined, 80, 'stated'), 80, 50)).toMatchObject({
      basis: 'machine-limit',
      bottomMachineZ: -20,
      travelMm: 100,
    })
  })

  it('keeps the machine-limit basis for imported UCCNC soft limits', () => {
    expect(planPartProbeSearch(machine(-20, undefined, 80, 'uccnc'), 80, 50)).toMatchObject({
      basis: 'machine-limit',
      bottomMachineZ: -20,
      targetMachineZ: -20,
      travelMm: 100,
    })
  })

  it('honors a stated bottom of zero and a stated top of zero as real limits', () => {
    expect(planPartProbeSearch(machine(0, undefined, 100), 80, 50)).toEqual({
      basis: 'machine-limit',
      startMachineZ: 80,
      bottomMachineZ: 0,
      targetMachineZ: 0,
      travelMm: 80,
    })
    expect(planPartProbeSearch(machine(-100, undefined, 0), 80, 50)).toEqual({
      basis: 'machine-limit',
      startMachineZ: 80,
      bottomMachineZ: -100,
      targetMachineZ: -100,
      travelMm: 180,
    })
  })

  it('leaves impossible at/below-bottom and invalid override inputs for existing validation', () => {
    expect(planPartProbeSearch(machine(-20, undefined), -20, 50)).toMatchObject({
      targetMachineZ: -20,
      travelMm: 0,
    })
    expect(planPartProbeSearch(machine(-20, 0), 80, 0)).toMatchObject({
      basis: 'operator-override',
      travelMm: 0,
    })
    expect(planPartProbeSearch(machine(-20, Number.NaN), 80, Number.NaN).travelMm).toBeNaN()
  })

  it('keeps both command-precision fast and fine targets at or above the bottom', () => {
    const plan = planPartProbeSearch(machine(0.10004, undefined), 10, 50)
    expect(plan.targetMachineZ).toBeGreaterThanOrEqual(0.10004)
    expect(partProbeTargetAtOrAboveBottom(plan.targetMachineZ!, plan.bottomMachineZ)).toBe(0.1001)
    const fineSearch = partProbeFineSearchMm(2.10004, 4, plan.bottomMachineZ)
    const fineTarget = partProbeTargetAtOrAboveBottom(2.10004 - fineSearch, plan.bottomMachineZ)
    expect(fineTarget).toBeGreaterThanOrEqual(0.10004)
  })
})

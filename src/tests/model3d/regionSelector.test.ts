import { describe, expect, it } from 'vitest'
import type { ProfileRegion, ProfileSegment } from '../../geom/geom-service'
import {
  profileRegionSignature,
  regionProfileSelector,
  resolveProfileSelector,
  type ProfileSelector,
} from '../../components/model3d/workbench/regionSelector'

const PLANE: ProfileRegion['plane'] = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDir: { x: 1, y: 0, z: 0 },
}

function line(srcId: string, x = 0): ProfileSegment {
  return { kind: 'line', a: [x, 0], b: [x + 1, 0], srcId }
}

function region(sketchId: string, ...srcIds: string[]): ProfileRegion {
  return {
    sketchId,
    plane: PLANE,
    loops: [srcIds.map((srcId, index) => line(srcId, index))],
  }
}

describe('HOTEL-T4 stable sketch-region selector', () => {
  it('derives a canonical signature independent of segment order and duplicate tessellation lineage', () => {
    const a = region('SK1', 'edge-c', 'edge-a', 'edge-b', 'edge-a')
    const b = region('SK1', 'edge-b', 'edge-c', 'edge-a')

    expect(profileRegionSignature(a)).toEqual(['edge-a', 'edge-b', 'edge-c'])
    expect(profileRegionSignature(b)).toEqual(profileRegionSignature(a))
    expect(regionProfileSelector(a)).toEqual({
      kind: 'region',
      signature: ['edge-a', 'edge-b', 'edge-c'],
    })
  })

  it('resolves the selected region after the regenerated region array reorders', () => {
    const first = region('SK1', 'outer-a', 'outer-b')
    const selected = region('SK1', 'island')
    const selector = regionProfileSelector(selected)

    const result = resolveProfileSelector([selected, first], selector)

    expect(result).toEqual({ ok: true, profiles: [selected] })
  })

  it('resolves missing and whole-sketch selectors to every region in arrangement order', () => {
    const first = region('SK1', 'first')
    const second = region('SK1', 'second')

    expect(resolveProfileSelector([first, second], undefined)).toEqual({
      ok: true,
      profiles: [first, second],
    })
    expect(resolveProfileSelector([first, second], { kind: 'whole-sketch' })).toEqual({
      ok: true,
      profiles: [first, second],
    })
  })

  it('refuses an explicit selector when its region list is unavailable', () => {
    const legacy = region('SK1', 'legacy')
    const selector = regionProfileSelector(legacy)

    expect(resolveProfileSelector(undefined, selector)).toMatchObject({
      ok: false,
      code: 'regions-unavailable',
    })
  })

  it('refuses instead of silently rebinding when the selected boundary changes', () => {
    const selected = region('SK1', 'edge-a', 'edge-b')
    const edited = region('SK1', 'edge-a', 'edge-new')

    expect(resolveProfileSelector([edited], regionProfileSelector(selected))).toMatchObject({
      ok: false,
      code: 'region-not-found',
    })
  })

  it.each<ProfileSelector>([
    { kind: 'region', signature: [] },
    { kind: 'region', signature: [''] },
  ])('refuses malformed persisted signatures: $signature', (selector) => {
    const legacy = region('SK1', 'legacy')
    expect(resolveProfileSelector([legacy], selector)).toMatchObject({
      ok: false,
      code: 'invalid-selector',
    })
  })
})

// WO BUG-MODEL-REGION-PICK. The planar arrangement splits ONE entity across several enclosed faces,
// so two regions CAN now carry the identical boundary lineage -- a circle crossing a rectangle edge
// leaves two half-disk regions both bounded by exactly {circle, that edge}. The pre-arrangement
// assumption ("entity ids are unique, therefore signatures are unique") is dead, and the resolver's
// old `.find` would have silently handed the user whichever came first.
describe('BUG-MODEL-REGION-PICK: same-signature sibling regions stay individually addressable', () => {
  const first = region('SK1', 'circle', 'edge')
  const second = region('SK1', 'circle', 'edge')
  const siblings = [first, second]

  it('mints no ordinal at all when the signature is already unique (old selectors unchanged)', () => {
    const lone = region('SK1', 'edge-a', 'edge-b')
    expect(regionProfileSelector(lone, [lone])).toEqual({
      kind: 'region',
      signature: ['edge-a', 'edge-b'],
    })
    // ...and with no sibling list at all, which is the legacy call shape.
    expect(regionProfileSelector(lone)).toEqual({ kind: 'region', signature: ['edge-a', 'edge-b'] })
  })

  it('mints an ordinal only for the ambiguous case, and resolves each sibling to ITSELF', () => {
    const selectorA = regionProfileSelector(first, siblings)
    const selectorB = regionProfileSelector(second, siblings)
    expect(selectorA).toEqual({ kind: 'region', signature: ['circle', 'edge'], ordinal: 0 })
    expect(selectorB).toEqual({ kind: 'region', signature: ['circle', 'edge'], ordinal: 1 })

    expect(resolveProfileSelector(siblings, selectorA)).toEqual({ ok: true, profiles: [first] })
    // The non-vacuity that matters: the SECOND sibling resolves to the second region, never to the
    // first one the old `.find` would have returned.
    expect(resolveProfileSelector(siblings, selectorB)).toEqual({ ok: true, profiles: [second] })
  })

  it('refuses BY NAME rather than guessing when an ordinal-less selector becomes ambiguous', () => {
    const beforeTheEdit = regionProfileSelector(first)
    expect(beforeTheEdit).toEqual({ kind: 'region', signature: ['circle', 'edge'] })
    expect(resolveProfileSelector(siblings, beforeTheEdit)).toMatchObject({
      ok: false,
      code: 'region-ambiguous',
    })
  })

  it('refuses BY NAME when the recorded position no longer exists', () => {
    expect(resolveProfileSelector(siblings, {
      kind: 'region',
      signature: ['circle', 'edge'],
      ordinal: 2,
    })).toMatchObject({ ok: false, code: 'region-ambiguous' })
  })

  it('still resolves an ordinal-bearing selector once the sibling is gone (one match wins)', () => {
    expect(resolveProfileSelector([second], {
      kind: 'region',
      signature: ['circle', 'edge'],
      ordinal: 1,
    })).toEqual({ ok: true, profiles: [second] })
  })

  it('keeps refusing a signature that no longer exists at all, ordinal or not', () => {
    expect(resolveProfileSelector([region('SK1', 'circle', 'other-edge')], {
      kind: 'region',
      signature: ['circle', 'edge'],
      ordinal: 0,
    })).toMatchObject({ ok: false, code: 'region-not-found' })
  })
})

describe('WO-1085 ordered multi-region selectors', () => {
  it('resolves every picked region in pick order after the sketch region array reorders', () => {
    const first = region('SK1', 'first')
    const second = region('SK1', 'second')
    const third = region('SK1', 'third')
    const selector: ProfileSelector = {
      kind: 'regions',
      regions: [regionProfileSelector(third), regionProfileSelector(first)].map(({ signature, ordinal }) => ({
        signature,
        ...(ordinal === undefined ? {} : { ordinal }),
      })),
    }

    expect(resolveProfileSelector([second, first, third], selector)).toEqual({
      ok: true,
      profiles: [third, first],
    })
  })

  it('refuses the whole selection by name when one picked region disappears', () => {
    const first = region('SK1', 'first')
    const missing = region('SK1', 'missing')
    const selector: ProfileSelector = {
      kind: 'regions',
      regions: [first, missing].map((profile) => {
        const selected = regionProfileSelector(profile)
        return { signature: selected.signature, ...(selected.ordinal === undefined ? {} : { ordinal: selected.ordinal }) }
      }),
    }

    expect(resolveProfileSelector([first], selector)).toEqual({
      ok: false,
      code: 'regions-unavailable',
      message: 'Selected sketch region 2 is unavailable: The selected sketch region changed or no longer exists. Select the region again.',
    })
  })

  it('refuses an empty persisted multi-selection as invalid', () => {
    expect(resolveProfileSelector([region('SK1', 'first')], { kind: 'regions', regions: [] })).toMatchObject({
      ok: false,
      code: 'invalid-selector',
    })
  })
})

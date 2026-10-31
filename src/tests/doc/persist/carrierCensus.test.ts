// WO UI-80-R3 criterion 1 -- CARRIER CENSUS (derived, not illustrated).
//
// The v3->v4 migration renames a body producer (a promoted owner -> its pushPull
// chain tail). EVERY pre-existing consumer that names that producer must be
// retargeted or the regen executor resolves a since-superseded id and fails "has
// no live body". The R2 blocker was that only `consumes` + `targetFeatureId` were
// rewired, leaving `payload.ownerId` (7 ops) and `payload.toolFeatureId` (boolean)
// pointed at the dead owner -- two live instances of the SAME bug class.
//
// This census pins the rewire set to GROUND TRUTH: the executor READ-SET. It
// derives, from source, every field the regen executor passes to lookupLiveBody
// (the body-liveness gate at SolidsWorkbenchPage.tsx:3056) -- directly
// `lookupLiveBody(p.<field>)` and indirectly through buildExtrudeRequest's
// `lookupTarget: lookupLiveBody` binding (extrudeParams.ts) -- and asserts that
// set is a SUBSET of BODY_IDENTITY_PAYLOAD_CARRIERS, the exact constant the
// migration iterates when it rewires (versioning.ts). A new op that adds
// `lookupLiveBody(p.newField)` without adding newField to the census FAILS here.
//
// FAILS-IF (non-vacuousness, proven by mutation UI-80-R3): delete a row from
// BODY_IDENTITY_PAYLOAD_CARRIERS (e.g. 'ownerId') and the subset assertion below
// refuses it by name, because the executor still reads lookupLiveBody(p.ownerId).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BODY_IDENTITY_PAYLOAD_CARRIERS } from '../../../doc/persist/versioning'

const WORKBENCH_PATH = resolve(process.cwd(), 'src/components/model3d/SolidsWorkbenchPage.tsx')
const EXTRUDE_PARAMS_PATH = resolve(process.cwd(), 'src/components/model3d/workbench/extrudeParams.ts')

/** Strip line (`//`) and block (`/* *\/`) comments so a census scan measures
 *  live code, never a prose mention of lookupLiveBody. Conservative: cutting a
 *  line at its first `//` can only DROP text, so it never invents a false match;
 *  real code bindings never sit after a `//`. */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
  return noBlock
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf('//')
      return i === -1 ? line : line.slice(0, i)
    })
    .join('\n')
}

describe('WO UI-80-R3 C1: the migration rewire set is a superset of the executor body read-set', () => {
  const workbenchSrc = stripComments(readFileSync(WORKBENCH_PATH, 'utf8'))
  const extrudeSrc = stripComments(readFileSync(EXTRUDE_PARAMS_PATH, 'utf8'))
  const carriers = new Set<string>(BODY_IDENTITY_PAYLOAD_CARRIERS)

  it('every direct lookupLiveBody(p.<field>) argument is a rewired carrier (can-fail on a new op)', () => {
    const direct = [...workbenchSrc.matchAll(/lookupLiveBody\(\s*p\.(\w+)\s*\)/g)].map((m) => m[1])
    // Guard: the scan is non-vacuous -- it actually located the executor reads.
    // (An empty match set would make the subset assertion pass trivially.)
    expect(direct.length).toBeGreaterThanOrEqual(3)
    const uniqueDirect = [...new Set(direct)].sort()
    for (const field of uniqueDirect) {
      expect(
        carriers.has(field),
        `executor calls lookupLiveBody(p.${field}) but the v3->v4 migration does not rewire it -- add it to BODY_IDENTITY_PAYLOAD_CARRIERS or rule it out`,
      ).toBe(true)
    }
    // Today the direct read-set is exactly {ownerId, sourceBodyId, targetFeatureId, toolFeatureId} (WO-3244 Mirror replace reads sourceBodyId).
    expect(uniqueDirect).toEqual(['ownerId', 'sourceBodyId', 'targetFeatureId', 'toolFeatureId'])
  })

  it('the ONLY indirect lookupLiveBody consumer is buildExtrudeRequest.lookupTarget, reading a rewired carrier', () => {
    // Any place lookupLiveBody is BOUND as a callback (a property assigned the
    // bare function reference) rather than invoked. The negative lookahead
    // excludes an immediate call (`body: lookupLiveBody(id)!` inside
    // candidateTargets' map, added alongside WO UI-51A-R2's extrude end-target
    // candidate list) -- a call resolves a body value on the spot and passes it
    // on, which is not lookupLiveBody escaping as a callback the way `lookupTarget:
    // lookupLiveBody` does; matching it would be a false positive of the scan
    // itself, not a real new indirect consumer. A NEW indirect consumer (some
    // future `fooLookup: lookupLiveBody` bound WITHOUT a call) still changes this
    // list and trips the equality below -- forcing its payload field into the
    // census too.
    const bindings = [...workbenchSrc.matchAll(/(\w+):\s*lookupLiveBody(?!\()\b/g)].map((m) => m[1])
    expect(bindings).toEqual(['lookupTarget'])

    // extrudeParams resolves lookupTarget(payload.<field>); that field must be a
    // rewired carrier (it is targetFeatureId). The single-target read is no
    // longer a flat `const targetId = payload.<field>` -- multi-body composed
    // targets (payload.targetFeatureIds, plural) were added as a fallback-array
    // wrapper: `rawTargetIds = payload.targetFeatureIds === undefined ?
    // [payload.targetFeatureId] : payload.targetFeatureIds`, then
    // `currentTargetId = targetIds[0]` feeds `lookupTarget`. Matching the
    // FALLBACK branch's `[payload.<field>]` is what still names the single
    // scalar carrier the executor actually resolves through today: no
    // production caller ever supplies `payload.targetFeatureIds` or
    // `composedTarget` (verified: `grep -rn "targetFeatureIds:\|composedTarget"
    // src/` outside this file and its own declarations returns nothing), so
    // `rawTargetIds` is always the one-element `[payload.targetFeatureId]`
    // array in every reachable path -- the plural field is forward-compat
    // groundwork, not yet a live carrier obligation.
    const targetField = /rawTargetIds\s*=\s*payload\.targetFeatureIds\s*===\s*undefined\s*\?\s*\[\s*payload\.(\w+)\s*\]/.exec(extrudeSrc)
    expect(targetField, 'extrudeParams no longer reads payload.<field> into the single-target fallback -- census stale').not.toBeNull()
    expect(carriers.has(targetField![1])).toBe(true)
    // targetId itself is only assigned FROM currentTargetId after a successful
    // lookup (`targetId = currentTargetId`), so the call this census cares
    // about is the resolution call, not a `lookupTarget(targetId)` literal.
    expect(extrudeSrc).toMatch(/lookupTarget\(\s*currentTargetId\s*\)/)
  })

  it('every declared carrier is actually consulted by the executor (no dead rewire rows)', () => {
    const readsDirectly = (field: string) => new RegExp(`lookupLiveBody\\(\\s*p\\.${field}\\s*\\)`).test(workbenchSrc)
    const readsViaExtrude = (field: string) => new RegExp(`payload\\.${field}\\b`).test(extrudeSrc)
    for (const carrier of BODY_IDENTITY_PAYLOAD_CARRIERS) {
      expect(
        readsDirectly(carrier) || readsViaExtrude(carrier),
        `carrier '${carrier}' is in the rewire set but no executor branch reads it -- remove it or wire the reader`,
      ).toBe(true)
    }
  })

  it('ruled-out reference fields (sketchId/sectionIds/faceId) are NOT body carriers', () => {
    // These reach a SKETCH node (dag.getNode) or an element-map/face id -- never a
    // promoted owner -- so they are correctly absent from the rewire set. The
    // executor DOES read them, proving the exclusion is deliberate, not an oversight.
    expect(workbenchSrc).toMatch(/dag\.getNode\(p\.sketchId\)/)
    expect(workbenchSrc).toMatch(/dag\.getNode\(p\.sectionIds\[/)
    for (const ruledOut of ['sketchId', 'sectionIds', 'faceId']) {
      expect(BODY_IDENTITY_PAYLOAD_CARRIERS as readonly string[]).not.toContain(ruledOut)
    }
  })
})

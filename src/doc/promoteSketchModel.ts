// GEO-UNIFY Stage 3 (plan sec 3.2 step 6): the HEADLESS seed builder for the
// PROMOTE flow (CAM sketch -> model base sketch, MOVE semantics).
//
// Given a CAM `Sketch`, assemble a one-sketch-node modeling document archive
// -- the exact bytes `stashLoadedDocument` parks for a Model Item mount to
// seed from -- with NO React, NO canvas, NO kernel client. The store's
// `promoteSketchLayerToModel` calls this, then stashes the returned bytes
// against the freshly minted item id; when the Model workspace mounts on that
// item, `takePendingDocumentSeed` hands it this document and the promoted
// sketch is present as the model's base sketch, extrude-eligible on first open.
//
// SHAPE FIDELITY (why this cannot drift from the workbench). The single sketch
// node is minted in the EXACT create-shape SolidsWorkbenchPage mints for a
// from-scratch sketch (SolidsWorkbenchPage.tsx, `entry.mode === 'create'`):
//   kind 'sketch', id sketch3d:<raw>, consumes ['datum:XY'],
//   payload { sketch, planeNodeId:'datum:XY', externalRefs:[], dimensionDiagnostics:[], profile? }
// The payload's `sketch` is a CAM `Sketch` VERBATIM (no Sketch3dDocument round
// trip -- SKC-15's data-loss trap), which is exactly why promotion is a payload
// copy and not a converter (plan sec 3.1).
//
// PROFILE AT SEED (plan sec 3.2 step 6, risk "Profile-at-seed headlessness").
// `extractSketchProfile` is verified headless -- it delegates to
// `computeProfileRegions` (src/sketch3d/regions.ts, pure geometry: no kernel,
// no viewport) and is already unit-tested directly under vitest
// (src/tests/model3d/sketchProfile.test.ts). So the profile is computed HERE,
// at seed time, against the constant XY base-plane frame -- the promoted sketch
// is therefore in `profilePickCandidates` on the FIRST mount, extrudable with
// zero interaction. When the sketch has no closed profile yet (mid-draw, open
// loops), `extractSketchProfile` refuses BY NAME; we seed WITHOUT a profile and
// report the refusal, and the workbench's own mount-time
// `recomputeSketchProfileInDag` recovers a profile the moment the sketch closes
// -- the documented fallback, identical to how a hand-drawn workbench sketch
// behaves before it closes.
//
// LAYERING. This module lives in src/doc but imports UPWARD (basePlanes,
// sketchProfile, sketch3d) for the seed shapes it must match byte-for-byte. It
// is a LEAF in the src/doc directory -- nothing in src/doc (least of all the
// barrel index.ts) imports it -- so `basePlanes -> ../../../doc` (the barrel)
// never closes a cycle back to here. The store imports it by its direct path.

import { BASE_PLANE_XY_NODE_ID } from './genesis'
import { newSeededModelDag, finalizeSeedArchive } from './seedModelArchive'
import { BASE_PLANE_FRAMES } from '../components/model3d/workbench/basePlanes'
import { extractSketchProfile } from '../components/model3d/workbench/sketchProfile'
import { sketch3dNodeId } from '../sketch3d'
import type { Sketch } from '../lib/sketch/types'

export interface PromotedSketchSeed {
  /** The document archive bytes to stash against the new Model Item id. */
  bytes: Uint8Array
  /** true when a closed profile was extracted at seed time (extrude-eligible on
   *  first open); false when the sketch had no closed profile yet and the
   *  mount-time recompute fallback owns producing one once it closes. */
  hadProfile: boolean
  /** The named refusal message when no profile could be built at seed time
   *  (undefined when hadProfile is true). Purely diagnostic. */
  profileRefusal?: string
}

/**
 * Build the seed archive for promoting `sketch` into a fresh Model Item's base
 * sketch. Async ONLY because `extractSketchProfile` is async (it awaits the
 * pure region classifier); it performs no I/O and touches no module state, so
 * it is safe to call from anywhere and trivially unit-testable (decode the
 * returned bytes with `loadDocumentArchive` and assert the sketch node + its
 * profile).
 */
export async function buildPromotedSketchModelArchive(sketch: Sketch): Promise<PromotedSketchSeed> {
  // Every workbench document is born with Origin + XY/XZ/YZ (SKC-15); the base
  // sketch must consume a REAL datum node, so the shared helper seeds genesis
  // before we insert it (newSeededModelDag == new FeatureDag + seedGenesisNodes).
  const dag = newSeededModelDag()

  const rawId = sketch.id
  const nodeId = sketch3dNodeId(rawId)

  const payload: Record<string, unknown> = {
    sketch,
    planeNodeId: BASE_PLANE_XY_NODE_ID,
    externalRefs: [],
    dimensionDiagnostics: [],
  }

  let hadProfile = false
  let profileRefusal: string | undefined
  const result = await extractSketchProfile(sketch, BASE_PLANE_FRAMES.xy, rawId)
  if (result.ok) {
    payload.profile = result.profile
    payload.regions = result.regions
    hadProfile = true
  } else {
    profileRefusal = result.refusal.message
  }

  dag.insertNode({
    id: nodeId,
    kind: 'sketch',
    consumes: [BASE_PLANE_XY_NODE_ID],
    refs: [],
    payload,
  })

  // Serialize via the SHARED helper -- a brand-new one-sketch document has no
  // lineage history and no folder grouping; finalizeSeedArchive owns the
  // elementMapDeltas: [] + rollback timeline shape (see its own doc comment).
  const bytes = finalizeSeedArchive(dag)

  return { bytes, hadProfile, profileRefusal }
}

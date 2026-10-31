import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
const thinOpenText = textFor('thin-open-extrude.wo3237')
import type { ProfileRegion } from '../../../geom/geom-service'
import {
  expandSweepPathSelection,
  resolveSweepPathChain,
  type SketchChainPathSelector,
  type SweepPathNodeLookup,
  type SweepPathResolution,
} from '../../../geom/sweep-path'
import { sweepPathCandidatesForSketch, type SweepPathSketchCandidates } from './sweepPathPicker'
import { expandBlocksForGeometry } from '../../../lib/sketch/blocks'
import type { Sketch } from '../../../lib/sketch/types'
import type { Sketch3dDocument } from '../../../sketch3d/types'


export interface RegionSignature {
  signature: string[]
  /**
       * WO BUG-MODEL-REGION-PICK: which of several SAME-SIGNATURE regions this is, in the sketch's
       * canonical region order. Present ONLY when the sketch actually holds more than one region
       * with this exact boundary lineage, so an ordinary selector is byte-identical to what earlier
       * documents persisted and old documents keep resolving unchanged.
       *
       * WHY IT EXISTS AT ALL. Before the planar arrangement, a region WAS a whole chained loop and
       * two regions could not share a boundary-entity set (entity ids are unique). An arrangement
       * splits one entity across several faces, so they can: a circle crossing a rectangle edge
       * yields two half-disk regions BOTH bounded by exactly {circle, that edge}. Without this
       * field the two are indistinguishable and `resolveProfileSelector` would have to guess -- the
       * silent substitution this WO forbids. With it they stay individually selectable, and any
       * selector that still cannot be resolved to exactly one region refuses BY NAME below.
       */
  ordinal?: number
}

export type RegionProfileSelector = { kind: 'region' } & RegionSignature

export type ProfileSelector =
  | { kind: 'whole-sketch' }
  | RegionProfileSelector
  | { kind: 'regions'; regions: RegionSignature[] }
  | SketchChainPathSelector

export type ProfileSelectorRefusalCode =
  | 'open-chain-requires-thin'
  | 'invalid-selector'
  | 'regions-unavailable'
  | 'region-not-found'
  | 'region-ambiguous'

export type ProfileSelectorResolution =
  | { ok: true; profiles: [ProfileRegion, ...ProfileRegion[]] }
  | {
      ok: false
      code: ProfileSelectorRefusalCode
      message: string
    }

/**
 * Stable identity for one closed region of a sketch.
 *
 * Profile segments retain the ids of the sketch entities that generated them.
 * Sorting and de-duplicating that lineage makes the signature independent of
 * loop/segment order and of tessellation density. If an edit replaces any
 * boundary entity, the signature changes and replay refuses instead of silently
 * selecting a different region by array position.
 */
export function profileRegionSignature(region: ProfileRegion): string[] {
  return [...new Set(
    region.loops
      .flat()
      .map((segment) => segment.srcId)
      .filter((id) => id.length > 0),
  )].sort()
}

/**
 * The persistable identity of one region.
 *
 * Pass the sketch's whole region list as `siblings` wherever it is available (the viewport picker
 * always has it): when -- and only when -- another region carries the identical boundary lineage, the
 * selector also records this region's position among them, so the two remain distinguishable. With
 * no siblings, or a unique signature, the result is exactly the `{ kind, signature }` selector
 * earlier documents persisted.
 */
export function regionProfileSelector(
  region: ProfileRegion,
  siblings?: readonly ProfileRegion[],
): RegionProfileSelector {
  const signature = profileRegionSignature(region)
  if (siblings === undefined) return { kind: 'region', signature }
  const sameSignature = siblings.filter((other) =>
    signaturesEqual(profileRegionSignature(other), signature),
  )
  if (sameSignature.length < 2) return { kind: 'region', signature }
  const ordinal = sameSignature.indexOf(region)
  return ordinal < 0
    ? { kind: 'region', signature }
    : { kind: 'region', signature, ordinal }
}

function normalizedSelectorSignature(signature: unknown): string[] | null {
  if (
    !Array.isArray(signature) ||
    signature.length === 0 ||
    signature.some((id) => typeof id !== 'string' || id.length === 0)
  ) return null
  return [...new Set(signature)].sort()
}

function signaturesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * Resolve a feature's persisted selection against the sketch's regenerated
 * regions. A whole-sketch (or absent) selector means every enclosed region,
 * including nested regions; extruding their union is therefore the entire
 * enclosed sketch. Explicit region selectors return a one-element list and fail
 * closed when they cannot be narrowed to exactly one region.
 */
export function resolveProfileSelector(
  regions: readonly ProfileRegion[] | undefined,
  selector: ProfileSelector | undefined,
): ProfileSelectorResolution {
  // An open wire is never a region. Existing face-only replay consumers must
  // refuse it until they explicitly support the open-wall request in WO-3237.
  if (selector?.kind === 'sketch-chain') {
    return { ok: false, code: 'open-chain-requires-thin', message: 'An open sketch chain requires Thin open walls.' }
  }
  if (selector === undefined || selector.kind === 'whole-sketch') {
    return regions === undefined || regions.length === 0
      ? {
          ok: false,
          code: 'regions-unavailable',
          message: workbenchText('regionSelector.thisSketchNoLongerHasAClosedProfile'),
        }
      : { ok: true, profiles: [...regions] as [ProfileRegion, ...ProfileRegion[]] }
  }

  if (selector.kind === 'regions') {
    if (!Array.isArray(selector.regions) || selector.regions.length === 0) {
      return {
        ok: false,
        code: 'invalid-selector',
        message: workbenchText('regionSelector.thisFeatureHasAnInvalidSketchRegionSelection'),
      }
    }
    const profiles: ProfileRegion[] = []
    for (let index = 0; index < selector.regions.length; index++) {
      const selected = selector.regions[index]
      const resolved = resolveProfileSelector(regions, { kind: 'region', ...selected })
      if (!resolved.ok) {
        return {
          ok: false,
          code: resolved.code === 'invalid-selector' ? 'invalid-selector' : 'regions-unavailable',
          message: workbenchText('regionSelector.selectedSketchRegionIsUnavailable', { value1: String(index + 1), message: String(resolved.message) }),
        }
      }
      profiles.push(resolved.profiles[0])
    }
    return { ok: true, profiles: profiles as [ProfileRegion, ...ProfileRegion[]] }
  }

  if (selector.kind !== 'region') {
    return {
      ok: false,
      code: 'invalid-selector',
      message: workbenchText('regionSelector.thisFeatureHasAnInvalidSketchRegionSelection'),
    }
  }

  const signature = normalizedSelectorSignature(selector.signature)
  if (signature === null) {
    return {
      ok: false,
      code: 'invalid-selector',
      message: workbenchText('regionSelector.thisFeatureHasAnInvalidSketchRegionSelection'),
    }
  }
  if (regions === undefined || regions.length === 0) {
    return {
      ok: false,
      code: 'regions-unavailable',
      message: workbenchText('regionSelector.thisSketchDoesNotContainReplayableClosedRegions'),
    }
  }

  const matches = regions.filter((region) =>
    signaturesEqual(profileRegionSignature(region), signature),
  )
  if (matches.length === 0) {
    return {
      ok: false,
      code: 'region-not-found',
      message: workbenchText('regionSelector.theSelectedSketchRegionChangedOrNoLongerExists'),
    }
  }
  if (matches.length === 1) return { ok: true, profiles: [matches[0]] }

  // Several regions now share this boundary lineage (see ProfileSelector.ordinal). Resolve ONLY by
  // the recorded position; a selector that never had one, or whose position no longer exists,
  // refuses by name rather than picking a region for the user.
  const ordinal = selector.ordinal
  if (ordinal === undefined || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= matches.length) {
    return {
      ok: false,
      code: 'region-ambiguous',
      message: workbenchText('regionSelector.severalSketchRegionsNowShareThisBoundarySelectThe'),
    }
  }
  return { ok: true, profiles: [matches[ordinal]] }
}

/** Extrude uses the SAME ordered entity/direction selector and exact chain
 * resolver as Sweep. Only source eligibility is adapted: construction geometry
 * cannot become an Extrude wall, including a saved curve changed to construction.
 * Flatten blocks with the existing adapter before filtering their members. */
function openChainSourceLookup(lookup: SweepPathNodeLookup): SweepPathNodeLookup {
  return (id) => {
    const node = lookup(id)
    if (node?.kind !== 'sketch') return node
    const sketch = node.payload.sketch as Sketch | undefined
    if (sketch !== undefined && sketch !== null && typeof sketch === 'object') {
      const flat = expandBlocksForGeometry((sketch.entities ?? []).filter((entity) => !entity.construction), sketch.constraints ?? [], sketch.blockDefs)
      return { ...node, payload: { ...node.payload, sketch: {
        ...sketch, entities: flat.entities.filter((entity) => !entity.construction), constraints: flat.constraints, blockDefs: undefined,
      } } }
    }
    const document = node.payload.document as Sketch3dDocument | undefined
    if (document !== undefined && document !== null && typeof document === 'object') {
      return { ...node, payload: { ...node.payload, document: {
        ...document, entities: (document.entities ?? []).filter((entity) => !entity.construction),
      } } }
    }
    return node
  }
}

/** Resolve a persisted open-chain selection to a wire, never to a face. The
 * selector's producer and ordered directions are authoritative; no region or
 * whole-sketch fallback is permitted when any entity cannot resolve. */
export function resolveOpenChainProfileSelector(
  selector: unknown,
  lookup: SweepPathNodeLookup,
): SweepPathResolution {
  return resolveSweepPathChain(selector, openChainSourceLookup(lookup))
}

/** One click expands only when the shared authority finds a unique open chain.
 * Explicit ordered selectors may still name an unambiguous route at a branch. */
export function expandOpenChainProfileSelection(
  sketchId: string,
  entityId: string,
  lookup: SweepPathNodeLookup,
) {
  return expandSweepPathSelection(sketchId, entityId, openChainSourceLookup(lookup))
}

/** WO-3237: what an Extrude is built from. */
export type ExtrudeSelectionResolution =
  | { ok: true; profiles: [ProfileRegion, ...ProfileRegion[]]; openChain: boolean }
  | { ok: false; code: string; message: string }

/** WO-3237: an Extrude's persisted selection resolved for its builder. A
 * sketch-chain selector goes through the shared chain authority to ONE profile
 * whose single loop is the chain in its persisted travel order, flagged
 * `openChain` so only a Thin open wall may be built from it (extrudeParams
 * resolveExtrudeWall). It must be a chain of the extrude's own sketch, the one
 * its feature consumes. Every other selector is resolveProfileSelector,
 * unchanged. Nothing falls back from a chain to a region or the whole sketch. */
export function resolveExtrudeSelection(
  sketchId: string,
  regions: readonly ProfileRegion[] | undefined,
  selector: ProfileSelector | undefined,
  lookup: SweepPathNodeLookup,
): ExtrudeSelectionResolution {
  if (selector?.kind !== 'sketch-chain') {
    const resolved = resolveProfileSelector(regions, selector)
    return resolved.ok ? { ok: true, profiles: resolved.profiles, openChain: false } : resolved
  }
  if (selector.sketchId !== sketchId) {
    return { ok: false, code: 'invalid-selector', message: thinOpenText('wrongSketch', { chainSketch: String(selector.sketchId), sketch: sketchId }) }
  }
  const chain = resolveOpenChainProfileSelector(selector, lookup)
  if (!chain.ok) {
    return { ok: false, code: chain.diagnostic.code, message: thinOpenText('chainUnresolved', { message: chain.diagnostic.message }) }
  }
  return { ok: true, profiles: [{ sketchId: chain.path.sketchId, plane: chain.path.plane, loops: [chain.path.segments] }], openChain: true }
}

/** WO-3237: every open chain of one sketch an Extrude wall may follow - the
 * Sweep path list, read through the Extrude source rule (no construction). */
export function openChainCandidatesForSketch(sketchId: string, lookup: SweepPathNodeLookup): SweepPathSketchCandidates {
  return sweepPathCandidatesForSketch(sketchId, openChainSourceLookup(lookup))
}

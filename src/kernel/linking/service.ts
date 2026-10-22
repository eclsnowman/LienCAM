// WO-3026 (alpha.3 A3-12, parity): the linking service - one object both lanes would
// call: the approach / retract primitives, the 3D finishing linkers, the role vocabulary
// with its feed rows, the standoff table, link choice by case under one policy. Headless:
// it imports only kernel files and pure src modules. Nothing in the app calls it yet
// (engine selector stays `current`); a family switches in P6.

import * as primitives from './primitives'
import { buildLinkedPath, corridorEscapeMm } from './finishLinker3d'
import { linkWaterlinePasses } from './waterlineLinker'
import { ROLE_FEED_TABLE, feedRowFor, IR_ROLE_TO_LINK_ROLE, IR_ROLE_TO_RATE, resolveRoleFeed } from './roles'
import { STANDOFFS, standoffMm } from './standoffs'
import { classifyLinkCase, classifyLinkOutcome, linkSpans } from './cases'
import { parityLinkOutcomes } from './mapping'
import { PARITY_LINKING_POLICY, type LinkingPolicy } from './policy'

export interface LinkingService {
  readonly policy: LinkingPolicy
  readonly primitives: typeof primitives
  /** The 3D raster finishing linker (Parallel, Scallop, Pencil, the shallow half). */
  readonly linkRaster3d: typeof buildLinkedPath
  /** Waterline's own linker (parity `finish_linker_3d`). */
  readonly linkWaterline: typeof linkWaterlinePasses
  /** The corridor keep-down proof (WO-266 P1) the raster linker uses. */
  readonly corridorEscapeMm: typeof corridorEscapeMm
  readonly roles: typeof ROLE_FEED_TABLE
  readonly feedRowFor: typeof feedRowFor
  readonly irRoles: typeof IR_ROLE_TO_LINK_ROLE
  readonly irRates: typeof IR_ROLE_TO_RATE
  readonly resolveRoleFeed: typeof resolveRoleFeed
  readonly standoffs: typeof STANDOFFS
  readonly standoffMm: typeof standoffMm
  readonly linkSpans: typeof linkSpans
  readonly classifyLinkCase: typeof classifyLinkCase
  readonly classifyLinkOutcome: typeof classifyLinkOutcome
  readonly linkOutcomes: typeof parityLinkOutcomes
}

export function createLinkingService(policy: LinkingPolicy = PARITY_LINKING_POLICY): LinkingService {
  return Object.freeze({
    policy,
    primitives,
    linkRaster3d: buildLinkedPath,
    linkWaterline: linkWaterlinePasses,
    corridorEscapeMm,
    roles: ROLE_FEED_TABLE,
    feedRowFor,
    irRoles: IR_ROLE_TO_LINK_ROLE,
    irRates: IR_ROLE_TO_RATE,
    resolveRoleFeed,
    standoffs: STANDOFFS,
    standoffMm,
    linkSpans,
    classifyLinkCase,
    classifyLinkOutcome,
    linkOutcomes: parityLinkOutcomes,
  })
}

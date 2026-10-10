import type { LinkingParams } from '../../types'
import type { PocketParams } from './types'

export type PocketFillStrategy = NonNullable<PocketParams['fillStrategy']>
export type PocketEntryType = Extract<
  LinkingParams['entryType'],
  'plunge' | 'ramp_linear' | 'ramp_helical'
>

export interface PocketEntryPolicy {
  allowed: readonly PocketEntryType[]
  defaultEntry: PocketEntryType
}

export const POCKET_ENTRY_LABELS: Readonly<Record<PocketEntryType, string>> = {
  plunge: 'Plunge',
  ramp_linear: 'Profile Ramp',
  ramp_helical: 'Helix',
}

const OUTSIDE_IN_POLICY: PocketEntryPolicy = {
  allowed: ['ramp_linear', 'plunge'],
  defaultEntry: 'ramp_linear',
}

const INSIDE_OUT_POLICY: PocketEntryPolicy = {
  allowed: ['ramp_helical', 'plunge'],
  defaultEntry: 'ramp_helical',
}

export function resolvePocketFillStrategy(
  fillStrategy: PocketParams['fillStrategy'],
): PocketFillStrategy {
  return fillStrategy ?? 'outside_in'
}

export function getPocketEntryPolicy(
  fillStrategy: PocketParams['fillStrategy'],
): PocketEntryPolicy {
  return resolvePocketFillStrategy(fillStrategy) === 'inside_out'
    ? INSIDE_OUT_POLICY
    : OUTSIDE_IN_POLICY
}

export function isPocketEntryAllowed(
  fillStrategy: PocketParams['fillStrategy'],
  entryType: LinkingParams['entryType'],
): entryType is PocketEntryType {
  return getPocketEntryPolicy(fillStrategy).allowed.some((entry) => entry === entryType)
}

export function getDefaultPocketEntry(
  fillStrategy: PocketParams['fillStrategy'],
): PocketEntryType {
  return getPocketEntryPolicy(fillStrategy).defaultEntry
}

/**
 * Use only for an explicit user transition (new operation defaults or changing
 * fill strategy). Loaded invalid data must be migrated or rejected rather than
 * visually normalized without updating the stored operation.
 */
export function normalizePocketEntryForFillStrategy(
  fillStrategy: PocketParams['fillStrategy'],
  entryType: LinkingParams['entryType'],
): PocketEntryType {
  return isPocketEntryAllowed(fillStrategy, entryType)
    ? entryType
    : getDefaultPocketEntry(fillStrategy)
}

export function assertPocketEntryAllowed(
  fillStrategy: PocketParams['fillStrategy'],
  entryType: LinkingParams['entryType'],
): asserts entryType is PocketEntryType {
  if (isPocketEntryAllowed(fillStrategy, entryType)) return

  const resolvedFill = resolvePocketFillStrategy(fillStrategy)
  const allowed = getPocketEntryPolicy(resolvedFill).allowed
    .map((entry) => POCKET_ENTRY_LABELS[entry])
    .join(' or ')
  throw new Error(
    `Pocket 2D: entry type "${entryType}" is not compatible with ${resolvedFill}. `
      + `Choose ${allowed}.`,
  )
}

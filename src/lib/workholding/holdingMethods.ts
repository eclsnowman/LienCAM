// How a setup's stock is held. Information only: it changes no cut, keep-out or
// post output. The Setup panel edits it; the job sheet and the example builds
// read the same ids and names from here.

export const HOLDING_METHODS = [
  { id: 'vise', label: 'Vise' },
  { id: 'clamps', label: 'Clamps' },
  { id: 'screws', label: 'Screws' },
  { id: 'tape_glue', label: 'Tape and glue' },
  { id: 'tabs_only', label: 'Tabs only' },
  { id: 'fixture_plate', label: 'Fixture plate' },
  { id: 'vacuum', label: 'Vacuum' },
  { id: 'other', label: 'Other' },
] as const

export type HoldingMethodId = (typeof HOLDING_METHODS)[number]['id']

export function holdingMethodLabel(id: HoldingMethodId | undefined): string | undefined {
  return HOLDING_METHODS.find((m) => m.id === id)?.label
}

export function isHoldingMethodId(value: unknown): value is HoldingMethodId {
  return HOLDING_METHODS.some((m) => m.id === value)
}

import type { Tool, ToolHolder, ToolType } from '../../types'

/** Additive boundary data; settings in feedsAndSpeeds are never treated as limits. */
export interface ToolDefinition extends Omit<Tool, 'type'> {
  type: string
  owned?: boolean
  centreCutting?: boolean
  limits?: {
    minRpm?: number
    maxRpm?: number
    maxApFracD?: number
    maxAeFracD?: number
  }
  catalogRef?: { catalogId: string; entryId: string; catalogVersion: string }
  lifecycle?: 'active' | 'retired'
  /** Opaque provenance, never interpreted as permission or confirmed settings. */
  evidence?: unknown
}

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type HolderDefinition = ToolHolder

/** Caller supplies the existing TOOL_TYPE_META and buildToolProfile functions.
 * Structural contracts avoid importing an engine or duplicating its type table. */
export interface ToolAuthority<P, M extends { value: ToolType; group: string; profileKind: string }> {
  types: Readonly<Record<ToolType, M>>
  buildToolProfile: (tool: Tool) => P
}

export function snapshot<T>(value: T): DeepReadonly<T> {
  const copy = structuredClone(value)
  function freeze(data: unknown): void {
    if (data && typeof data === 'object' && !Object.isFrozen(data)) {
      Object.freeze(data)
      for (const child of Object.values(data)) freeze(child)
    }
  }
  freeze(copy)
  return copy as DeepReadonly<T>
}

export function createToolModel<P, M extends { value: ToolType; group: string; profileKind: string }>(
  authority: ToolAuthority<P, M>,
) {
  // Copy once so a caller cannot later mutate classification behind a view.
  const types = snapshot(authority.types)
  const classify = (tool: Pick<ToolDefinition, 'type' | 'declaredTypeRaw'>) => {
    const metadata = Object.hasOwn(types, tool.type) ? types[tool.type as ToolType] : undefined
    return Object.freeze({
      standardType: metadata?.value ?? 'other' as const,
      typeStatus: metadata ? (tool.declaredTypeRaw === undefined ? 'known' as const : 'fallback' as const) : 'unknown' as const,
      metadata,
    })
  }
  return {
    classify,
    describe<T extends ToolDefinition>(tool: T, holders: readonly ToolHolder[] = []) {
      const record = snapshot(tool)
      const classification = classify(tool)
      const { metadata } = classification
      const holder = tool.holderId === undefined ? undefined : holders.find(h => h.id === tool.holderId)
      // Raw unknown types without an importer's safe fallback have no claimed profile.
      // A recognized fallback with declaredTypeRaw retains today's profile and its provenance.
      const profile = metadata ? snapshot(authority.buildToolProfile(structuredClone(tool) as Tool)) : undefined
      return Object.freeze({
        record,
        ...classification,
        profile,
        geometry: snapshot({
          diameter: tool.diameter, fluteLength: tool.fluteLength,
          shankDiameter: tool.shankDiameter, overallLength: tool.overallLength,
          shoulderLength: tool.shoulderLength, lengthBelowHolder: tool.lengthBelowHolder,
          cornerRadius: tool.cornerRadius, angleFromAxisDeg: tool.angleFromAxisDeg,
          tipDiameter: tool.tipDiameter, neckDiameter: tool.neckDiameter,
          threadFormAngleDeg: tool.threadFormAngleDeg, threadTeethCount: tool.threadTeethCount,
          threadPitch: tool.threadPitch, neckTransitionAngleDeg: tool.neckTransitionAngleDeg,
        }),
        numberOfFlutes: tool.numberOfFlutes,
        cutHand: tool.cutHand ?? 'right',
        limits: record.limits,
        centreCutting: tool.centreCutting,
        holder: Object.freeze({
          reference: tool.holderId,
          status: holder ? 'resolved' as const : 'not-checked' as const,
          record: holder ? snapshot(holder) : undefined,
          // Resolution alone does not assert clearance; stickout must be stated too.
          clearanceStatus: holder && tool.lengthBelowHolder !== undefined ? 'data-present' as const : 'not-checked' as const,
        }),
      })
    },
  }
}

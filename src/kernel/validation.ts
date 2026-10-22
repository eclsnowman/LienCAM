/** Caller-supplied geometry facts. Names are operator-visible names, never array indexes. */
export type GeometryKnowledge = 'planar-contours' | 'closure-orientation' | 'nesting-islands'
  | 'parameter-depth' | 'surface-height' | 'normals-slope' | 'curvature'
  | 'feature-identity' | 'stock-state' | 'tool-geometry' | 'obstacles' | 'prior-toolpaths'
export interface KnowledgeDeclaration {
  required: readonly GeometryKnowledge[]
  optional: readonly GeometryKnowledge[]
  /** Open chains are usable in contour/trace, not in closed-region planners. */
  closedRegions: boolean
}
export interface ValidationInput {
  operationName: string
  available: readonly GeometryKnowledge[]
  features?: readonly { name: string; closed: boolean }[]
  zMode?: 'parameter-depth' | 'surface-height'
  requestedOptional?: readonly GeometryKnowledge[]
}
export type ValidationResult = {
  status: 'PROCEED' | 'DEGRADE' | 'REJECT'
  usableFeatures: readonly string[]
  omittedFeatures: readonly string[]
  messages: readonly string[]
}

/** Advisory for the new/headless API. Does not add a refusal to the current engine. */
export function validateOperation(declaration: KnowledgeDeclaration, input: ValidationInput): ValidationResult {
  const available = new Set(input.available)
  const features = input.features ?? []
  const usable = features.filter(feature => !declaration.closedRegions || feature.closed).map(feature => feature.name)
  const omitted = features.filter(feature => declaration.closedRegions && !feature.closed).map(feature => feature.name)
  const missing = declaration.required.filter(item => !available.has(item))
  if (input.zMode === 'surface-height' && !available.has('surface-height') && !missing.includes('surface-height')) missing.push('surface-height')
  if (missing.length) return {
    status: 'REJECT', usableFeatures: [], omittedFeatures: features.map(feature => feature.name),
    messages: [`${input.operationName}: cannot plan without ${missing.join(', ')}.`],
  }
  if (features.length && !usable.length) return {
    status: 'REJECT', usableFeatures: [], omittedFeatures: omitted,
    messages: [`${input.operationName}: no closed region to plan (${omitted.join(', ')}).`],
  }
  const messages = omitted.length ? [`${input.operationName}: planning usable regions; omitting open chains ${omitted.join(', ')}.`] : []
  const absentRequested = (input.requestedOptional ?? []).filter(item => declaration.optional.includes(item) && !available.has(item))
  if (absentRequested.length) messages.push(`${input.operationName}: continuing without ${absentRequested.join(', ')} extras.`)
  return { status: omitted.length ? 'DEGRADE' : 'PROCEED', usableFeatures: usable, omittedFeatures: omitted, messages }
}

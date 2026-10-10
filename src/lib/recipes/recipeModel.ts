import type {
  FeedrateOverride,
  FeedsAndSpeeds,
  HeightParams,
  LinkingParams,
  Operation,
  OperationType,
  PassParams,
  Tool,
} from '../../types'
import {
  SMART_HEIGHT_V2_REPAIR_MESSAGE,
  validatePersistedSmartHeightState,
  type MachiningScopeIntent,
  type OperationHeightIntentV2,
} from '../cam/smartHeights'

export const MACHINING_RECIPE_SCHEMA = 'liencam-machining-recipe' as const
export const MACHINING_RECIPE_VERSION = 2 as const

export type RecipeHeightRepairReason =
  | 'missing_v2_authority'
  | 'invalid_v2_authority'
  | 'operation_type_mismatch'

export type MachiningRecipeHeightAuthority =
  | { kind: 'smart_v2'; intent: OperationHeightIntentV2 }
  | {
      kind: 'repair_required'
      reason: RecipeHeightRepairReason
      message: string
    }

export interface MachiningRecipeOperation {
  name: string
  type: OperationType
  enabled: boolean
  tool?: Tool
  heightAuthority: MachiningRecipeHeightAuthority
  /** Compiled worker mirror only. It is never recipe height authority. */
  heights: HeightParams
  passes: PassParams
  linking: LinkingParams
  feedrateOverride?: FeedrateOverride
  params: Record<string, unknown>
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneValue(child)]),
    ) as T
  }
  return value
}

function repairAuthority(
  reason: RecipeHeightRepairReason,
  detail?: string,
): MachiningRecipeHeightAuthority {
  return {
    kind: 'repair_required',
    reason,
    message: detail ? `${detail} ${SMART_HEIGHT_V2_REPAIR_MESSAGE}` : SMART_HEIGHT_V2_REPAIR_MESSAGE,
  }
}

/** Recipe scopes cannot retain source-project identities. The V2 policy and
 * all non-identity height intent survive, while applying the recipe requires
 * the user to select target geometry before compute. */
function identityFreeScope(scope: MachiningScopeIntent): MachiningScopeIntent {
  switch (scope.kind) {
    case 'selected_geometry': return { ...scope, geometryIds: [] }
    case 'selected_paths': return { ...scope, geometryIds: [], loopIds: [] }
    case 'selected_features': return { ...scope, features: [] }
    case 'selected_bodies': return { ...scope, bodyIds: [] }
    case 'stock_footprint': return { ...scope, stockId: '' }
    case 'containment': return { ...scope, geometryIds: [] }
    case 'whole_target': return { ...scope, geometryIds: [] }
  }
}

function identityFreeIntent(intent: OperationHeightIntentV2): OperationHeightIntentV2 {
  const projected = cloneValue(intent)
  projected.machining.scope.value = identityFreeScope(projected.machining.scope.value)
  delete projected.featureOverrides
  return projected
}

function projectHeightAuthority(
  operationType: OperationType,
  raw: unknown,
): MachiningRecipeHeightAuthority {
  if (raw && typeof raw === 'object' &&
      (raw as { kind?: unknown }).kind === 'repair_required') {
    const candidate = raw as { reason?: unknown; message?: unknown }
    const reason = candidate.reason === 'missing_v2_authority' ||
      candidate.reason === 'invalid_v2_authority' ||
      candidate.reason === 'operation_type_mismatch'
      ? candidate.reason
      : 'invalid_v2_authority'
    return {
      kind: 'repair_required',
      reason,
      message: typeof candidate.message === 'string' && candidate.message.trim()
        ? candidate.message
        : SMART_HEIGHT_V2_REPAIR_MESSAGE,
    }
  }

  const validated = validatePersistedSmartHeightState(raw)
  if (!validated.ok) {
    return repairAuthority(
      raw === undefined ? 'missing_v2_authority' : 'invalid_v2_authority',
      raw === undefined ? undefined : validated.message,
    )
  }
  if (validated.state.intent.policy.operationType !== operationType) {
    return repairAuthority(
      'operation_type_mismatch',
      `Recipe operation '${operationType}' cannot use '${validated.state.intent.policy.operationType}' height intent.`,
    )
  }
  return {
    kind: 'smart_v2',
    intent: identityFreeIntent(validated.state.intent),
  }
}

export interface MachiningRecipe {
  schema: typeof MACHINING_RECIPE_SCHEMA
  version: typeof MACHINING_RECIPE_VERSION
  name: string
  operations: MachiningRecipeOperation[]
}

/**
 * Operation.params mixes machining choices with geometry bindings. Keeping an
 * explicit positive list prevents both today's ids and tomorrow's new fields
 * from silently becoming template data.
 */
const MACHINING_PARAM_KEYS = [
  'pathType',
  'openSide',
  'side',
  'direction',
  'tabs',
  'tabWidth',
  'tabHeight',
  'tabCount',
  'tabShape',
  'cornerRelief',
  'cornerReliefGentle',
  'cornerReliefEngagement',
  'roughingStyle',
  'engraveStyle',
  'trochoidalWidth',
  'trochoidalAdvance',
  'heightReference',
  'planeOffset',
  'contourFinishMode',
  'boundarySource',
  'orderStrategy',
  'fillStrategy',
  'floorStockToLeave',
  'finishContour',
  'helixDiameter',
  'overlapMm',
  'stepoverLeadIn',
  'stayDown',
  'stayDownLift',
  'entryClearance',
  'slotFeedPercent',
  'roundRingCorners',
  'cycleType',
  'peckDepth',
  'chipBreakRetract',
  'dwell',
  'retractMode',
  'sortStrategy',
  'perHoleDepth',
  'geometrySource',
  'targetDiameter',
  'perBoreDepth',
  'threadKind',
  'externalReference',
  'majorDiameter',
  'pitch',
  'tpi',
  'handedness',
  'cutDirection',
  'roughingPasses',
  'radialStepover',
  'springPasses',
  'leadInOut',
  'compensation',
  'threadDepth',
  'chamferWidth',
  'tipOffset',
  'targetEngagement',
  'maxEngagement',
  'stepDistance',
  'thetaMax',
  'climb',
  'rampAngle',
  'completionTolerance',
  'minHelixRadius',
  'tolerance',
  'integralWallFollow',
  'integralWallFollowLengthFactor',
  'wallCleanupAsWeGo',
  'loopbackFilletPct',
  'floorFinish',
  'wallFinish',
  'wallFinishMode',
  'stockOffset',
  'boundaryContainment',
  'pattern',
  'passAngle',
  'fromOtherSide',
  'passExtension',
  'chipThinning',
  'bothSidesPerLevel',
  'finishPass',
  'entryType',
  'leadInRadius',
  'leadOutRadius',
  'keepToolDown',
  'maxStayDownDistance',
  'extendBeforeRetract',
  'transition',
  'includeOpen',
  'includeClosed',
  'mode',
  'depthModel',
  'sideOffset',
  'axialOffset',
  'targetLineWidth',
  'useWidthForDepth',
] as const

function projectMachiningParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    MACHINING_PARAM_KEYS
      .filter((key) => Object.hasOwn(params, key))
      .filter((key) => ['boolean', 'number', 'string'].includes(typeof params[key]))
      .map((key) => [key, params[key]]),
  )
}

function projectFeedsAndSpeeds(feeds: FeedsAndSpeeds): FeedsAndSpeeds {
  return {
    rpm: feeds.rpm,
    feedRate: feeds.feedRate,
    plungeRate: feeds.plungeRate,
    depthOfCut: feeds.depthOfCut,
    stepover: feeds.stepover,
    ...(feeds.rampFeedrate === undefined ? {} : { rampFeedrate: feeds.rampFeedrate }),
    ...(feeds.leadInFeedrate === undefined ? {} : { leadInFeedrate: feeds.leadInFeedrate }),
    ...(feeds.leadOutFeedrate === undefined ? {} : { leadOutFeedrate: feeds.leadOutFeedrate }),
    ...(feeds.fastTraverseFeedrate === undefined
      ? {}
      : { fastTraverseFeedrate: feeds.fastTraverseFeedrate }),
    ...(feeds.finishFeedrate === undefined ? {} : { finishFeedrate: feeds.finishFeedrate }),
    ...(feeds.rampAngle === undefined ? {} : { rampAngle: feeds.rampAngle }),
    ...(feeds.coolant === undefined ? {} : { coolant: feeds.coolant }),
    ...(feeds.surfaceSpeed === undefined ? {} : { surfaceSpeed: feeds.surfaceSpeed }),
    ...(feeds.feedPerTooth === undefined ? {} : { feedPerTooth: feeds.feedPerTooth }),
  }
}

function projectTool(tool: Tool): Tool {
  return {
    id: tool.id,
    name: tool.name,
    type: tool.type,
    diameter: tool.diameter,
    fluteLength: tool.fluteLength,
    shankDiameter: tool.shankDiameter,
    overallLength: tool.overallLength,
    ...(tool.shoulderLength === undefined ? {} : { shoulderLength: tool.shoulderLength }),
    ...(tool.lengthBelowHolder === undefined
      ? {}
      : { lengthBelowHolder: tool.lengthBelowHolder }),
    numberOfFlutes: tool.numberOfFlutes,
    ...(tool.cornerRadius === undefined ? {} : { cornerRadius: tool.cornerRadius }),
    ...(tool.angleFromAxisDeg === undefined ? {} : { angleFromAxisDeg: tool.angleFromAxisDeg }),
    ...(tool.tipDiameter === undefined ? {} : { tipDiameter: tool.tipDiameter }),
    ...(tool.neckDiameter === undefined ? {} : { neckDiameter: tool.neckDiameter }),
    ...(tool.threadFormAngleDeg === undefined
      ? {}
      : { threadFormAngleDeg: tool.threadFormAngleDeg }),
    ...(tool.threadTeethCount === undefined
      ? {}
      : { threadTeethCount: tool.threadTeethCount }),
    ...(tool.threadPitch === undefined ? {} : { threadPitch: tool.threadPitch }),
    ...(tool.neckTransitionAngleDeg === undefined
      ? {}
      : { neckTransitionAngleDeg: tool.neckTransitionAngleDeg }),
    material: tool.material,
    coating: tool.coating,
    ...(tool.vendor === undefined ? {} : { vendor: tool.vendor }),
    ...(tool.productId === undefined ? {} : { productId: tool.productId }),
    ...(tool.toolNumber === undefined ? {} : { toolNumber: tool.toolNumber }),
    ...(tool.cutHand === undefined ? {} : { cutHand: tool.cutHand }),
    ...(tool.holderId === undefined ? {} : { holderId: tool.holderId }),
    ...(tool.libraryId === undefined ? {} : { libraryId: tool.libraryId }),
    notes: tool.notes,
    feedsAndSpeeds: Object.fromEntries(
      Object.entries(tool.feedsAndSpeeds).map(([material, feeds]) => [
        material,
        projectFeedsAndSpeeds(feeds),
      ]),
    ),
  }
}

function projectHeights(heights: HeightParams): HeightParams {
  const intent = heights.heightIntent
  return {
    clearanceHeight: heights.clearanceHeight,
    clearanceHeightMode: heights.clearanceHeightMode,
    retractHeight: heights.retractHeight,
    feedHeight: heights.feedHeight,
    topHeight: heights.topHeight,
    topHeightMode: heights.topHeightMode,
    bottomHeight: heights.bottomHeight,
    bottomHeightMode: heights.bottomHeightMode,
    ...(heights.bottomManual === undefined ? {} : { bottomManual: heights.bottomManual }),
    ...(intent === undefined ? {} : {
      heightIntent: {
        version: intent.version,
        clearance: {
          reference: intent.clearance.reference,
          offset: intent.clearance.offset,
          provenance: intent.clearance.provenance,
        },
        retract: {
          reference: intent.retract.reference,
          offset: intent.retract.offset,
          provenance: intent.retract.provenance,
        },
        feed: {
          reference: intent.feed.reference,
          offset: intent.feed.offset,
          provenance: intent.feed.provenance,
        },
        top: {
          reference: intent.top.reference,
          offset: intent.top.offset,
          provenance: intent.top.provenance,
        },
        bottom: {
          reference: intent.bottom.reference,
          offset: intent.bottom.offset,
          provenance: intent.bottom.provenance,
        },
      },
    }),
  }
}

function projectPasses(passes: PassParams): PassParams {
  return {
    stepdown: passes.stepdown,
    stepover: passes.stepover,
    ...(passes.finishStepover === undefined ? {} : { finishStepover: passes.finishStepover }),
    stockToLeave: passes.stockToLeave,
    ...(passes.floorStockToLeave === undefined
      ? {}
      : { floorStockToLeave: passes.floorStockToLeave }),
    finishPasses: passes.finishPasses,
    springPasses: passes.springPasses,
    ...(passes.overlapMm === undefined ? {} : { overlapMm: passes.overlapMm }),
  }
}

function projectLinking(linking: LinkingParams): LinkingParams {
  return {
    entryType: linking.entryType,
    rampAngle: linking.rampAngle,
    rampLength: linking.rampLength,
    leadInRadius: linking.leadInRadius,
    leadOutRadius: linking.leadOutRadius,
    retractType: linking.retractType,
    transitionType: linking.transitionType,
  }
}

function projectFeedrateOverride(feedrate: FeedrateOverride): FeedrateOverride {
  return {
    enabled: feedrate.enabled,
    rpm: feedrate.rpm,
    feedRate: feedrate.feedRate,
    plungeRate: feedrate.plungeRate,
    rampFeedrate: feedrate.rampFeedrate,
    leadInFeedrate: feedrate.leadInFeedrate,
    leadOutFeedrate: feedrate.leadOutFeedrate,
    fastTraverseFeedrate: feedrate.fastTraverseFeedrate,
    ...(feedrate.finishFeedrate === undefined
      ? {}
      : { finishFeedrate: feedrate.finishFeedrate }),
  }
}

function projectOperation(operation: MachiningRecipeOperation): MachiningRecipeOperation {
  return {
    name: operation.name,
    type: operation.type,
    enabled: operation.enabled,
    ...(operation.tool === undefined ? {} : { tool: projectTool(operation.tool) }),
    heightAuthority: projectHeightAuthority(
      operation.type,
      (operation as unknown as { heightAuthority?: unknown }).heightAuthority,
    ),
    heights: projectHeights(operation.heights),
    passes: projectPasses(operation.passes),
    linking: projectLinking(operation.linking),
    ...(operation.feedrateOverride === undefined
      ? {}
      : { feedrateOverride: projectFeedrateOverride(operation.feedrateOverride) }),
    params: projectMachiningParams(operation.params),
  }
}

function projectRecipe(recipe: MachiningRecipe): MachiningRecipe {
  return {
    schema: MACHINING_RECIPE_SCHEMA,
    version: MACHINING_RECIPE_VERSION,
    name: recipe.name,
    operations: recipe.operations.map(projectOperation),
  }
}

function requireRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`)
  }
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`)
  }
}

function validateRecipe(value: unknown): asserts value is MachiningRecipe {
  requireRecord(value, 'recipe')
  if (value.schema !== MACHINING_RECIPE_SCHEMA) {
    throw new TypeError(`recipe.schema must be '${MACHINING_RECIPE_SCHEMA}'`)
  }
  if (value.version !== MACHINING_RECIPE_VERSION) {
    throw new TypeError(`Unsupported recipe version '${String(value.version)}'`)
  }
  requireString(value.name, 'recipe.name')
  if (!Array.isArray(value.operations)) {
    throw new TypeError('recipe.operations must be an array')
  }
  value.operations.forEach((operation, index) => {
    requireRecord(operation, `recipe.operations[${index}]`)
    requireString(operation.name, `recipe.operations[${index}].name`)
  })
}

/** Capture only reusable machining fields from the selected operations. */
export function createMachiningRecipe(
  name: string,
  operations: readonly Operation[],
  tools: readonly Tool[],
): MachiningRecipe {
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]))
  return {
    schema: MACHINING_RECIPE_SCHEMA,
    version: MACHINING_RECIPE_VERSION,
    name,
    operations: operations.map((operation) => projectOperation({
      name: operation.name,
      type: operation.type,
      enabled: operation.enabled,
      tool: toolsById.get(operation.toolId),
      heightAuthority: projectHeightAuthority(operation.type, operation.smartHeight),
      heights: operation.heights,
      passes: operation.passes,
      linking: operation.linking,
      feedrateOverride: operation.feedrateOverride,
      params: operation.params,
    })),
  }
}

/** Project through the allow-list so unknown operation fields cannot travel. */
export function serializeRecipe(recipe: MachiningRecipe): string {
  validateRecipe(recipe)
  return JSON.stringify(projectRecipe(recipe))
}

export function deserializeRecipe(serialized: string): MachiningRecipe {
  const parsed: unknown = JSON.parse(serialized)
  validateRecipe(parsed)
  return projectRecipe(parsed)
}

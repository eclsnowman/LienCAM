import type { Operation, Setup, Tool } from '../../types'
import {
  SMART_HEIGHT_V2_REPAIR_MESSAGE,
  validatePersistedSmartHeightState,
  type OperationHeightIntentV2,
} from '../cam/smartHeights'
import type {
  MachiningRecipe,
  MachiningRecipeHeightAuthority,
  MachiningRecipeOperation,
  RecipeHeightRepairReason,
} from './recipeModel'

export interface MissingRecipeTool {
  operationName: string
  toolId: string
  toolName: string
}

export interface RecipeApplyResult {
  setup: Setup
  addedOperations: Operation[]
  missingTools: MissingRecipeTool[]
  repairRequired: RecipeHeightRepairRequired[]
}

export interface RecipeHeightRepairRequired {
  operationName: string
  reason: RecipeHeightRepairReason
  message: string
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

function rebindSetupOwners<T>(value: T, setupId: string): T {
  if (Array.isArray(value)) return value.map(item => rebindSetupOwners(item, setupId)) as T
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.kind === 'setup' && typeof record.setupId === 'string') {
      return { ...record, setupId } as T
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, rebindSetupOwners(child, setupId)]),
    ) as T
  }
  return value
}

type RestoredHeightAuthority =
  | { ok: true; smartHeight: { kind: 'smart_v2'; intent: OperationHeightIntentV2 } }
  | { ok: false; repair: Omit<RecipeHeightRepairRequired, 'operationName'> }

function repairReason(value: unknown): RecipeHeightRepairReason {
  return value === 'missing_v2_authority' ||
    value === 'invalid_v2_authority' ||
    value === 'operation_type_mismatch'
    ? value
    : 'invalid_v2_authority'
}

function restoreHeightAuthority(
  operationType: Operation['type'],
  authority: MachiningRecipeHeightAuthority | unknown,
  targetSetupId: string,
): RestoredHeightAuthority {
  if (!authority || typeof authority !== 'object' ||
      (authority as { kind?: unknown }).kind === 'repair_required') {
    const repair = authority as Partial<Extract<
      MachiningRecipeHeightAuthority,
      { kind: 'repair_required' }
    >> | undefined
    return {
      ok: false,
      repair: {
        reason: authority === undefined
          ? 'missing_v2_authority'
          : repairReason(repair?.reason),
        message: typeof repair?.message === 'string' && repair.message.trim()
          ? repair.message
          : SMART_HEIGHT_V2_REPAIR_MESSAGE,
      },
    }
  }

  const validated = validatePersistedSmartHeightState(authority)
  if (!validated.ok) {
    return {
      ok: false,
      repair: { reason: 'invalid_v2_authority', message: validated.message },
    }
  }
  if (validated.state.intent.policy.operationType !== operationType) {
    return {
      ok: false,
      repair: {
        reason: 'operation_type_mismatch',
        message: `Recipe operation '${operationType}' cannot use '${validated.state.intent.policy.operationType}' height intent. ${SMART_HEIGHT_V2_REPAIR_MESSAGE}`,
      },
    }
  }
  return {
    ok: true,
    smartHeight: {
      kind: 'smart_v2',
      intent: rebindSetupOwners(validated.state.intent, targetSetupId),
    },
  }
}

function applyOperation(
  recipeOperation: MachiningRecipeOperation,
  toolId: string,
  newOperationId: () => string,
  targetSetupId: string,
): { operation: Operation; repair?: Omit<RecipeHeightRepairRequired, 'operationName'> } {
  const heightAuthority = restoreHeightAuthority(
    recipeOperation.type,
    recipeOperation.heightAuthority,
    targetSetupId,
  )
  const repairMessage = heightAuthority.ok ? undefined : heightAuthority.repair.message
  return {
    operation: {
      id: newOperationId(),
      name: recipeOperation.name,
      type: recipeOperation.type,
      enabled: recipeOperation.enabled,
      status: heightAuthority.ok ? 'pending' : 'error',
      toolId,
      geometrySelections: [],
      ...(heightAuthority.ok ? { smartHeight: heightAuthority.smartHeight } : {}),
      heights: cloneValue(recipeOperation.heights),
      passes: cloneValue(recipeOperation.passes),
      linking: cloneValue(recipeOperation.linking),
      ...(recipeOperation.feedrateOverride === undefined
        ? {}
        : { feedrateOverride: cloneValue(recipeOperation.feedrateOverride) }),
      params: cloneValue(recipeOperation.params),
      ...(repairMessage === undefined ? {} : { errorMessage: repairMessage }),
    },
    ...(heightAuthority.ok ? {} : { repair: heightAuthority.repair }),
  }
}

/**
 * Insert every template operation. Missing tools and geometry leave an
 * intentionally incomplete operation instead of preventing the insertion.
 */
export function applyRecipeToSetup(
  recipe: MachiningRecipe,
  targetSetup: Setup,
  currentTools: readonly Tool[],
  newOperationId: () => string,
): RecipeApplyResult {
  const toolsById = new Map(currentTools.map((tool) => [tool.id, tool]))
  const missingTools: MissingRecipeTool[] = []
  const repairRequired: RecipeHeightRepairRequired[] = []
  const addedOperations = recipe.operations.map((recipeOperation) => {
    const recipeTool = recipeOperation.tool
    const tool = recipeTool === undefined ? undefined : toolsById.get(recipeTool.id)
    if (recipeTool !== undefined && tool === undefined) {
      missingTools.push({
        operationName: recipeOperation.name,
        toolId: recipeTool.id,
        toolName: recipeTool.name,
      })
    }
    const applied = applyOperation(
      recipeOperation,
      tool?.id ?? '',
      newOperationId,
      targetSetup.id,
    )
    if (applied.repair) {
      repairRequired.push({ operationName: recipeOperation.name, ...applied.repair })
    }
    return applied.operation
  })

  return {
    setup: {
      ...targetSetup,
      operations: [...targetSetup.operations, ...addedOperations],
    },
    addedOperations,
    missingTools,
    repairRequired,
  }
}

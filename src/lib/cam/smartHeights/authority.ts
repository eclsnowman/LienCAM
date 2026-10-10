import type { Operation, PersistedOperationHeightState } from '../../../types'
import { OPERATION_HEIGHT_POLICIES, operationHeightPolicy } from './policies'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  type OperationHeightIntentV2,
  type OperatorPlaneOverrides,
} from './types'

/** Read the operator's Top/Bottom Height overrides from persisted authority. */
export function operatorPlaneOverridesFromState(raw: unknown): OperatorPlaneOverrides {
  const validated = validatePersistedSmartHeightState(raw)
  if (!validated.ok) return {}
  const overrides = validated.state.intent.planeOverrides
  return {
    ...(overrides?.top ? { top: { ...overrides.top } } : {}),
    ...(overrides?.bottom ? { bottom: { ...overrides.bottom } } : {}),
  }
}

/** Stamp exactly these operator overrides onto valid V2 authority, replacing
 * any it carried. Invalid or missing authority is returned untouched so the
 * existing repair path still reports it. */
export function withOperatorPlaneOverrides(
  raw: PersistedOperationHeightState | undefined,
  overrides: OperatorPlaneOverrides,
): PersistedOperationHeightState | undefined {
  const validated = validatePersistedSmartHeightState(raw)
  if (!validated.ok) return raw
  const { planeOverrides: _replaced, ...intent } = validated.state.intent
  const planeOverrides: OperatorPlaneOverrides = {
    ...(overrides.top ? { top: { ...overrides.top } } : {}),
    ...(overrides.bottom ? { bottom: { ...overrides.bottom } } : {}),
  }
  return {
    kind: 'smart_v2',
    intent: planeOverrides.top || planeOverrides.bottom ? { ...intent, planeOverrides } : intent,
  }
}

export type PersistedSmartHeightValidation =
  | { ok: true; state: { kind: 'smart_v2'; intent: OperationHeightIntentV2 } }
  | {
    ok: false
    code:
      | 'invalid_envelope'
      | 'unsupported_policy_version'
      | 'unknown_policy'
      | 'inactive_variant'
    message: string
  }

export type SmartHeightPersistenceErrorCode =
  | Exclude<PersistedSmartHeightValidation, { ok: true }>['code']
  | 'missing_live_authority'
  | 'policy_operation_mismatch'
  | 'unsupported_operation'

export class SmartHeightPersistenceError extends Error {
  readonly code: SmartHeightPersistenceErrorCode

  constructor(code: SmartHeightPersistenceErrorCode, message: string) {
    super(message)
    this.name = 'SmartHeightPersistenceError'
    this.code = code
  }
}

export const SMART_HEIGHT_V2_REPAIR_MESSAGE =
  'This operation has no valid Smart Height V2 setup. Reopen it, reselect or re-enter its required inputs, and save it before previewing or computing.'

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Validate the sole persisted Smart Height authority. Legacy markers and
 * missing authority are deliberately invalid: the project may still load, but
 * that operation must be re-authored before preview, compute, simulation, or
 * posting can use it. */
export function validatePersistedSmartHeightState(
  raw: PersistedOperationHeightState | unknown,
): PersistedSmartHeightValidation {
  const envelope = record(raw)
  if (!envelope || envelope.kind !== 'smart_v2') {
    return {
      ok: false,
      code: 'invalid_envelope',
      message: SMART_HEIGHT_V2_REPAIR_MESSAGE,
    }
  }
  const intent = record(envelope.intent)
  if (intent?.version !== SMART_HEIGHT_INTENT_VERSION ||
      intent.policyVersion !== SMART_HEIGHT_POLICY_VERSION) {
    return {
      ok: false,
      code: 'unsupported_policy_version',
      message: `Smart Height intent/policy version ${String(intent?.version)}/${String(intent?.policyVersion)} is unsupported.`,
    }
  }
  const policy = record(intent.policy)
  const operationType = policy?.operationType
  const variantName = policy?.variant
  const registered = typeof operationType === 'string'
    ? (OPERATION_HEIGHT_POLICIES as Record<string, {
        variants: Record<string, { activation: { status: string; reason?: string } }>
      }>)[operationType]
    : undefined
  const variant = registered && typeof variantName === 'string'
    ? registered.variants[variantName]
    : undefined
  if (!variant) {
    return {
      ok: false,
      code: 'unknown_policy',
      message: 'Smart Height V2 policy operation or variant is not registered in this build.',
    }
  }
  if (variant.activation.status !== 'live' && variant.activation.status !== 'provisional') {
    return {
      ok: false,
      code: 'inactive_variant',
      message: `${String(operationType)} Smart Height variant '${String(variantName)}' is ` +
        `${variant.activation.status}: ${variant.activation.reason ?? 'no active V2 path exists.'}`,
    }
  }
  const safety = record(intent.safety)
  if (!safety || !record(safety.clearance) || !record(safety.retract) || !record(safety.feed) ||
      !record(intent.machining)) {
    return {
      ok: false,
      code: 'invalid_envelope',
      message: 'Smart Height V2 intent is missing a required safety plane or machining intent.',
    }
  }
  return {
    ok: true,
    state: envelope as unknown as { kind: 'smart_v2'; intent: OperationHeightIntentV2 },
  }
}

/** Enforce V2-only operation insertion and runtime boundaries. */
export function ensureOperationSmartHeightAuthority(operation: Operation): Operation {
  const familyPolicy = operationHeightPolicy(operation.type)
  if (!familyPolicy || familyPolicy.support !== 'live') {
    throw new SmartHeightPersistenceError(
      'unsupported_operation',
      `${operation.type} has no live Smart Height V2 policy in this build.`,
    )
  }
  if (operation.smartHeight === undefined) {
    throw new SmartHeightPersistenceError(
      'missing_live_authority',
      `${operation.type} has no Smart Height V2 authority. ${SMART_HEIGHT_V2_REPAIR_MESSAGE}`,
    )
  }
  const validated = validatePersistedSmartHeightState(operation.smartHeight)
  if (!validated.ok) {
    throw new SmartHeightPersistenceError(validated.code, validated.message)
  }
  if (validated.state.intent.policy.operationType !== operation.type) {
    throw new SmartHeightPersistenceError(
      'policy_operation_mismatch',
      `${operation.type} cannot use ${validated.state.intent.policy.operationType} Smart Height authority.`,
    )
  }
  return operation
}

import type { Operation, Project, Setup, WCS } from '../types'
import { OPERATION_REGISTRY } from './registry'
import { editOperation } from './operationEdits'
import { operationAuthoringDecision, setupAuthoringDecision } from './authoring'
import type { AuthoringText, OperationAuthoringFacts, SetupAuthoringFacts } from './authoring'

export type SetupPatch = Omit<Partial<Setup>, 'wcs' | 'id' | 'machineActions'> & { wcs?: Partial<WCS> }
export type CamCommand =
  | { kind: 'setup.add'; setup: Setup }
  | { kind: 'setup.update'; setupId: string; patch: SetupPatch }
  | { kind: 'operation.add'; setupId: string; operation: Operation }
  | { kind: 'operation.update'; setupId: string; operationId: string; patch: Partial<Operation> }
  | { kind: 'operation.remove'; setupId: string; operationId: string }
export type CamAuthoringCheck =
  | { kind: 'operation'; facts: OperationAuthoringFacts; text: AuthoringText }
  | { kind: 'setup'; facts: SetupAuthoringFacts }
export type CamCommandResult = { ok: true; project: Project; authored: boolean; addedOperation: boolean }
  | { ok: false; code: 'invalid-command' | 'missing-target' | 'duplicate-id' | 'invalid-draft'; message?: string }

/** Existing product invalidation/authority adapters. All work is prepared before
 * the store publishes anything; these adapters must not mutate their inputs. */
export interface CamCommandServices {
  normalizeOperation: (operation: Operation) => Operation
  updateSetup: (setup: Setup, patch: SetupPatch) => Setup
  orderOperations: (operations: Operation[]) => Operation[]
  removeOperation: (setup: Setup, operationId: string) => Setup
  reconcile: (project: Project, setupId: string, previous: Project) => Project
}

// WO-1434 / WO-1582: compute publication is not an authored edit. Preserve the
// model-reference fallback and ready dependsOnPredecessors publication routes.
const RESULT_FIELDS: ReadonlySet<string> = new Set<keyof Operation>([
  'status', 'toolpathMoves', 'computeTimeMs', 'estimatedCutTimeMs',
  'estimatedCutTimeMsError', 'errorMessage', 'progress', 'progressPhase',
  'resolvedHeights', 'resolvedHeightPlan', 'generationFingerprint',
  'diagnostics', 'contourTabPreview', 'modelReferences', 'modelReferenceNote', 'outdatedReason',
])
export function isAuthoredOperationUpdate(patch: Partial<Operation>): boolean {
  return Object.keys(patch).some(key => !RESULT_FIELDS.has(key)
    && !(key === 'dependsOnPredecessors' && patch.status === 'ready'))
}

function operationPatch(operation: Operation, patch: Partial<Operation>): Operation {
  // computing/error clears the prior path in the same write. Outdated/degraded
  // deliberately retain the established last-known-path fallback semantics.
  const clearsPath = patch.status === 'computing' || patch.status === 'error'
  const safe = patch.status !== undefined && patch.status !== 'ready' ? {
    ...patch,
    ...(clearsPath ? { toolpathMoves: undefined, computeTimeMs: undefined,
      estimatedCutTimeMs: undefined, estimatedCutTimeMsError: undefined } : {}),
    resolvedHeights: undefined, resolvedHeightPlan: undefined, generationFingerprint: undefined,
  } : patch
  const authoredKeys = ['name', 'enabled', 'toolId', 'params', 'heights', 'passes', 'linking',
    'feedrateOverride', 'geometrySelections', 'modelReferences', 'smartHeight']
  const edits = Object.entries(patch).filter(([key]) => authoredKeys.includes(key))
    .map(([path, value]) => ({ path, value }))
  // A result's model-reference refresh must not mark a generated item user-edited.
  const tracked = isAuthoredOperationUpdate(patch) && operation.provenance && edits.length
    ? editOperation(operation, edits) : operation
  return { ...tracked, ...safe }
}

/** Typed internal CAM transaction, shared by screen authoring and scripted/test
 * callers. It has no machine command, transport, active-target inference or AI
 * allow-list expansion. A failed batch returns no project to publish. */
export function prepareCamCommands(project: Project, commands: readonly CamCommand[],
  services: CamCommandServices, check?: CamAuthoringCheck): CamCommandResult {
  if (check?.kind === 'operation') {
    const decision = operationAuthoringDecision(check.facts, check.text)
    if (!decision.canCreate) return { ok: false, code: 'invalid-draft', message: decision.message }
  } else if (check?.kind === 'setup' && !setupAuthoringDecision(check.facts)) {
    return { ok: false, code: 'invalid-draft' }
  }
  let next = project
  let authored = false
  let addedOperation = false
  for (const command of commands) {
    // Runtime allow-list as well as the TS union: arbitrary external/JS input
    // cannot smuggle machine actions or project/machine patches into this API.
    if (!command || !['setup.add', 'setup.update', 'operation.add', 'operation.update', 'operation.remove'].includes(command.kind)) {
      return { ok: false, code: 'invalid-command' }
    }
    if (command.kind === 'setup.add') {
      if (!command.setup || command.setup.machineActions?.length || !Array.isArray(command.setup.operations)
        || command.setup.operations.some(op => !Object.hasOwn(OPERATION_REGISTRY, op.type))) return { ok: false, code: 'invalid-command' }
      if (next.setups.some(setup => setup.id === command.setup.id)) return { ok: false, code: 'duplicate-id' }
      next = { ...next, setups: [...next.setups, structuredClone(command.setup)], activeSetupId: command.setup.id }
      authored = true
      continue
    }
    const setup = next.setups.find(candidate => candidate.id === command.setupId)
    if (!setup) return { ok: false, code: 'missing-target' }
    let updated: Setup
    if (command.kind === 'setup.update') {
      if (!command.patch || 'machineActions' in command.patch || 'id' in command.patch
        || command.patch.operations?.some(op => !Object.hasOwn(OPERATION_REGISTRY, op.type))) return { ok: false, code: 'invalid-command' }
      updated = services.updateSetup(setup, structuredClone(command.patch))
      authored = true
    } else if (command.kind === 'operation.add') {
      if (!command.operation || !Object.hasOwn(OPERATION_REGISTRY, command.operation.type)) return { ok: false, code: 'invalid-command' }
      if (next.setups.some(candidate => candidate.operations.some(op => op.id === command.operation.id)
        || candidate.machineActions?.some(action => action.id === command.operation.id))) return { ok: false, code: 'duplicate-id' }
      let operation: Operation
      try { operation = services.normalizeOperation(structuredClone(command.operation)) }
      catch (error) { return { ok: false, code: 'invalid-draft', message: error instanceof Error ? error.message : String(error) } }
      updated = { ...setup, operations: services.orderOperations([...setup.operations, operation]) }
      next = { ...next, activeOperationId: operation.id }
      authored = true
      addedOperation = true
    } else {
      const operation = setup.operations.find(candidate => candidate.id === command.operationId)
      if (!operation) return { ok: false, code: 'missing-target' }
      if (command.kind === 'operation.remove') {
        updated = services.removeOperation(setup, command.operationId)
        authored = true
      } else {
        if (!command.patch || 'id' in command.patch || 'provenance' in command.patch || 'itemKey' in command.patch || 'userEdited' in command.patch
          || (command.patch.type !== undefined && !Object.hasOwn(OPERATION_REGISTRY, command.patch.type))) return { ok: false, code: 'invalid-command' }
        updated = { ...setup, operations: setup.operations.map(op => op === operation
          ? operationPatch(op, structuredClone(command.patch)) : op) }
        authored ||= isAuthoredOperationUpdate(command.patch)
      }
    }
    const previous = next
    next = { ...next, setups: next.setups.map(candidate => candidate === setup ? updated : candidate) }
    if (command.kind === 'operation.update' || command.kind === 'operation.remove') {
      next = services.reconcile(next, setup.id, previous)
    }
  }
  return { ok: true, project: next, authored, addedOperation }
}

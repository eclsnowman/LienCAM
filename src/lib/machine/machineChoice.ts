import { BUILT_IN_DIALECTS, type PostConfig } from '../post'
import type { ControllerType, MachineConfig } from '../../types'
import {
  backendForController,
  controllerNameFromRegistry,
  type MachineBackend,
  type MachineConnectionKind,
} from './backendRegistry'

export type { MachineBackend } from './backendRegistry'

export type ControllerResolution =
  | { ok: true; controller: ControllerType; dialect: PostConfig }
  | { ok: false; reason: string }

export const UNDECLARED_CONTROLLER_REASON =
  'This machine has not declared its controller. Set it in the Machine Library.'

export function controllerDisplayName(controller: ControllerType | string): string {
  const registeredName = controllerNameFromRegistry(controller)
  return registeredName !== controller
    ? registeredName
    : BUILT_IN_DIALECTS.find((candidate) => candidate.id === controller)?.label ?? controller

}

export function isGrblFamily(
  controller: string | null | undefined,
): controller is Extract<ControllerType, 'grbl' | 'grblhal'> {
  return backendForController(controller, 'serial') === 'grbl'
}

/**
 * The declared-controller to live-backend seam. With no connection kind this
 * retains the preferred-backend answer used by older readers; a caller that
 * has a connection choice resolves that exact route from the same registry.
 */
export function backendFor(
  controller: ControllerType | string,
  connectionKind?: MachineConnectionKind,
): MachineBackend | null {
  return backendForController(controller, connectionKind)
}

/**
 * The sole controller-identity dispatch boundary. Runtime project data can be
 * older than the closed ControllerType union, so a registry match is required
 * before either machine actions or posting can use the declaration.
 */
export function resolveDeclaredController(
  machine: MachineConfig | null | undefined,
): ControllerResolution {
  const controller = machine?.controller
  const dialect = controller
    ? BUILT_IN_DIALECTS.find((candidate) => candidate.id === controller)
    : undefined
  return controller && dialect
    ? { ok: true, controller, dialect }
    : { ok: false, reason: UNDECLARED_CONTROLLER_REASON }
}

// Id of the generic placeholder machine seeded into a fresh library / default
// project ('Sample hobby router (GRBL)'). A project still bound to this is treated as "no
// real machine chosen yet" so the load-time prompt fires. Kept in sync with the
// sample factory in src/lib/machine/sampleMachine.ts.
export const GENERIC_MACHINE_ID = 'default-machine'

// Pure predicate: does a loaded/restored project need the user to actively pick
// a machine? TRUE when:
//   - the project has no machine at all, OR
//   - the project's machine.id is not present in the library (unknown/stale), OR
//   - the project's machine is the generic 'default-machine' placeholder.
// A project bound to a KNOWN, non-generic library machine returns FALSE and is
// honored silently (no prompt). Deliberately side-effect-free for unit testing
// and reuse by the App-level load-prompt effect.
export function machineNeedsChoice(
  machine: MachineConfig | undefined | null,
  library: MachineConfig[],
): boolean {
  if (!machine || !machine.id) return true
  if (machine.id === GENERIC_MACHINE_ID) return true
  return !library.some((m) => m.id === machine.id)
}

// The machines a user can actually PICK in the forced-choice modal: every real
// library machine EXCLUDING the generic 'default-machine' placeholder. Picking the
// placeholder would leave the project still "generic" and re-trip machineNeedsChoice,
// so it is never an escape from the forced choice and must not be offered.
export function choosableMachines(library: MachineConfig[]): MachineConfig[] {
  return library.filter((m) => m.id !== GENERIC_MACHINE_ID)
}

// Should the App raise the forced load-time machine picker? TRUE only when the
// project needs a choice AND there is at least one REAL machine to pick. On a fresh
// install the library holds ONLY the generic placeholder, so there is nothing
// meaningful to choose: we must NOT prompt (the user would be trapped — the sole
// option is the generic machine, picking which re-trips the prompt forever). In that
// state the project simply keeps the generic machine until the user adds a real one
// in the Machine Library. Single source of truth for the App-level prompt effect.
export function shouldPromptMachineChoice(
  machine: MachineConfig | undefined | null,
  library: MachineConfig[],
): boolean {
  return machineNeedsChoice(machine, library) && choosableMachines(library).length > 0
}

import type { MachineConfig } from '../../types'
import type { ControllerEvents, MachineController } from './controller'

export type MachineConnectionKind = string
export type MachineBackend = string

export interface BackendCapabilityFlags {
  /** This route talks to a physical controller unless `isPhysicalConnection` says otherwise. */
  physicalConnection: boolean
  /** This route is LienCAM's in-process simulator, not a hardware transport. */
  simulator: boolean
  /** The route needs the browser's serial permission door. */
  serialPermission: boolean
  /** The backend owns GRBL-style settings reconciliation after connect. */
  grblSettings: boolean
}

export interface InstalledRegistryBackend<T extends MachineController = MachineController> {
  controller: T
  isCurrent(): boolean
}

export interface BackendConnectContext {
  machine: MachineConfig
  baudRate?: number
  isCurrent(): boolean
  install<T extends MachineController>(
    create: (events: ControllerEvents) => T,
  ): InstalledRegistryBackend<T>
}

export interface MachineBackendDefinition {
  controller: string
  controllerDisplayName: string
  backend: MachineBackend
  connectionKind: MachineConnectionKind
  capabilities: Readonly<BackendCapabilityFlags>
  /** The controller the installed session speaks: the declared one, or (the UCCNC bridge) UCCNC itself. */
  sessionController: 'declared' | string
  /** One controller's preferred live backend, retained for the old `backendFor(controller)` reader. */
  preferred?: boolean
  connect?: (context: BackendConnectContext) => Promise<MachineController | void>
  /** Refines physical authority for hardware demo modes, without a class check at the caller. */
  isPhysicalConnection?: (controller: MachineController) => boolean
}

const definitions = new Map<string, Map<MachineConnectionKind, MachineBackendDefinition>>()

/**
 * Add or replace one controller/connection route. The returned disposer restores
 * the previous definition, which keeps tests and optional backends isolated.
 */
export function registerMachineBackend(definition: MachineBackendDefinition): () => void {
  const byKind = definitions.get(definition.controller) ?? new Map()
  const previous = byKind.get(definition.connectionKind)
  byKind.set(definition.connectionKind, definition)
  definitions.set(definition.controller, byKind)
  return () => {
    const current = definitions.get(definition.controller)
    if (!current || current.get(definition.connectionKind) !== definition) return
    if (previous) current.set(definition.connectionKind, previous)
    else current.delete(definition.connectionKind)
    if (current.size === 0) definitions.delete(definition.controller)
  }
}

export function backendDefinitionFor(
  controller: string | null | undefined,
  connectionKind: MachineConnectionKind,
): MachineBackendDefinition | null {
  return controller ? definitions.get(controller)?.get(connectionKind) ?? null : null
}

export function backendForController(
  controller: string | null | undefined,
  connectionKind?: MachineConnectionKind,
): MachineBackend | null {
  if (!controller) return null
  if (connectionKind) return backendDefinitionFor(controller, connectionKind)?.backend ?? null
  const routes = definitions.get(controller)
  if (!routes) return null
  return [...routes.values()].find((definition) => definition.preferred)?.backend ?? null
}

export function controllerNameFromRegistry(controller: string): string {
  const first = definitions.get(controller)?.values().next().value as MachineBackendDefinition | undefined
  return first?.controllerDisplayName ?? controller
}

export function connectionKindsForController(controller: string | null | undefined): MachineConnectionKind[] {
  return controller ? [...(definitions.get(controller)?.keys() ?? [])] : []
}

const PHYSICAL = Object.freeze({
  physicalConnection: true,
  simulator: false,
  serialPermission: false,
  grblSettings: false,
})
const SERIAL_GRBL = Object.freeze({
  physicalConnection: true,
  simulator: false,
  serialPermission: true,
  grblSettings: true,
})
const SIMULATOR = Object.freeze({
  physicalConnection: false,
  simulator: true,
  serialPermission: false,
  grblSettings: false,
})

const DISPLAY_NAMES: Record<string, string> = {
  uccnc: 'UCCNC',
  grbl: 'GRBL',
  grblhal: 'grblHAL',
  linuxcnc: 'LinuxCNC',
  generic: 'Generic',
}

/** Metadata exists independently of machineSession so pure registry readers do not rely on import order. */
for (const controller of Object.keys(DISPLAY_NAMES)) {
  registerMachineBackend({
    controller,
    controllerDisplayName: DISPLAY_NAMES[controller],
    backend: 'simulator',
    connectionKind: 'simulator',
    capabilities: SIMULATOR,
    sessionController: 'declared',
  })
}

// WO-2066: the machine bridge drives UCCNC and nothing else. Operator ruling 2026-09-26:
// "UCCNC and LinuxCNC are completely different software." A LinuxCNC, Generic,
// GRBL or grblHAL declaration has no bridge route, so nothing can install the
// UCCNC backend for it. Each keeps its own routes: its simulator above, and
// USB serial below for GRBL and grblHAL.
registerMachineBackend({
  controller: 'uccnc',
  controllerDisplayName: DISPLAY_NAMES.uccnc,
  backend: 'uccnc',
  connectionKind: 'bridge',
  capabilities: PHYSICAL,
  sessionController: 'uccnc',
  preferred: true,
})

// WO-1987: LinuxCNC's own route - gateway.py on the LinuxCNC PC
// (docs/machine/LINUXCNC-GATEWAY-PROTOCOL.md), driving LinuxCNC through its
// own backend (src/lib/machine/linuxcnc/). No UCCNC code on it.
registerMachineBackend({
  controller: 'linuxcnc',
  controllerDisplayName: DISPLAY_NAMES.linuxcnc,
  backend: 'linuxcnc',
  connectionKind: 'gateway',
  capabilities: PHYSICAL,
  sessionController: 'declared',
  preferred: true,
})

for (const controller of ['grbl', 'grblhal']) {
  registerMachineBackend({
    controller,
    controllerDisplayName: DISPLAY_NAMES[controller],
    backend: 'grbl',
    connectionKind: 'serial',
    capabilities: SERIAL_GRBL,
    sessionController: 'declared',
    preferred: true,
  })
}

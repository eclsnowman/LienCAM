import type { ControllerType, MachineConfig } from '../../types'
import type { MachineConnectionKind } from './machineSession'

export type ControllerMacroFlavour = 'uccnc' | 'grbl' | 'none'
export type ControllerProbeVerbs = 'typed' | 'text' | 'none'

export interface ControllerSurface {
  controller: ControllerType | null
  uccncProfile: boolean
  bridgeSettings: boolean
  grblSettings: boolean
  macros: ControllerMacroFlavour
  probeVerbs: ControllerProbeVerbs
  postFlavour: ControllerType | null
  connectionKinds: readonly MachineConnectionKind[]
  defaultConnectionKind: MachineConnectionKind
}

const SURFACES: Record<ControllerType, ControllerSurface> = {
  uccnc: {
    controller: 'uccnc',
    uccncProfile: true,
    bridgeSettings: true,
    grblSettings: false,
    macros: 'uccnc',
    probeVerbs: 'typed',
    postFlavour: 'uccnc',
    connectionKinds: ['bridge', 'simulator'],
    defaultConnectionKind: 'bridge',
  },
  grbl: {
    controller: 'grbl',
    uccncProfile: false,
    bridgeSettings: false,
    grblSettings: true,
    macros: 'grbl',
    probeVerbs: 'text',
    postFlavour: 'grbl',
    connectionKinds: ['serial', 'simulator'],
    defaultConnectionKind: 'serial',
  },
  grblhal: {
    controller: 'grblhal',
    uccncProfile: false,
    bridgeSettings: false,
    grblSettings: true,
    macros: 'grbl',
    probeVerbs: 'text',
    postFlavour: 'grblhal',
    connectionKinds: ['serial', 'simulator'],
    defaultConnectionKind: 'serial',
  },
  linuxcnc: {
    controller: 'linuxcnc',
    uccncProfile: false,
    bridgeSettings: false,
    grblSettings: false,
    macros: 'none',
    probeVerbs: 'none',
    postFlavour: 'linuxcnc',
    // WO-1987: LinuxCNC's own connection, the gateway on the LinuxCNC PC,
    // first and picked - as UCCNC's bridge is for a UCCNC machine - then its
    // simulator. Never the UCCNC bridge or GRBL serial (WO-2066, WO-2068).
    connectionKinds: ['gateway', 'simulator'],
    defaultConnectionKind: 'gateway',
  },
  generic: {
    controller: 'generic',
    uccncProfile: false,
    bridgeSettings: false,
    grblSettings: false,
    macros: 'none',
    probeVerbs: 'none',
    postFlavour: 'generic',
    connectionKinds: ['bridge', 'serial', 'simulator'],
    defaultConnectionKind: 'simulator',
  },
}

const UNDECLARED_SURFACE: ControllerSurface = {
  controller: null,
  uccncProfile: false,
  bridgeSettings: false,
  grblSettings: false,
  macros: 'none',
  probeVerbs: 'none',
  postFlavour: null,
  connectionKinds: ['bridge', 'serial', 'simulator'],
  defaultConnectionKind: 'simulator',
}

/**
 * The one declaration-to-surface mapping. A controller declaration decides
 * whether controller-owned UI exists; live connection facts only decide
 * whether the resulting controls are enabled and what they report.
 */
export function controllerSurface(
  machine: Pick<MachineConfig, 'controller'> | null | undefined,
): ControllerSurface {
  const controller = machine?.controller
  return controller && Object.prototype.hasOwnProperty.call(SURFACES, controller)
    ? SURFACES[controller]
    : UNDECLARED_SURFACE
}

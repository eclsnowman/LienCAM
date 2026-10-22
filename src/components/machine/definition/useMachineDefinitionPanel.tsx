import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { type MachineConfig } from '../../../types'
import { type MachineConnectionKind } from '../../../lib/machine/machineSession'
import { getMachineController } from '../../../lib/machine/machineSession'
import { type JointReading } from '../../../lib/machine/controller'
import { type LinuxcncHello } from '../../../lib/machine/linuxcnc/linuxcncController'
import { type BridgeProcessStatus } from '../../../lib/machine/bridgeHost'
import { controlMachine } from '../../../store'
import { useCamStore } from '../../../store'
import { useUiPrefs } from '../../../store/uiPrefs'
import { BRIDGE_DEFAULT_PORT } from '../../../lib/machine/bridgeTransport'
import { droppedTypedValuesMessage } from '../../../lib/machine/operatorMessages'
import { bridgeProcessStatus } from '../../../lib/machine/bridgeHost'
import { startBridge } from '../../../lib/machine/bridgeHost'
import { useMachineDefHideEmptySettings } from '../../../lib/machine/uiPrefs'
import { useSyncExternalStore } from 'react'
import { subscribeVfdPortLink } from '../../../lib/machine/bridgeTransport'
import { vfdPortLinkState } from '../../../lib/machine/bridgeTransport'
import { useMachineControl } from '../../../store/machineControlStore'
import { machineSerialBaud } from '../../../store'
import { useRef } from 'react'
import { useState } from 'react'
import { bridgeHostCapability } from '../../../lib/machine/bridgeHost'
import { hasLegacyBridgeStatusHost } from '../../../lib/machine/bridgeHost'
import { useCallback } from 'react'
import { chooseMachinePath } from '../../../lib/machine/bridgeHost'
import { useEffect } from 'react'
import { subscribeMachineSpindleLinkApply } from '../../../lib/machine/machineSession'
import { machineSpindleLinkApplyInFlight } from '../../../lib/machine/machineSession'
import { type VfdPath } from './SpindleLinkSection'
import { vfdPathKey } from './SpindleLinkSection'
import { vfdValueAt } from './SpindleLinkSection'
import { type VfdDefinition } from '../../../lib/machine/vfd'
import { parseVfdEdit } from './SpindleLinkSection'
import { withVfdValue } from './SpindleLinkSection'
import { type MachineSpindleLinkDefinition } from '../../../types'
import { validateVfdDefinition } from '../../../lib/machine/vfd'
import { completeVfdRunStateValues, VFD_MODEL_TEMPLATES } from '../../../lib/machine/vfd'
import { applyMachineSpindleLinkDefinition } from '../../../lib/machine/machineSession'
import { type VfdEditContext } from './SpindleLinkSection'
import { type ApplyReportLine } from '../../../lib/machine/machineSession'
import { type DefGroup } from './DefinitionNavigation'
import { consumeMachineDefinitionSection, peekMachineDefinitionSectionRequestMachineId, subscribeMachineDefinitionSectionRequests } from './machineDefinitionSectionRequest'
import { type ControllerDefinition } from '../../../types'
import { type PendingSettings } from './DefinitionFields'
import { stopBridge } from '../../../lib/machine/bridgeHost'
import { restartBridge } from '../../../lib/machine/bridgeHost'
import { readSkewBox } from './SkewField'
import { machineSkew } from '../../../types'
import { type AxisName } from '../../../types'
import { createSettingSource } from './DefinitionFields'
import { UCCNC_CATALOGUE_CONTROLLER } from '../../../lib/machine/uccncProfileImport'
import { uccncSettingField } from '../../../lib/machine/uccncProfileImport'
import { createDefaultControllerDefinition } from '../../../types'
import { AXIS_NAMES } from '../../../types'
import { type AxisDefinition } from '../../../types'
import { withAxisSoftLimitEdited, withAxisTravelEdited } from '../../../lib/machine/axisSoftLimitEdit'
import { machineHomeConvention, machineTravel } from '../../../types'
import { signedAxisRange } from '../../../lib/machine/machineEnvelope'
import { createDefaultAxisDefinition } from '../../../types'
import { insertIntoHomingOrder } from './DefinitionFields'
import { type PinRef } from '../../../types'
import { claimPinPolarity } from './DefinitionFields'
import { type GrblSettingsRecord } from '../../../lib/machine/grbl/settings'
import { pinPolarityKey } from './DefinitionFields'
import { type AxisHomingDefinition } from '../../../types'
import { createDefaultAxisHomingDefinition } from '../../../types'
import { withAxisHomingStated } from '../../../types'
import { withAxisHomeBackOffStated } from '../../../types'
import { withAxisHomeInputStated } from '../../../types'
import { validateControllerDefinition } from '../../../types'
import { withMachineDefinitionProfileBaseline } from '../../../lib/machine/machineSession'
import { machineDefinitionApplyProvenance } from '../../../lib/machine/machineSession'
import { applyActiveMachineDefinition } from '../../../lib/machine/machineSession'
import { describeApplyOutcome } from '../../../lib/machine/machineSession'
import { controllerDefinitionPins } from '../../../types'
import { axisSoftLimitsAreStated } from '../../../lib/machine/resolvedMachineMotion'
import { isPinAssigned } from '../../../types'
import { controllerSurface } from '../../../lib/machine/controllerSurface'
import { definitionProblemGroup } from './DefinitionNavigation'
import { axisColorVar } from './DefinitionFields'
import { Plus } from 'lucide-react'


/** WHICH definition an apply answer was about: the machine's id plus its
 *  definition, verbatim. Any edit anywhere in the definition changes it, so a
 *  stale "Applied" can never stand over a definition the board has not seen.
 *  (WO-928's rule, carried here with the verb - not a second one.) */
export function definitionSignature(m: MachineConfig | null): string | null {
  return m && m.controllerDefinition
    ? `${m.id}:${JSON.stringify(m.controllerDefinition)}`
    : null
}

/** Profile fields that cannot become live through controller-definition Apply.
 * Presentation and independently receipt-owned facts are omitted; every other
 * saved field requires a reconnect before Control may use it.
 *
 * WO-1660: `skew` is omitted too, because it is NOT reconnect-bound. A saved
 * skew is pushed to the connected bridge the moment the record changes
 * (`syncSkewToBridge` via the store subscription, WO-1556) - the same receipt
 * that would otherwise be waited for on reconnect. Counting it here made a
 * Save that had already gone LIVE still read "pending and will become live
 * after reconnect" over the very number the bridge had just confirmed. */
export function reconnectBoundSignature(machine: MachineConfig): string {
  const {
    name: _name,
    notes: _notes,
    controllerDefinition: _controllerDefinition,
    spindleLinkDefinition: _spindleLinkDefinition,
    unsentSettings: _unsentSettings,
    skew: _skew,
    ...reconnectBound
  } = machine
  return JSON.stringify(reconnectBound)
}

/** The Machine area's one axis-pin edit door. Home input provenance is part
 *  of the same immutable definition update as the pin triple, so Save cannot
 *  persist a wire (or a deliberate unassigned answer) without also persisting
 *  that the machine addressed this fact. */
export function withDefinitionAxisPinEdited(
  definition: ControllerDefinition,
  controller: MachineConfig['controller'],
  axis: AxisName,
  field: keyof AxisDefinition,
  value: PinRef,
): ControllerDefinition {
  const claimed = claimPinPolarity(definition, `axes[${axis}].${String(field)}`, value)
  const next = {
    ...claimed.definition,
    axes: claimed.definition.axes.map((candidate) => (
      candidate.axis === axis
        ? { ...candidate, [field]: claimed.pin } as AxisDefinition
        : candidate
    )),
  }
  return field === 'homePin'
    ? withAxisHomeInputStated(next, controller, axis)
    : next
}

/** The Machine area's one homing-field edit door. Direction, homing value and
 *  back-off each state their own app-owned fact in the same update that writes
 *  the number, while speed/auto-zero retain their established raw behavior. */
export function withDefinitionAxisHomingEdited(
  definition: ControllerDefinition,
  controller: MachineConfig['controller'],
  axis: AxisName,
  updates: Partial<AxisHomingDefinition>,
): ControllerDefinition {
  const current = definition.homing.perAxis[axis]
  if (!current) return definition
  const parts = [
    ...('direction' in updates ? ['direction' as const] : []),
    ...('homingValue' in updates ? ['homingValue' as const] : []),
  ]
  const next = {
    ...definition,
    homing: {
      ...definition.homing,
      perAxis: { ...definition.homing.perAxis, [axis]: { ...current, ...updates } },
    },
  }
  const homingStated = parts.length > 0
    ? withAxisHomingStated(next, controller, axis, parts)
    : next
  return 'backOff' in updates
    ? withAxisHomeBackOffStated(homingStated, controller, axis)
    : homingStated
}

// ---------------------------------------------------------------------------

export interface MachineDefinitionPanelProps {
  /** Control's selected transport. Standalone/library tests fall back to the
   * machine's declared controller so the surface remains useful on its own. */
  connectionKind?: MachineConnectionKind
  /** ControlPage's connect/disconnect action is still in flight. This carries
   * the moved baud selector's original busy guard into the reused surface. */
  connectionBusy?: boolean
  /** Incremented by the zero-row Machine-header door. */
  controllerSetupFocus?: number
  /** WO-1696 review fix: the ONE record this panel edits, by id, whatever is
   *  connected. Only the Machine Library's walkthrough host passes it (a
   *  machine made with New is not the connected one); the definition page
   *  leaves it out and keeps editing `controlMachine`. */
  machineId?: string
}

export function setupKindFor(
  machine: Pick<MachineConfig, 'controller'>,
  selected: MachineConnectionKind | undefined,
): MachineConnectionKind {
  if (selected) return selected
  return controllerSurface(machine).defaultConnectionKind
}

/** WO-1988: `linuxcncHello` is LinuxCncController's own reader, not part of
 *  the shared `MachineController` interface - duck-typed the same way
 *  machineSession.ts reads a UCCNC `bridgeHello`. `null` on any other
 *  backend, never a guess. */
function readLinuxcncHello(ctrl: ReturnType<typeof getMachineController> | null): LinuxcncHello | null {
  if (!ctrl) return null
  const withHello = ctrl as { linuxcncHello?: () => LinuxcncHello | null }
  return typeof withHello.linuxcncHello === 'function' ? withHello.linuxcncHello() : null
}

export type BridgePanelState =
  | { kind: 'checking' }
  | { kind: 'building'; status: BridgeProcessStatus }
  | { kind: 'missing-install'; status: BridgeProcessStatus }
  | { kind: 'build-failed'; status: BridgeProcessStatus; reason: string }
  | { kind: 'healthy'; status: BridgeProcessStatus }
  | { kind: 'not-running'; status: BridgeProcessStatus }
  | { kind: 'failing'; status: BridgeProcessStatus; reason: string }
  | { kind: 'not-configured'; status: BridgeProcessStatus }
  | { kind: 'unavailable' }

export function bridgePanelState(status: BridgeProcessStatus | null): BridgePanelState {
  if (status === null) return { kind: 'unavailable' }
  if (status.setup?.state === 'building') return { kind: 'building', status }
  if (status.setup?.state === 'missing-install') return { kind: 'missing-install', status }
  if (status.setup?.state === 'failed') {
    return {
      kind: 'build-failed',
      status,
      reason: status.setup.error ?? controlText('useMachineDefinitionPanel.text001'),
    }
  }
  if (!status.configured) return { kind: 'not-configured', status }
  // The supervisor's `health` already knows whether the last exit was asked
  // for: a requested stop reads `stopped` with a `lastExit` still on record,
  // a crash reads `failing`. Keying on `lastExit` here turned the operator's
  // own Shut down into "needs recovery" and cancelled the next Connect
  // (WO-1179 audit round 2). The desktop preload (WO-1132) reports no
  // `health` and has no stop verb, so for it an exit record with no process
  // is still a crash.
  const health = status.health ?? (!status.running && status.lastExit !== null ? 'failing' : 'stopped')
  if (health === 'failing') {
    return {
      kind: 'failing',
      status,
      reason: status.failureReason ?? controlText('useMachineDefinitionPanel.text002'),
    }
  }
  if (!status.running) return { kind: 'not-running', status }
  return { kind: 'healthy', status }
}

export let bridgeConnectPassThrough: Element | null = null
export let automaticBridgeStart: Promise<boolean> | null = null

export function currentBridgePort(): number {
  const machine = controlMachine(useCamStore.getState())
  return useUiPrefs.getState().machineLinks[machine.id]?.bridgePort ?? BRIDGE_DEFAULT_PORT
}

function controlUsesBridge(): boolean {
  const liveKind = useMachineControl.getState().connectionKind
  if (liveKind !== null) return liveKind === 'bridge'
  const selected = document.querySelector<HTMLSelectElement>('[data-testid="control-kind-select"]')
  return selected !== null
    ? selected.value === 'bridge'
    : controllerSurface(controlMachine(useCamStore.getState())).defaultConnectionKind === 'bridge'
}

/** `press`: the operator's Connect, never the automatic start when Control opens. */
export async function ensureBridgeForControl(press = false): Promise<boolean> {
  // A UCCNC profile can run on the in-app simulator without its bridge.
  if (!controlUsesBridge()) return true
  if (automaticBridgeStart !== null) return automaticBridgeStart
  automaticBridgeStart = (async () => {
    const bridgePort = currentBridgePort()
    let status: BridgeProcessStatus | null
    try {
      status = await bridgeProcessStatus(bridgePort)
    } catch {
      // Status is advisory to the ordinary connection attempt. If a desktop
      // preload cannot answer it, preserve the pre-WO-1179 Connect behavior so
      // the connection layer can report its own concrete error.
      return true
    }
    if (status === null) return true
    const state = bridgePanelState(status)
    if (state.kind === 'healthy') return true
    // WO-2845 (ADR-0058 D4): the bridge stopped at the changed-DLL line, which
    // says "Press Connect again". This press is that second Connect.
    const changedDllPress = press && state.kind === 'failing' && status.lastExit?.code === 12
    if (state.kind === 'failing' && !changedDllPress) {
      useCamStore.getState().addConsoleEvent({
        severity: 'error', source: 'machine',
        message: controlText('useMachineDefinitionPanel.text003', { value1: String(state.reason) }),
      })
      return false
    }
    if (state.kind === 'not-configured') {
      useCamStore.getState().addConsoleEvent({
        severity: 'error', source: 'machine',
        message: controlText('useMachineDefinitionPanel.text004'),
      })
      return false
    }
    if (state.kind !== 'not-running' && !changedDllPress) return true
    let result
    try {
      result = await startBridge(
        bridgePort,
        useUiPrefs.getState().machineLinks[controlMachine(useCamStore.getState()).id],
        { operatorPress: press },
      )
    } catch {
      useCamStore.getState().addConsoleEvent({
        severity: 'error', source: 'machine',
        message: controlText('useMachineDefinitionPanel.text005'),
      })
      return false
    }
    if (!result.ok) {
      const message = result.reason === 'exited'
        ? controlText('useMachineDefinitionPanel.text006')
        : result.reason === 'no-socket'
          ? controlText('useMachineDefinitionPanel.text007', { value1: String(result.port) })
          : result.reason === 'not-configured'
            ? controlText('useMachineDefinitionPanel.text008')
            : controlText('useMachineDefinitionPanel.text009')
      useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'machine', message })
      return false
    }
    useCamStore.getState().addConsoleEvent({
      severity: 'success', source: 'machine',
      message: controlText('useMachineDefinitionPanel.text010', { value1: String(result.pid), value2: String(result.port) }),
    })
    window.dispatchEvent(new Event('liencam:bridge-lifecycle'))
    return true
  })().finally(() => { automaticBridgeStart = null })
  return automaticBridgeStart
}

// MachineDefinitionPanel is a static ControlPage import, so this owned module
// sees the ordinary Control and Connect gestures even when Definition is not
// the selected sub-view. That closes the real browser path without moving the
// connection semantics out of machineSession or editing ControlPage outside
// this order's ownership.
if (typeof document !== 'undefined') {
  const installation = window as typeof window & { __liencamBridgeLifecycleInstalled?: boolean }
  if (!installation.__liencamBridgeLifecycleInstalled) {
    installation.__liencamBridgeLifecycleInstalled = true
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null
      const connect = target?.closest('[data-testid="control-connect"]') ?? null
      if (connect !== null) {
        if (bridgeConnectPassThrough === connect) {
          bridgeConnectPassThrough = null
          return
        }
        const kind = document.querySelector<HTMLSelectElement>('[data-testid="control-kind-select"]')
        if (kind !== null && kind.value !== 'bridge') return
        // WO-2029: the desktop app owns its bridge child, and ControlPage's
        // Connect handler starts it (resetting a give-up) or says why. This
        // pre-flight read that exited child as 'failing' and cancelled the
        // press - Operator's silent Connect on 09-26. Browser supervisors keep it.
        if (bridgeHostCapability() === 'hosted') return
        event.preventDefault()
        event.stopPropagation()
        void ensureBridgeForControl(true).then((ready) => {
          if (!ready || !(connect instanceof HTMLButtonElement) || connect.disabled) return
          bridgeConnectPassThrough = connect
          connect.click()
        })
        return
      }
      const opensControl = target?.closest('[data-testid="mode-tab-control"]') !== null
      if (!opensControl) return
      void ensureBridgeForControl()
    }, true)

    // ControlPage may be code-split: in that case the click which opens
    // Control is what loads this module, so no listener could have observed
    // that already-dispatched click. Observe only its first mount, disconnect
    // before doing work, and defer the probe out of React's DOM mutation.
    const observeControl = new MutationObserver(() => {
      if (document.querySelector('[data-testid="control-page"]') === null) return
      observeControl.disconnect()
      window.setTimeout(() => {
        if (typeof document === 'undefined') return
        void ensureBridgeForControl()
      }, 0)
    })
    observeControl.observe(document.documentElement, { childList: true, subtree: true })
  }
}

export function useMachineDefinitionPanel({
  connectionKind,
  connectionBusy = false,
  controllerSetupFocus = 0,
  machineId,
}: MachineDefinitionPanelProps = {}) {
  useText('control-screens-not-probing')
  const machineLibrary         = useCamStore((s) => s.machineLibrary)
  const controlledMachine      = useCamStore(controlMachine)
  // WO-1698 review fix: a pending section request (machineDefinitionSectionRequest.ts)
  // names a machineId even when NO caller threaded an explicit `machineId`
  // prop in - the Machine Library's Travel link is exactly this case: it has
  // no prop path into the Definition page's own always-mounted instance
  // (ControlPage.tsx, out of this order's owned paths), so the request
  // itself is the only door.
  //
  // LOCAL state, not a live read of the module - `consumeMachineDefinitionSection`
  // (below) nulls the module's pending request once it is shown, and a naive
  // re-peek on the next render would then see nothing pending and flip
  // straight back to `controlledMachine` in the same instance that just
  // consumed it. The lazy initializer catches a request made before this
  // component existed (the Travel link case: nothing was listening when it
  // fired); the effect catches one made while already mounted. Cleared when
  // `controlledMachine` itself changes identity - the operator moving to a
  // different connection is a real "leave this override behind" signal, and
  // without it a request consumed once would otherwise pin this instance to
  // the named machine for the rest of the app session.
  // WO-1712 decide-and-log: outcome 2 offered two ways to stop a pending
  // request from landing a LATER visit (e.g. the Controller-setup gear) on
  // this named machine silently - expire the request on navigation, or make
  // the header say so. Picked the header (the `authorityText` line below):
  // it already renders on every one of the seven areas, not only the one the
  // request named, so switching areas inside this same mounted instance
  // never stops naming the machine on screen and never the connected one in
  // its own words. An expire-on-navigation rule would have to live in
  // ControlPage.tsx, outside this order's owned paths, for a fact this line
  // already carries everywhere it would apply.
  const [requestedMachineId, setRequestedMachineId] = useState<string | null>(
    () => peekMachineDefinitionSectionRequestMachineId(),
  )
  useEffect(() => subscribeMachineDefinitionSectionRequests(() => {
    setRequestedMachineId(peekMachineDefinitionSectionRequestMachineId())
  }), [])
  const controlledMachineId = controlledMachine.id
  const priorControlledMachineIdRef = useRef(controlledMachineId)
  useEffect(() => {
    if (priorControlledMachineIdRef.current !== controlledMachineId) {
      priorControlledMachineIdRef.current = controlledMachineId
      setRequestedMachineId(null)
    }
  }, [controlledMachineId])
  const wantMachineId          = machineId ?? requestedMachineId ?? undefined
  const namedMachine           = useCamStore((s) => wantMachineId === undefined
    ? undefined
    : s.machineLibrary.find((m) => m.id === wantMachineId)
      ?? (s.project.machine.id === wantMachineId ? s.project.machine : undefined))
  const machine                = namedMachine ?? controlledMachine
  /** Apply sends to the machine Control drives (the connected one while a
   *  session holds it). A panel aimed elsewhere by `machineId` (or, WO-1698,
   *  by a pending request naming another machine) must not offer it; the
   *  page's own panel with no request pending always edits that machine, so
   *  this is true there. */
  const editsConnectedMachine  = machine.id === controlledMachine.id
  /** WO-1712: the name to put in the header sentence when this panel is
   *  showing a machine `editsConnectedMachine` says is not the one Control
   *  drives - never a second copy of `controlledMachine`. */
  const connectedMachineName  = controlledMachine.name
  const sessionMachine         = useCamStore((s) => s.control.sessionMachine)
  const appliedMachine         = useCamStore((s) => s.control.appliedMachine)
  const projectMachine         = useCamStore((s) => s.project.machine)
  const updateMachineInLibrary = useCamStore((s) => s.updateMachineInLibrary)
  const setProjectMachine      = useCamStore((s) => s.setProjectMachine)
  const addConsoleEvent        = useCamStore((s) => s.addConsoleEvent)
  // WO-1263: used-only choice. The legacy hook/storage name preserves prefs.
  // WO-1720: its toggle and the per-group "Hide ... catalog" button lived on
  // the Legacy tab's three groups and went with them. The stored choice is
  // still read so `SettingSource` keeps its shape, but no group is ever
  // classified unused any more (`unused` below): a preference nobody can
  // reach must not keep hiding settings the operator cannot bring back.
  const [hideEmpty, setHideEmpty] = useMachineDefHideEmptySettings()

  // WO-967: what the connected bridge said its spindle link IS. Read from the
  // transport's published record rather than from the machine record, because
  // that is where the fact lives: the definition is a file on the bridge
  // machine, and this page is showing it, not storing it. The getServerSnapshot
  // argument is the same function - the record is a module value, so a
  // server-rendered pass and a client pass see the same object rather than the
  // hook throwing for want of one.
  const spindleLink = useSyncExternalStore(
    subscribeVfdPortLink, vfdPortLinkState, vfdPortLinkState,
  )

  // THE RECORD BEING EDITED IS THE CONTROL MACHINE, WITH NO EXCEPTION
  // (WO-1065 attempt 3). This panel used to make one: while Follow CAM was
  // pinned to connected machine A and CAM moved to B, it rendered and edited
  // B's definition under a header naming A, and leaned on an Apply-time
  // refusal to stop B reaching A's controller. That is machine identity split
  // in two on the one page that shows a definition. An operator who wants to
  // edit B disconnects, or edits it from the CAM side (the Machine Library,
  // which never changed). The other doors both name a record outright and
  // both lose Apply (`editsConnectedMachine`) unless that record IS the
  // Control machine: `machineId` (WO-1696, the walkthrough's own prop) and,
  // WO-1698, a pending `machineDefinitionSectionRequest` - the Machine
  // Library's Travel link uses the request because it has no prop path into
  // the Definition page's one always-mounted instance. Neither door ever
  // calls `setControlMachineId`; Control's own selection only ever moves
  // through the Control dropdown, which refuses that switch while connected.
  //
  // Prefer the library
  // entry, which is the persistence carrier; the resolved Control record is
  // the fallback only when the active machine is not in the library. That
  // fallback is CAM's project record, so the existing project mirror carries
  // the edit - still one of the two existing carriers, never a third.
  const source: MachineConfig =
    machineLibrary.find((m) => m.id === machine.id) ?? machine

  const setupKind = setupKindFor(source, connectionKind)
  const connectionPhase = useMachineControl((s) => s.connectionPhase)
  const bridgeHello = useMachineControl((s) => s.bridgeHello)
  // WO-1988: LinuxCNC's own facts (INI, joint letters, live joint positions
  // and homing, its spindle link), read from the connected LinuxCncController
  // - never from `def`, which is the UCCNC-shaped stored record. Gated on the
  // STORE's own live `connectionKind` (never the `connectionKind` prop above,
  // which is only the panel's selected/default setup kind) so a controller is
  // certainly already installed before `getMachineController()` is called -
  // that function installs GRBL when nothing is connected yet, and this must
  // never trigger that as a side effect of a page merely being open. Also
  // gated on `editsConnectedMachine` so a panel aimed at a different machine
  // (`machineId`, a pending section request) never shows live facts under
  // another machine's name.
  const liveConnectionKind = useMachineControl((s) => s.connectionKind)
  // Control's selector can still show its default for one render on remount.
  const bridgeRoute = setupKind === 'bridge'
    && (!editsConnectedMachine || liveConnectionKind === null || liveConnectionKind === 'bridge')
  // AUDIT FIX (2026-09-27): `linuxcncController.status().joints` below is read
  // straight off the mutable controller during render, and nothing subscribed
  // to anything that changes when a status frame arrives - the panel only
  // re-rendered for unrelated reasons, so the joint table froze at whatever it
  // showed on the last such render (a real home cycle kept showing "Homed:
  // no" and the pre-home position). `mpos` and `homed` are the two store
  // fields every connected controller's status frame writes on arrival
  // (machineSession.ts `applyContractStatus`, unconditional on backend), so
  // subscribing to them - the same pattern ControlPage/ProbingPanel/etc. use
  // for their own live DROs - re-renders this hook on every frame and the
  // `.status()` call below then reads the current joint vector, not a stale
  // one. Neither value is read directly; the joint table's own per-joint
  // `position`/`homed` from `status().joints` remains the source of truth
  // (a slaved gantry's two joints behind one letter are not the same as the
  // single aggregate `homed` boolean).
  useMachineControl((s) => s.mpos)
  useMachineControl((s) => s.homed)
  const linuxcncController = editsConnectedMachine && liveConnectionKind === 'gateway'
    ? getMachineController()
    : null
  const linuxcncHello = readLinuxcncHello(linuxcncController)
  const linuxcncJoints: JointReading[] | null = linuxcncController?.status().joints ?? null
  // WO-1988 REVIEW FIX: `hello.vfd` is the bridge protocol's field for the
  // BRIDGE's own Modbus VFD link (BRIDGE-PROTOCOL.md); the LinuxCNC gateway
  // never fills it in - it is a hard-coded `{present: false}` in every hello
  // (gateway.py, and LINUXCNC-GATEWAY-PROTOCOL.md's Pushes section: "No `vfd`
  // push: LinuxCNC owns the spindle"). The fact this page can actually state
  // is `capabilities.ownsSpindle`, which the gateway does report honestly.
  const linuxcncOwnsSpindle = linuxcncController?.capabilities.ownsSpindle === true
  const serialBaud = useCamStore((s) => machineSerialBaud(s.appSettings, source.id))
  const localLink = useUiPrefs((s) => s.machineLinks[source.id])
  const setMachineBridgePort = useUiPrefs((s) => s.setMachineBridgePort)
  const setMachineBridgeLaunchSetting = useUiPrefs((s) => s.setMachineBridgeLaunchSetting)
  const bridgePort = localLink?.bridgePort ?? BRIDGE_DEFAULT_PORT
  const uccnc = bridgeHello?.uccnc as
    | (NonNullable<NonNullable<typeof bridgeHello>['uccnc']> & { board?: number })
    | undefined
  const controllerSetupRef = useRef<HTMLDivElement | null>(null)
  const [controllerSetupHighlighted, setControllerSetupHighlighted] = useState(false)
  const bridgeCapability = bridgeHostCapability()
  const legacyBridgeStatusHost = hasLegacyBridgeStatusHost()
  const [bridgeProcessState, setBridgeProcessState] = useState<BridgePanelState>(
    bridgeCapability === 'unhosted' ? { kind: 'unavailable' } : { kind: 'checking' },
  )
  const detectedInstallRoot = 'status' in bridgeProcessState
    ? bridgeProcessState.status.setup?.installRoot ?? undefined
    : undefined
  const [bridgeAction, setBridgeAction] = useState<'start' | 'restart' | 'stop' | null>(null)
  // React may batch two presses before the disabled state paints. This ref is
  // the synchronous ownership boundary; no lifecycle action is queued behind one.
  const bridgeActionInFlight = useRef(false)
  const mountedRef = useRef(true)
  const bridgeSettingFocusValues = useRef<Record<string, string>>({})

  const noteBridgeSettingChanged = useCallback(() => {
    addConsoleEvent({
      severity: 'info',
      source: 'machine',
      message: controlText('useMachineDefinitionPanel.text011'),
    })
  }, [addConsoleEvent])

  const rememberBridgeSetting = useCallback((
    key: 'installRoot' | 'profile' | 'board' | 'vfdDefinition',
    value: string | number | undefined,
  ) => {
    setMachineBridgeLaunchSetting(source.id, key, value)
  }, [setMachineBridgeLaunchSetting, source.id])

  const rememberPickedPath = useCallback(async (
    key: 'installRoot' | 'vfdDefinition',
    kind: 'install-root' | 'vfd-definition',
  ) => {
    const picked = await chooseMachinePath(kind)
    if (picked === null) return
    rememberBridgeSetting(key, picked)
    noteBridgeSettingChanged()
  }, [noteBridgeSettingChanged, rememberBridgeSetting])

  const bridgeTextFocused = (key: string, value: string): void => {
    bridgeSettingFocusValues.current[key] = value
  }

  const bridgeTextBlurred = (key: string, value: string): void => {
    if (bridgeSettingFocusValues.current[key] !== value) noteBridgeSettingChanged()
    delete bridgeSettingFocusValues.current[key]
  }

  const refreshBridgeProcessState = useCallback(async (): Promise<BridgePanelState> => {
    if (!bridgeRoute) return { kind: 'unavailable' }
    try {
      const next = bridgePanelState(await bridgeProcessStatus(bridgePort))
      if (mountedRef.current) setBridgeProcessState(next)
      return next
    } catch {
      const next = { kind: 'unavailable' } as const
      if (mountedRef.current) setBridgeProcessState(next)
      return next
    }
  }, [bridgePort, bridgeRoute])

  useEffect(() => {
    if (!bridgeRoute) {
      setBridgeProcessState({ kind: 'unavailable' })
      return
    }
    let current = true
    setBridgeProcessState({ kind: 'checking' })
    void bridgeProcessStatus(bridgePort)
      .then((status) => {
        if (!current) return
        setBridgeProcessState(bridgePanelState(status))
      })
      .catch(() => { if (current) setBridgeProcessState({ kind: 'unavailable' }) })
    return () => { current = false }
  }, [bridgeCapability, bridgePort, bridgeRoute])

  useEffect(() => {
    if (!bridgeRoute) return
    const refresh = () => { void refreshBridgeProcessState() }
    window.addEventListener('liencam:bridge-lifecycle', refresh)
    const timer = setupKind === 'bridge'
      ? window.setInterval(refresh, 1_000)
      : null
    return () => {
      window.removeEventListener('liencam:bridge-lifecycle', refresh)
      if (timer !== null) window.clearInterval(timer)
    }
  }, [refreshBridgeProcessState, setupKind, bridgeRoute])

  useEffect(() => {
    if (controllerSetupFocus <= 0) return
    // WO-1720: the controller setup block lives on the Controller area now
    // that the Legacy tab is gone, so the Control rail's gear opens it there.
    setSection('controller')
    controllerSetupRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    setControllerSetupHighlighted(true)
    const timer = window.setTimeout(() => setControllerSetupHighlighted(false), 1600)
    return () => window.clearTimeout(timer)
  }, [controllerSetupFocus])

  const spindleStoredIsStated = Object.prototype.hasOwnProperty.call(
    source, 'spindleLinkDefinition',
  )

  // ---- WO-967 round 2: WHOSE SPINDLE IS THAT? -----------------------------
  //
  // `vfdPortLinkState()` is ONE global snapshot - there is one bridge socket
  // at a time - and the audit found what that costs on this page. The Machine
  // Library's "Use for this project" replaces the project machine while the
  // bridge stays connected, so the page can change to machine B while the
  // published record still holds the document machine A's bridge declared. If
  // B is also a UCCNC machine the section renders normally, and A's COM port,
  // slave address, register map and RPM scale sit under B's name with nothing
  // on screen to say they belong to another inverter.
  //
  // The record now carries the machine its connection was opened for, so the
  // test is one comparison made HERE, where the machine on screen is known.
  // A connection that names no machine (`machineId: null`) matches nothing:
  // "I cannot say whose this is" must not resolve to "it is yours".
  //
  // Only the DECLARATION is scoped. `connected`, `reportedPort`, `busy` and
  // the rest describe the socket itself, which is one socket for this
  // computer however many machines are in the library.
  const spindleLinkIsForeign = spindleLink.connected && spindleLink.machineId !== source.id

  /** The other machine in words a person can act on: its library name when it
   *  is still in the library, its id when it is not, null when the connection
   *  named no machine. */
  const spindleLinkOtherMachine = spindleLink.machineId === null
    ? null
    : machineLibrary.find((m) => m.id === spindleLink.machineId)?.name ?? spindleLink.machineId

  const spindleDefinition = spindleStoredIsStated
    ? source.spindleLinkDefinition
    : (spindleLinkIsForeign ? null : spindleLink.declared)

  /** Text the VFD document rejected, stamped with its machine so a malformed
   * slave address can neither be stored nor appear over another machine. */
  const [pendingVfdEdit, setPendingVfdEdit] = useState<
    { id: string; values: Record<string, string> } | null
  >(null)
  const pendingVfdValues = pendingVfdEdit?.id === source.id ? pendingVfdEdit.values : {}
  const vfdRefusalReported = useRef(new Set<string>())
  // The machine session owns this fact because the bridge call survives this
  // panel unmounting. Event handlers also query it directly to close the
  // same-render window before React has painted the disabled state.
  const vfdApplyInFlight = useSyncExternalStore(
    subscribeMachineSpindleLinkApply,
    () => machineSpindleLinkApplyInFlight(source.id),
    () => machineSpindleLinkApplyInFlight(source.id),
  )
  const waitingForVfdReceipt = (): void => {
    addConsoleEvent({
      severity: 'info', source: 'machine',
      message: controlText('useMachineDefinitionPanel.text012'),
    })
  }

  const clearPendingVfdValue = (machineId: string, key: string): void => {
    setPendingVfdEdit((entry) => {
      if (entry?.id !== machineId) return entry
      const values = { ...entry.values }
      delete values[key]
      return Object.keys(values).length === 0 ? null : { ...entry, values }
    })
  }

  const typeVfdValue = (path: VfdPath, value: string): void => {
    if (machineSpindleLinkApplyInFlight(source.id)) {
      waitingForVfdReceipt()
      return
    }
    const key = vfdPathKey(path)
    setPendingVfdEdit((current) => ({
      id: source.id,
      values: {
        ...(current?.id === source.id ? current.values : {}),
        [key]: value,
      },
    }))
  }

  const commitVfdValue = (path: VfdPath, typed: string): void => {
    if (machineSpindleLinkApplyInFlight(source.id)) {
      waitingForVfdReceipt()
      return
    }
    if (spindleDefinition === null || spindleDefinition === undefined) return
    const current = vfdValueAt(spindleDefinition as VfdDefinition, path)
    const parsed = parseVfdEdit(current, typed)
    const key = vfdPathKey(path)
    if (!parsed.ok) {
      const reportKey = `${source.id}:${key}:${typed}`
      if (!vfdRefusalReported.current.has(reportKey)) {
        vfdRefusalReported.current.add(reportKey)
        addConsoleEvent({
          severity: 'warning', source: 'machine',
          message: controlText('useMachineDefinitionPanel.text013', { value1: String(key), value2: String(typed) }),
        })
      }
      return
    }
    if (Object.is(parsed.value, current)) {
      clearPendingVfdValue(source.id, key)
      return
    }
    const changed = withVfdValue(spindleDefinition as VfdDefinition, path, parsed.value)
    const candidate = {
      ...changed,
      verified: false,
      provenance: { kind: 'edited-here', source: controlText('useMachineDefinitionPanel.text014', { value1: String(source.id) }) },
    } as MachineSpindleLinkDefinition
    // WO-2009: checked as it will be SENT - a saved link that names a shipped
    // template has its missing run-state rows filled by the apply below, which
    // says so once. Only a link nothing can fill is refused here, naming them.
    const validation = validateVfdDefinition(completeVfdRunStateValues(
      candidate as unknown as VfdDefinition,
      VFD_MODEL_TEMPLATES.map((template) => template.definition),
    ).definition)
    if (!validation.ok) {
      const reason = validation.errors.map((fault) => `${fault.path}: ${fault.sentence}`).join(' ')
      const reportKey = `${source.id}:${key}:${typed}:${reason}`
      if (!vfdRefusalReported.current.has(reportKey)) {
        vfdRefusalReported.current.add(reportKey)
        addConsoleEvent({
          severity: 'warning', source: 'machine',
          message: controlText('useMachineDefinitionPanel.text015', { value1: String(key), value2: String(reason) }),
        })
      }
      return
    }

    const waitsForMatchingBridge = spindleLink.connected
      && spindleLink.machineId === source.id
      && spindleLink.spindleRunning !== true
    if (waitsForMatchingBridge) waitingForVfdReceipt()

    void applyMachineSpindleLinkDefinition(source.id, candidate)
      .then((outcome) => {
        if (!outcome.stored) {
          // A bridge refusal, timeout, or disconnect settles the accepted edit
          // without changing the stored authority. Drop its text so the next
          // candidate is built from that stored document, never the refused one.
          if (waitsForMatchingBridge) clearPendingVfdValue(source.id, key)
          return
        }
        // The typed value stays pending through stopped-state confirmation.
        // Clear it only after the accepted local/bridge store so the stored or
        // bridge-confirmed value becomes visible without an optimistic gap.
        clearPendingVfdValue(source.id, key)
        addConsoleEvent({
          severity: 'info', source: 'machine',
          message: controlText('useMachineDefinitionPanel.text016', { value1: String(key) }),
        })
      })
      .catch((error) => {
        if (waitsForMatchingBridge) clearPendingVfdValue(source.id, key)
        addConsoleEvent({
          severity: 'warning', source: 'machine',
          message: controlText('useMachineDefinitionPanel.text017', { value1: String(error instanceof Error ? error.message : String(error)) }),
        })
      })
  }

  const commitVfdDirection = (inverted: boolean): void => {
    if (machineSpindleLinkApplyInFlight(source.id)) {
      waitingForVfdReceipt()
      return
    }
    if (spindleDefinition === null || spindleDefinition === undefined) return
    if (
      'directionInverted' in spindleDefinition
      && spindleDefinition.directionInverted === inverted
    ) return
    const candidate: MachineSpindleLinkDefinition = {
      ...spindleDefinition,
      directionInverted: inverted,
      directionInvertedProvenance: {
        kind: 'operator',
        source: controlText('useMachineDefinitionPanel.text018', { value1: String(source.id) }),
      },
    }
    void applyMachineSpindleLinkDefinition(source.id, candidate)
      .then((outcome) => {
        if (!outcome.stored) return
        addConsoleEvent({
          severity: 'info', source: 'machine',
          message: inverted
            ? controlText('useMachineDefinitionPanel.text019')
            : controlText('useMachineDefinitionPanel.text020'),
        })
      })
      .catch((error) => addConsoleEvent({
        severity: 'warning', source: 'machine',
        message: controlText('useMachineDefinitionPanel.text021', { value1: String(error instanceof Error ? error.message : String(error)) }),
      }))
  }

  const vfdEdit: VfdEditContext = {
    pending: pendingVfdValues,
    disabled: vfdApplyInFlight,
    onType: typeVfdValue,
    onCommit: commitVfdValue,
    onDirectionChange: commitVfdDirection,
  }

  // THE UNSAVED EDIT, AND THE MACHINE IT BELONGS TO. Held as one value rather
  // than as a draft copy kept in step by effects, and that is what makes three
  // behaviours fall out instead of being maintained:
  //   - while clean, `draft` IS the record, so a Save made elsewhere or a
  //     rehydrate shows here immediately with nothing to synchronise;
  //   - while dirty, a background write cannot silently discard what is being
  //     typed;
  //   - switching machines abandons the unsaved edit rather than carrying it
  //     onto the new one, because the edit names the machine it was made on.
  //     An edit that lands on a machine the person is no longer looking at is
  //     a machine fact nobody chose.
  // WO-2102: `base` is the record the edit started from, so Save can tell a
  // field the draft changed from one written to the record behind it.
  const [edit, setEdit] = useState<{ id: string; base: MachineConfig; draft: MachineConfig } | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)

  // ---- WO-941 (WO-928's control, moved): the Apply state ------------------
  // NO OPTIMISTIC STATE. `applying` is set before the call and `applyState` is
  // written ONLY from the settled reply - there is no code path that reports a
  // result the controller has not yet given. `applyState.sig` records WHICH
  // definition that answer was about, so an edit made afterwards drops the
  // control back to neutral instead of leaving "Applied" standing over a
  // definition the board has never seen.
  const [applying, setApplying] = useState(false)
  const [applyState, setApplyState] =
    useState<{ sig: string; ok: boolean; lines: ApplyReportLine[] } | null>(null)

  // An apply is awaited and this page can be navigated away from while it is
  // in flight (nothing here may trap the operator). Guard the late setState.
  // Set on the way IN as well as cleared on the way out: React's development
  // StrictMode mounts, unmounts and remounts, and a ref only cleared in the
  // cleanup stays false forever after that - which left the modal's Apply
  // control stuck reading "Applying..." in the real app while the tests (no
  // StrictMode) passed.
  /** WO-1687 - WHICH OF THE SEVEN AREAS IS ON SCREEN. WO-1720 deleted the
   *  temporary Legacy door this used to open on (Operator ruling 2026-09-19: "No
   *  legacy, and all means ALL"): every area has its body and All settings
   *  carries every field Legacy drew, so the page opens on the first tab. */
  const [section, setSection] = useState<DefGroup>('overview')

  /** WO-1698: land on whatever section something outside this page asked for
   *  (the Machine Library modal's disabled Travel row is the first caller -
   *  see machineDefinitionSectionRequest.ts). Checked directly on mount/
   *  machine-switch (`source.id` changing covers "just arrived"), and again
   *  on the request event (covers "already open on another section" -
   *  `source.id` does not change then, so the dependency alone would miss
   *  it). */
  useEffect(() => {
    const consume = () => {
      const requested = consumeMachineDefinitionSection(source.id)
      if (requested !== null) setSection(requested)
    }
    consume()
    return subscribeMachineDefinitionSectionRequests(consume)
  }, [source.id])

  /** WO-1687 - THE BAR'S "Find any setting" TEXT, lifted here rather than
   *  kept local to the bar because T6 (WO-1689, All settings) filters by it
   *  too - the same box, not a second one. WO-1689: now read by
   *  `AllSettingsTable`, which is the only tab that filters by it - so typing
   *  here while looking at any other tab lands on All settings, the way the
   *  outcome names it ("the bar's search box lands here from any tab").
   *  Landing only, never un-landing: clearing the box does not navigate away,
   *  because a person who typed a search and then cleared it to read the rest
   *  of the table is still looking at the table. */
  const [settingSearch, setSettingSearch] = useState('')

  useEffect(() => {
    if (settingSearch.trim() === '') return
    setSection((current) => (current === 'allSettings' ? current : 'allSettings'))
  }, [settingSearch])

  /** WHAT IS IN THE SKEW BOX AS TYPED - the one part of this page holding text
   *  that is not yet in the record (WO-996) - and it is held HERE rather than
   *  inside the field because WO-1050 put the field on an axis row inside a
   *  tab. State owned by the field would be destroyed by a tab click. The panel
   *  outlives every tab, and it is the panel that owns Save and Revert, which
   *  have to know a refusal is still on screen after a Save.
   *
   *  `null` means nobody has typed since the panel opened on this machine, and
   *  then the box shows the record. It is cleared by Revert and by a machine
   *  switch: a half-typed measurement is about the gantry it was typed on, and
   *  does not follow the person to the next one. */
  const [skewTyped, setSkewTyped] = useState<string | null>(null)
  /** Half-typed GRBL text in All settings has the same ownership boundary as
   *  the skew box: it is not in the record yet, so the panel that owns Revert
   *  must own and discard it. */
  const [allSettingsTyped, setAllSettingsTyped] = useState<GrblSettingsRecord>({})
  useEffect(() => {
    setEdit(null)
    setSkewTyped(null)
    setAllSettingsTyped({})
  }, [source.id])

  /** SETTING BOXES HOLD WHAT WAS TYPED; the record holds what parsed. Same
   *  reason as `skewRefused` one line up, for the other 1489 fields - see
   *  `PendingSettings`. Keyed by the controller's own name for the setting.
   *
   *  AND IT NAMES THE RECORD IT WAS TYPED ON, exactly as `edit` above does and
   *  for the same reason (audit 2026-08-27, round 4). Held as a bare map, this
   *  was the one piece of state this panel kept that belonged to no machine:
   *  text the record REFUSED stayed on screen across a machine switch, sat in
   *  a box over the OTHER machine's value, and a Save there would have written
   *  it. The class the round-4 fix closes is exactly that - state this panel
   *  holds outside the definition is only safe while it says whose it is.
   *
   *  The stamp is the machine id AND the record's definition object, so a
   *  definition REPLACED under the panel (a re-import) drops the pending text
   *  too. Typing cannot trip it: an edit in progress lives on `edit.draft`,
   *  never on `source`, so `source.controllerDefinition` is stable under a
   *  keystroke and changes only when something outside this form rewrites the
   *  record. */
  const [pendingEdit, setPendingEdit] = useState<
    { id: string; definition: ControllerDefinition | undefined; values: PendingSettings } | null
  >(null)
  const pendingOwned = (
    p: { id: string; definition: ControllerDefinition | undefined } | null,
  ): boolean => p !== null && p.id === source.id && p.definition === source.controllerDefinition
  const pendingSettings: PendingSettings = pendingOwned(pendingEdit) && pendingEdit
    ? pendingEdit.values
    : {}
  const setPendingSettings = (next: (p: PendingSettings) => PendingSettings): void => {
    setPendingEdit((p) => ({
      id: source.id,
      definition: source.controllerDefinition,
      values: next(pendingOwned(p) && p ? p.values : {}),
    }))
  }

  /** THE EMPTY BOX SOMEBODY JUST REACHED FOR, or null. Held as state and
   *  turned into a console line by an effect rather than logged from the focus
   *  handler, because "say it once per key" needs a memory of what has been
   *  said, and a memory read during render is not a thing a render may do. */
  const [absentTouched, setAbsentTouched] = useState<string | null>(null)
  const absentReported = useRef(new Set<string>())

  /** THE KEY THE STORE JUST REFUSED, or null. Held and reported by an effect
   *  for the same reason `absentTouched` is: the write happens in an event
   *  handler and the console line has to be said once per key, which needs a
   *  memory that a render may not read. */
  const [refusedSetting, setRefusedSetting] = useState<{ key: string; reason: string } | null>(null)
  const refusedReported = useRef(new Set<string>())
  /** WO-967 round 2: which (bridge machine -> machine on screen) pairs have
   *  already been explained on this mount. */
  const foreignLinkReported = useRef(new Set<string>())

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const resumeBridgeConnect = (): void => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="control-connect"]')
    if (button === null || button.disabled) return
    button.click()
  }

  const handleBridgeAction = useCallback(async (
    action: 'start' | 'restart' | 'stop',
    resumeConnect = false,
  ): Promise<void> => {
    if (!bridgeRoute) return
    if (bridgeActionInFlight.current) return
    bridgeActionInFlight.current = true
    setBridgeAction(action)
    if (action === 'restart' && bridgeCapability === 'hosted') {
      addConsoleEvent({ severity: 'info', source: 'machine', message: controlText('useMachineDefinitionPanel.text022') })
    }
    const restartReason = bridgeProcessState.kind === 'failing'
      ? bridgeProcessState.reason.replace(/[.]$/, '')
      : controlText('useMachineDefinitionPanel.text023')
    try {
      if (action === 'stop') {
        const result = await stopBridge(bridgePort)
        if (result.ok) {
          addConsoleEvent({ severity: 'success', source: 'machine', message: controlText('useMachineDefinitionPanel.text024') })
        } else {
          addConsoleEvent({
            severity: 'error', source: 'machine',
            message: result.reason === 'stop-timeout'
              ? controlText('useMachineDefinitionPanel.text025')
              : controlText('useMachineDefinitionPanel.text026'),
          })
        }
        await refreshBridgeProcessState()
        return
      }

      const result = action === 'start'
        ? await startBridge(bridgePort, localLink, { operatorPress: true })   // WO-2845
        : await restartBridge(bridgePort, localLink, { operatorPress: true })
      if (result.ok) {
        addConsoleEvent({
          severity: 'success', source: 'machine',
          message: action === 'start'
            ? controlText('useMachineDefinitionPanel.text027', { value1: String(result.pid), value2: String(result.port) })
            : bridgeCapability === 'hosted'
              ? controlText('useMachineDefinitionPanel.text028')
                + controlText('useMachineDefinitionPanel.text029')
              : controlText('useMachineDefinitionPanel.text030', { value1: String(restartReason) }),
        })
        await refreshBridgeProcessState()
        if (resumeConnect || action === 'restart') resumeBridgeConnect()
      } else if (result.reason === 'exited') {
        setBridgeProcessState({
          kind: 'failing',
          status: {
            configured: true, running: false, pid: null, lastExit: result.lastExit,
            respawn: { attempts: 0, gaveUp: false, lastAttemptAt: null },
          },
          reason: controlText('useMachineDefinitionPanel.text031'),
        })
        addConsoleEvent({
          severity: 'error', source: 'machine',
          message: controlText('useMachineDefinitionPanel.text032'),
        })
      } else if (result.reason === 'no-socket') {
        addConsoleEvent({
          severity: 'error', source: 'machine',
          message: controlText('useMachineDefinitionPanel.text033', { value1: String(result.port) }),
        })
      } else if (result.reason === 'not-configured') {
        setBridgeProcessState({
          kind: 'not-configured',
          status: {
            configured: false, running: false, pid: null, lastExit: null,
            respawn: { attempts: 0, gaveUp: false, lastAttemptAt: null },
          },
        })
        addConsoleEvent({
          severity: 'error', source: 'machine',
          message: controlText('useMachineDefinitionPanel.text034'),
        })
      } else {
        addConsoleEvent({
          severity: 'error', source: 'machine',
          message: controlText('useMachineDefinitionPanel.text035'),
        })
      }
    } catch {
      addConsoleEvent({
        severity: 'error', source: 'machine',
        message: controlText('useMachineDefinitionPanel.text036'),
      })
    } finally {
      bridgeActionInFlight.current = false
      if (mountedRef.current) setBridgeAction(null)
    }
  }, [addConsoleEvent, bridgeCapability, bridgePort, bridgeProcessState, localLink, refreshBridgeProcessState, bridgeRoute])

  /** ONE CONSOLE LINE PER ABSENT KEY SOMEBODY TOUCHED. The page cannot carry
   *  1489 explanatory sentences and Operator's rule for it tonight was that
   *  nothing new pushes the layout around, so the explanation goes where this
   *  app already puts explanations. Said once: a person tabbing through a
   *  table of empty boxes would otherwise fill the console with one machine
   *  fact repeated. */
  useEffect(() => {
    if (absentTouched === null) return
    if (absentReported.current.has(absentTouched)) return
    absentReported.current.add(absentTouched)
    addConsoleEvent({
      severity: 'info', source: 'machine',
      message: controlText('useMachineDefinitionPanel.text037', { value1: String(absentTouched) })
        + controlText('useMachineDefinitionPanel.text038'),
    })
  }, [absentTouched, addConsoleEvent])

  /** ONE CONSOLE LINE WHEN THE CONNECTED BRIDGE IS ANOTHER MACHINE'S.
   *
   *  The section already says so where a person is looking, but the reason a
   *  page went from showing a register map to showing a sentence belongs in
   *  the place this app puts explanations - otherwise switching machines looks
   *  like the spindle definition was lost. Said once per pair, so flipping
   *  back and forth between two machines does not fill the console with one
   *  fact repeated. */
  useEffect(() => {
    if (!spindleLinkIsForeign) return
    const pair = `${spindleLink.machineId ?? ''}->${source.id}`
    if (foreignLinkReported.current.has(pair)) return
    foreignLinkReported.current.add(pair)
    addConsoleEvent({
      severity: 'info', source: 'machine',
      message: controlText('useMachineDefinitionPanel.text039')
        + controlText('useMachineDefinitionPanel.text041', { value1: String(spindleLinkOtherMachine ?? controlText('useMachineDefinitionPanel.text040')), value2: String(source.name) })
        + controlText('useMachineDefinitionPanel.text042')
        + controlText('useMachineDefinitionPanel.text043'),
    })
  }, [
    spindleLinkIsForeign, spindleLink.machineId, spindleLinkOtherMachine,
    source.id, source.name, addConsoleEvent,
  ])

  /** ONE CONSOLE LINE PER KEY THE STORE REFUSED. A warning, not information:
   *  something asked this machine to hold a setting from another controller's
   *  vocabulary and it did not happen. */
  useEffect(() => {
    if (refusedSetting === null) return
    if (refusedReported.current.has(refusedSetting.key)) return
    refusedReported.current.add(refusedSetting.key)
    addConsoleEvent({ severity: 'warning', source: 'machine', message: refusedSetting.reason })
  }, [refusedSetting, addConsoleEvent])

  /** PENDING TEXT IS DROPPED, NOT CARRIED, and the drop is said once.
   *
   *  `pendingSettings` above already renders nothing for a record the text was
   *  not typed on, so the leak itself is closed in the READ - this clears the
   *  memory of it so a switch back does not resurrect a typo, and says one
   *  line, because text that silently disappears is the other half of the same
   *  defect. One line for the whole drop, not one per key: a person who tabbed
   *  through a table leaving half-typed numbers behind must not have the
   *  console buried under them. */
  useEffect(() => {
    if (pendingEdit === null || pendingOwned(pendingEdit)) return
    const dropped = Object.keys(pendingEdit.values).length
    setPendingEdit(null)
    if (dropped === 0) return
    addConsoleEvent({
      severity: 'info', source: 'machine',
      message: droppedTypedValuesMessage(dropped),
    })
    // `pendingOwned` closes over this render's `source`; the two fields it
    // reads are the dependencies, and naming them is what makes the effect run
    // on a machine switch rather than on every keystroke's new map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEdit, source.id, source.controllerDefinition, addConsoleEvent])

  // THE RECORD-LEVEL EDIT, and it is what decides WHICH record is rendered.
  const editing = edit !== null && edit.id === source.id
  const draft: MachineConfig = editing && edit ? edit.draft : source

  /** Whether the skew box currently holds something the record cannot take.
   *  DERIVED from the same two inputs the field renders from, through the same
   *  `readSkewBox`, so the panel can never believe something the field is not
   *  showing - which is what the old report-it-upwards callback could do. */
  const skewRefused =
    readSkewBox(skewTyped ?? (machineSkew(draft) ? String(machineSkew(draft)!.offsetMm) : ''))
      .kind === 'refused'

  /** DIRTY MEANS "THE FORM HOLDS SOMETHING THE RECORD DOES NOT", and a refused
   *  skew box is exactly that even after a Save. `commit` writes the record and
   *  clears the edit, but it cannot make `abc` into a measurement and it does
   *  not empty the box - so without this, Save left a rejected value on screen
   *  under its own refusal while the header read `Saved`, the tooltip read `No
   *  unsaved changes` and Revert - the one press that takes the typo back off -
   *  was greyed out. That is the state the identity edit at `write` exists to
   *  prevent, and a Save must not be able to walk back into it.
   *
   *  AND SO IS EVERY SETTING BOX HOLDING TEXT THE RECORD REFUSED - the same
   *  sentence, for the other 1489 fields (audit 2026-08-27, round 4). A value
   *  that PARSED already makes this true through `editing`, because writing it
   *  went through `editDraft`; a value that did not parse wrote nothing, so
   *  without this line a panel visibly holding `not a number` reported clean,
   *  Revert was greyed out, and the unsaved-changes guard saw nothing to warn
   *  about. Any pending entry counts, not only the refused ones: `pending` is
   *  by definition text the record has not taken verbatim. */
  const dirty = editing || skewRefused || Object.keys(pendingSettings).length > 0
    || Object.keys(allSettingsTyped).length > 0
  const saved = savedId === source.id && !dirty

  /** EVERY edit funnels through here, so there is exactly one way a change is
   *  recorded and exactly one place it can be saved from. */
  const editDraft = (mut: (m: MachineConfig) => MachineConfig) => {
    setEdit((e) => (e && e.id === source.id
      ? { ...e, draft: mut(e.draft) }
      : { id: source.id, base: source, draft: mut(source) }))
    setSavedId(null)
  }

  const def = draft.controllerDefinition

  /** THE SLAVED AXIS: the axis NAMED as another axis's slave, which is the one
   *  a gantry skew is measured about. On Operator's machine Y carries
   *  `slaveAxis: 'A'`, so the skew belongs on A's row - which is where his own
   *  instruction puts it ("a small value next to the axis which is slaved").
   *
   *  `null` when this machine declares no pairing, or names one whose axis the
   *  record does not carry. Either way there is no row to sit on and the field
   *  renders standalone below the table instead - a measurement somebody made
   *  must not become unreachable because a select was set back to None. */
  const slavedAxis: AxisName | null = (() => {
    const named = def?.axes.find((a) => a.slaveAxis !== null)?.slaveAxis ?? null
    return named !== null && def!.axes.some((a) => a.axis === named) ? named : null
  })()

  /** Said in the machine console, once per key, when somebody reaches for a
   *  field the profile never stated. Defined here rather than inline because
   *  it is the one place the once-only ref is touched, and it is touched from
   *  a focus handler - never while rendering. */
  const reportAbsentSetting = (key: string): void => { setAbsentTouched(key) }

  /** Said in the machine console when the STORE would not take a key on this
   *  machine. Same shape and the same reason as `reportAbsentSetting`: the
   *  refusal is a fact about the machine, and a write that goes nowhere
   *  without saying so is the silent store the round-6 fix exists to prevent. */
  const reportRefusedSetting = (key: string, reason: string): void => {
    setRefusedSetting({ key, reason })
  }

  /** WHERE EVERY `.pro` FIELD ON THIS PAGE READS AND WRITES (WO-1039).
   *
   *  Read off `draft.controllerDefinition`, not `source`, so an unsaved edit
   *  shows what the form holds rather than what the record holds - it is the
   *  same rule the axis and pin boxes above follow, and these are boxes now.
   *
   *  The name is `unsent` because ~90 call sites below say `settings={unsent}`
   *  and the swap that mattered was the DATA PATH, not the identifier: the
   *  values on screen are the same values, taken from the typed model instead
   *  of from its text twin. Renaming it is a second diff and belongs in one.
   */
  const unsent = createSettingSource({
    definition: draft.controllerDefinition ?? null,
    unsent: draft.unsentSettings,
    controller: draft.controller,
    // THE MACHINE'S CONTROLLER AND THE CATALOGUE'S ARE TWO FACTS, and this line
    // is where they used to be silently treated as one (audit round 6). A GRBL
    // machine paired with the UCCNC catalogue was offered 1489 keys it does not
    // have. Now the source knows whose vocabulary it holds and says so.
    catalogue: UCCNC_CATALOGUE_CONTROLLER,
    field: uccncSettingField,
    patch: (mut) => { patchDefinition(mut) },
    pending: pendingSettings,
    setPending: setPendingSettings,
    reportAbsent: reportAbsentSetting,
    reportRefused: reportRefusedSetting,
    // THE RECORD, NOT THE DRAFT. `patch`, `setPending` and `reportAbsent` all
    // close over `source`, and it is the only thing about them that can go
    // stale behind the memo - so it is what the comparator is given. The draft
    // would change on every keystroke and defeat the memo entirely; the record
    // changes exactly when the panel is looking at a different machine fact.
    owner: source,
    // WO-1263: the operator's used-only choice, persisted per operator.
    hideEmpty,
    // WO-1720: the operator's explicit group choice was made on the Legacy
    // tab's three groups, which are gone; nothing here infers one either - a
    // `.pro` has values but no provenance.
    unused: () => false,
  })

  /** The panel body, for the controller-setup scroll target and the tests
   *  that measure what the page drew. */
  const panelBodyRef = useRef<HTMLDivElement | null>(null)

  /** HOW MANY BOXES ARE HOLDING SOMETHING THIS MACHINE WOULD NOT TAKE. Counted
   *  for the legend on every tab, because a refusal a person has scrolled past
   *  is still a refusal and `dirty` alone only greys a button back in. Refused
   *  entries only: pending text that PARSED is on the draft and is reported by
   *  the Save control like any other edit. */
  const notAcceptedCount = Object.keys(pendingSettings)
    .filter((key) => unsent.invalid(key)).length

  const patchDefinition = (mut: (d: ControllerDefinition) => ControllerDefinition) => {
    editDraft((m) => (m.controllerDefinition
      ? { ...m, controllerDefinition: mut(m.controllerDefinition) }
      : m))
  }

  /** A machine has no definition until someone asks for one: absence means
   *  "not defined for this controller", never "defaults are fine". All six
   *  axes are listed so a gantry's slave needs no separate add step; A/B/C
   *  arrive switched off and every pin arrives UNASSIGNED, because a guessed
   *  pin that happens to be wired to something is worse than none. */
  const defineController = () => {
    editDraft((m) => {
      // WO-2275: the library already owns this travel. Read its home end
      // before creating a definition, then copy only the known limit pairs
      // into the draft through the same writer as the library's travel lens.
      const travel = machineTravel(m)
      const home = machineHomeConvention(m)
      let definition = createDefaultControllerDefinition(AXIS_NAMES)
      for (const [key, axis] of [['x', 'X'], ['y', 'Y'], ['z', 'Z']] as const) {
        const range = signedAxisRange(key, home?.[key]
          ?? { homesToward: 'max', machineZeroAt: 'max' }, travel[key])
        if (!range) continue
        definition = withAxisTravelEdited(
          { ...m, controllerDefinition: definition }, axis, range.min, range.max,
        )!
      }
      return { ...m, controllerDefinition: definition }
    })
  }

  const patchAxis = (axis: AxisName, updates: Partial<AxisDefinition>) => {
    patchDefinition((d) => ({
      ...d,
      axes: d.axes.map((a) => (a.axis === axis ? { ...a, ...updates } : a)),
    }))
  }

  /** WO-1705: travel is ONE stored field with two lenses, so this writes
   *  through the shared `axisSoftLimitEdit.ts` path the Machine Library
   *  modal's Travel field uses too. A ONE-END edit: the homing value is left
   *  exactly as typed - pulling a soft limit inside the switch is routine and
   *  never moves the switch. */
  const patchAxisSoftLimit = (axis: AxisName, end: 'min' | 'max', value: number) => {
    editDraft((m) => (m.controllerDefinition
      ? { ...m, controllerDefinition: withAxisSoftLimitEdited(m, axis, end, value) }
      : m))
  }

  /** A `.pro` carries a section only for the axes the machine has, so a
   *  four-axis record genuinely does not hold B or C. The panel says so rather
   *  than drawing a blank axis, and adding one takes an explicit press - which
   *  is the only way a new axis can appear without this surface inventing a
   *  machine fact. It arrives with every pin UNASSIGNED. */
  const addAxis = (axis: AxisName) => {
    patchDefinition((d) => {
      if (d.axes.some((a) => a.axis === axis)) return d
      const added = createDefaultAxisDefinition(axis)
      return {
        ...d,
        axes: [...d.axes, added].sort(
          (p, q) => AXIS_NAMES.indexOf(p.axis) - AXIS_NAMES.indexOf(q.axis),
        ),
        homing: added.enabled
          ? { ...d.homing, order: insertIntoHomingOrder(d.homing.order, axis) }
          : d.homing,
      }
    })
  }

  /** Both pin writers go through `claimPinPolarity`, which is what moves a
   *  released polarity onto the triple the moment the wire exists. Writing
   *  `axes`/`io` and nothing else is how an assigned pin ended up with two
   *  polarity editors, one of which the export ignored (audit 2026-08-27). */
  const patchAxisPin = (axis: AxisName, field: keyof AxisDefinition, value: PinRef) => {
    patchDefinition((d) => withDefinitionAxisPinEdited(
      d, draft.controller, axis, field, value,
    ))
  }

  const patchIoPin = (field: 'estop' | 'probe' | 'probe2', value: PinRef) => {
    patchDefinition((d) => {
      const claimed = claimPinPolarity(d, `io.${field}`, value)
      return { ...claimed.definition, io: { ...claimed.definition.io, [field]: claimed.pin } }
    })
  }

  /** The key of the generic box that currently owns a pin's polarity, or
   *  `undefined` when the triple owns it. Asked of `SettingSource` so there is
   *  still exactly ONE ownership rule on this page - the same call `SettingBox`
   *  makes before it draws anything. */
  const polarityBoxFor = (owner: string): string | undefined => {
    const key = pinPolarityKey(owner)
    return key === undefined || unsent.ownedElsewhere(key) ? undefined : key
  }

  const toggleAxisEnabled = (axis: AxisName, enabled: boolean) => {
    patchDefinition((d) => ({
      ...d,
      axes: d.axes.map((a) => (a.axis === axis ? { ...a, enabled } : a)),
      homing: {
        ...d.homing,
        order: enabled
          ? insertIntoHomingOrder(d.homing.order, axis)
          : d.homing.order.filter((a) => a !== axis),
      },
    }))
  }

  /** Picking an axis for a position SWAPS it with wherever it sits now, so the
   *  order stays a permutation and no axis is silently dropped from the cycle. */
  const setHomingOrderAt = (index: number, axis: AxisName) => {
    patchDefinition((d) => {
      const order = [...d.homing.order]
      const from = order.indexOf(axis)
      if (from === index) return d
      if (from >= 0) order[from] = order[index]
      order[index] = axis
      return { ...d, homing: { ...d.homing, order } }
    })
  }

  /** Patches an EXISTING homing block only. A missing one is not conjured on
   *  the way past - see `defineHoming`. */
  const patchHoming = (axis: AxisName, updates: Partial<AxisHomingDefinition>) => {
    patchDefinition((d) => withDefinitionAxisHomingEdited(
      d, draft.controller, axis, updates,
    ))
  }

  /** The ONE place a homing block is created from defaults, and it takes an
   *  explicit press to reach. The numbers it writes then belong to the record
   *  and are visibly editable, instead of being defaults rendered as if they
   *  were the machine's own. */
  const defineHoming = (axis: AxisName) => {
    patchDefinition((d) => {
      if (d.homing.perAxis[axis]) return d
      const axisDef = d.axes.find((a) => a.axis === axis)
      return {
        ...d,
        homing: {
          ...d.homing,
          perAxis: {
            ...d.homing.perAxis,
            [axis]: createDefaultAxisHomingDefinition(axis, axisDef?.maxVelocity),
          },
        },
      }
    })
  }

  /** THE SAVE, and it is the modal's save. Same two store actions, same order,
   *  same write-through to the active-machine mirror, same "saved as typed with
   *  its problems reported into the machine console" behaviour. Anything else
   *  would be a second persistence path. */
  const commit = (): MachineConfig => {
    const problems = draft.controllerDefinition
      ? validateControllerDefinition(draft.controllerDefinition)
      : []
    if (problems.length > 0) {
      addConsoleEvent({
        severity: 'warning', source: 'machine',
        message: controlText('useMachineDefinitionPanel.text044', { value1: String(draft.name) })
          + controlText('useMachineDefinitionPanel.text045', { value1: String(problems.length), value2: String(problems.length === 1 ? '' : 's') })
          + problems.join(' '),
      })
    }
    // TAKING A KEY BACK OFF, which this panel can now do for the first time
    // (WO-996's cleared skew) and which the two carriers disagree about by
    // default: `updateMachineInLibrary` MERGES (`{ ...m, ...updates }`), so a
    // key the draft NO LONGER HAS survives in the library entry, while
    // `setProjectMachine` replaces the mirror wholesale and drops it. That is
    // the two-carriers-disagree drift WO-928 exists to have reconciled, so the
    // SAME record goes to both: naming the key as `undefined` overwrites it in
    // the merge, `machineSkew` reads absent and undefined alike, and the
    // persist path drops an undefined so a reload carries no key at all.
    //
    // Named ONLY when a key is actually being cleared - a machine nobody ever
    // measured must not come out of a save carrying the word "skew".
    const clearingSkew = 'skew' in source && !('skew' in draft)
    const controllerDefinition = withMachineDefinitionProfileBaseline(
      source.controllerDefinition,
      draft.controllerDefinition,
    )
    const record: MachineConfig = clearingSkew
      ? { ...draft, controllerDefinition, skew: undefined }
      : { ...draft, controllerDefinition }
    // Spindle-link edits deliberately bypass this panel's ordinary draft: the
    // bridge receipt becomes the machine record immediately. A draft opened
    // before that receipt therefore holds an older document and must not take
    // authority back when Save persists unrelated definition fields. Preserve
    // both the live value and whether the machine has stated this key at all.
    if (Object.prototype.hasOwnProperty.call(source, 'spindleLinkDefinition')) {
      record.spindleLinkDefinition = source.spindleLinkDefinition
    } else {
      delete record.spindleLinkDefinition
    }
    // WO-2102: Built-in commands and its macro editor write the record at once
    // (machineActionsStore / MacroEditor), not through this draft. A draft the
    // operator opened before such a write still holds the older value; when the
    // draft never changed that field itself, Save keeps what the record now
    // says instead of quietly undoing his command or macro edit.
    if (editing && edit) {
      if (draft.actionOverrides === edit.base.actionOverrides) {
        if (Object.prototype.hasOwnProperty.call(source, 'actionOverrides')) record.actionOverrides = source.actionOverrides
        else delete record.actionOverrides
      }
      if (draft.macros === edit.base.macros) {
        if (Object.prototype.hasOwnProperty.call(source, 'macros')) record.macros = source.macros
        else delete record.macros
      }
    }
    updateMachineInLibrary(record.id, record)
    // WO-928 / F17 - preserve CAM's separate project copy only when this is
    // also CAM's selected record. A distinct Control pick stays independent.
    if (record.id === projectMachine.id) setProjectMachine(record)
    setEdit(null)
    setSavedId(draft.id)
    // The setting boxes ARE cleared: unlike the skew box, a pending setting
    // that parsed is already in the record this line just wrote, and one that
    // did not parse has nothing to keep - re-reading from the record shows the
    // machine exactly what it now says.
    setPendingEdit(null)
    // `skewTyped` IS DELIBERATELY NOT CLEARED HERE. A Save writes the record;
    // it does not empty the skew box and it cannot turn `abc` into a
    // measurement. While that text is still on screen there is still something
    // the record does not hold, so the form stays dirty: no `Saved`, no `No
    // unsaved changes`, and Revert stays live to take it off. Clearing it here
    // would restore the exact defect this line is written against.
    //
    // WO-1703: hand back the record AS STORED, not as typed. The store's one
    // write door (`adoptMachineDocument`) restates the relay settings from the
    // Outputs list, and Apply sends this return value - so the board is sent
    // exactly what the library now holds, never the pre-adoption draft.
    const stored = useCamStore.getState()
    return stored.machineLibrary.find((m) => m.id === record.id)
      ?? (stored.project.machine.id === record.id ? stored.project.machine : record)
  }

  const revert = () => {
    setEdit(null)
    setSavedId(null)
    setPendingEdit(null)
    // The skew box holds text that is NOT in the record until it is a usable
    // distance (WO-996/WO-1015), so discarding the edit has to discard it too -
    // otherwise a reverted panel still shows a typo over a record that never
    // took it. One press, one clear: the typed text is the panel's own now
    // (WO-1050), so taking it off no longer depends on remounting anything.
    setSkewTyped(null)
    setAllSettingsTyped({})
  }

  // ---- WO-941: APPLY - the one hardware verb, on the one surface ----------

  /** The result goes to surfaces that already exist: the machine console (the
   *  same one this panel writes its save complaints to) and the Apply
   *  control's own hover context. No banner, no new element, and nothing on
   *  the form moves when it appears.
   *
   *  The controller's report is written line by line, VERBATIM, at the
   *  severity the controller gave it. A 23-field readback mismatch is the
   *  whole reason the readback exists and is never collapsed into "failed". */
  const reportApply = (machine: MachineConfig, ok: boolean, lines: ApplyReportLine[]) => {
    for (const line of lines) {
      addConsoleEvent({
        severity: line.severity === 'warn' ? 'warning' : line.severity,
        source: 'machine',
        message: line.text,
      })
    }
    if (!mountedRef.current) return
    const sig = definitionSignature(machine)
    if (sig !== null) setApplyState({ sig, ok, lines })
  }

  /**
   * Send the ACTIVE machine's definition to the controller. This is WO-928's
   * handler moved whole, not a second implementation of it, and after WO-941
   * it is the ONLY UI call into `applyActiveMachineDefinition` in `src/`.
   *
   * Save first, so the board is never sent a value that exists only inside
   * this form. Save remains future intent while connected; only the matched
   * successful receipt in machineSession promotes this exact definition into
   * the runtime model the app homes with.
   *
   * WHAT IS SENT IS WHAT IS SHOWN, structurally: `draft` falls back to
   * `source`, and `source` is the saved-intent carrier for the connected
   * machine id. The runtime resolver deliberately remains on its session
   * snapshot until the receipt for this shown definition matches.
   *
   * NO GATE MAY EVER BLOCK A STOP: nothing here disables, hides or delays any
   * stop control. The only control it disables is itself, while in flight.
   */
  const handleApply = async (): Promise<void> => {
    if (applying) return
    // Compute authorship BEFORE commit replaces the saved definition with the
    // draft. After the first Save, `source` is mutable; the definition's stated
    // provenance carries the imported profile projection that `commit` stored,
    // so this comparison still means profile -> sent on every later Apply.
    const provenance = machineDefinitionApplyProvenance(
      source.controllerDefinition,
      draft.controllerDefinition,
      draft.name,
    )
    // ALWAYS, not just when dirty. `commit` is what writes the edited
    // definition through to the Control-active library record, so committing
    // unconditionally makes "what is on the screen", "what the library holds",
    // "what the app homes with" and "what goes on the wire" ONE set of values.
    // Gating this on `dirty` could leave Apply sending a definition the page is
    // not showing.
    const savedRecord = commit()

    // From here on nothing is claimed until the controller answers.
    setApplying(true)
    setApplyState(null)
    let ok = false
    let lines: ApplyReportLine[]
    try {
      const definition = savedRecord.controllerDefinition
      const outcome = definition
        ? await applyActiveMachineDefinition(provenance, definition, savedRecord.id)
        : {
            ok: false,
            sent: null,
            refusal: controlText('useMachineDefinitionPanel.text046'),
            result: null,
            authorityRefusal: null,
          }
      ok = outcome.ok
      lines = describeApplyOutcome(outcome)
    } catch (err) {
      lines = [{
        text: controlText('useMachineDefinitionPanel.text047')
          + (err instanceof Error ? err.message : String(err)),
        severity: 'error',
      }]
    }
    if (mountedRef.current) setApplying(false)
    // The result is ABOUT what was sent, even when failure correctly leaves
    // runtime on the older session definition. Signature it against the saved
    // record so "Apply failed" remains visible over the definition that failed.
    //
    // WO-1558: a stamping Apply rewrites the library record's provenance
    // carrier INSIDE `applyActiveMachineDefinition`, before this line runs -
    // `savedRecord` is `commit`'s pre-persist snapshot and no longer matches
    // what `source`/`draft` resolve to once that write lands. Re-reading the
    // library by id picks up that same persisted record, so the Apply
    // control's signature matches what the next render actually shows instead
    // of permanently reading "Apply to Machine" over a successful apply.
    //
    // WO-1558 audit: when the machine is not (or no longer) in
    // `machineLibrary`, the find above always misses, and the OLD pre-persist
    // `savedRecord` fallback reads the same false "idle" mismatch this whole
    // block exists to close. `applyConnectedMachineDefinition` still stamps
    // the project record in that corner, so prefer the freshly re-read
    // project record over the stale snapshot before giving up.
    const latest = useCamStore.getState()
    const persistedRecord = latest.machineLibrary.find((m) => m.id === savedRecord.id)
      ?? (latest.project.machine.id === savedRecord.id ? latest.project.machine : savedRecord)
    reportApply(persistedRecord, ok, lines)
  }

  // ---- derived: summaries and per-field complaints -------------------------
  const problems = def ? validateControllerDefinition(def) : []
  const allPins = def ? controllerDefinitionPins(def) : []
  const enabledAxes = def ? def.axes.filter((a) => a.enabled) : []
  const unsetSoftLimitAxes = enabledAxes
    .filter((axis) => !axisSoftLimitsAreStated(draft, axis.axis))
    .map((axis) => axis.axis)
  const visiblePins = def
    ? controllerDefinitionPins({ ...def, axes: enabledAxes })
    : []
  const assignedPins = visiblePins.filter((p) => isPinAssigned(p.pin)).length
  const order = def?.homing.order ?? []

  // Which field each complaint belongs to, so it rides that field's own hover
  // context. A sentence can name two fields (a duplicate claim); the longest
  // matching label wins, so "probe" never steals "probe 2"'s message.
  const pinProblems = new Map<string, string[]>()
  for (const problem of problems) {
    const named = allPins.map((p) => p.label).filter((l) => problem.includes(l))
    for (const label of named.filter((l) => !named.some((o) => o !== l && o.includes(l)))) {
      pinProblems.set(label, [...(pinProblems.get(label) ?? []), problem])
    }
  }
  const pinProblem = (label: string): string | undefined => {
    const found = pinProblems.get(label)
    return found === undefined ? undefined : found.join(' ')
  }

  const pinText = (p: PinRef) => (isPinAssigned(p) ? `${p.port}:${p.pin}` : 'unset')

  // Every tab carries the number of problems that live INSIDE it. This is
  // the thing that stops a tab from hiding a fault: a badly-set pin announces
  // itself on Machine while a person is standing on Spindle. WO-1687
  // attributes them onto the seven areas by `definitionProblemGroup`, which is
  // total over the validator - so the seven badges always sum to
  // `problems.length`.
  const sectionProblemCount: Record<DefGroup, number> = {
    overview: 0, machine: 0, spindle: 0, outputs: 0, probing: 0, controller: 0, allSettings: 0,
  }
  {
    const pinLabels = allPins.map((pin) => pin.label)
    for (const problem of problems) {
      sectionProblemCount[definitionProblemGroup(problem, pinLabels)] += 1
    }
  }

  /** An axis the record does not carry, rendered AS ABSENT in whichever table
   *  is asking - never a blank row that reads as defined. */
  const absentAxisRow = (name: AxisName, span: number) => (
    <tr key={name} data-testid={`machine-def-panel-axis-${name}`} data-axis-absent="">
      <td className="mform-axis-label" style={{ color: axisColorVar(name) }}>{name}</td>
      <td colSpan={span} style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('useMachineDefinitionPanel.text048')}<button
          type="button"
          className="control-chip-btn"
          data-testid={`machine-def-panel-axis-add-${name}`}
          data-tooltip={controlText('useMachineDefinitionPanel.text049', { value1: String(name) })}
          onClick={() => addAxis(name)}
          style={{ marginLeft: 8 }}
        >
          <Plus size={12} />{controlText('useMachineDefinitionPanel.text050')}{name}
        </button>
      </td>
    </tr>
  )

  // ---- WO-941: what the Apply control says right now ----------------------
  // An answer is only shown while it is still ABOUT the definition on screen.
  // Edit anything after an apply and the control returns to neutral, because
  // "Applied" over a changed definition is the same silent-wrong WO-928
  // removed.
  const applySig = definitionSignature(draft)
  const applyIsCurrent =
    applyState !== null && applySig !== null && applyState.sig === applySig
  const applyTooltip = applying
    ? controlText('useMachineDefinitionPanel.text051')
    : applyIsCurrent
      ? (applyState.lines[0]?.text ?? '')
        + (applyState.lines.length > 1 ? controlText('useMachineDefinitionPanel.text052') : '')
      : controlText('useMachineDefinitionPanel.text053')
        + controlText('useMachineDefinitionPanel.text054')

  const connectedHere = sessionMachine?.id === source.id
  const controllerDefinitionPending = connectedHere
    && definitionSignature(source) !== definitionSignature(machine)
  const reconnectPending = connectedHere
    && reconnectBoundSignature(source) !== reconnectBoundSignature(machine)
  const authorityState = !connectedHere
    ? 'saved'
    : reconnectPending || controllerDefinitionPending
      ? 'pending'
      : appliedMachine?.id === source.id
        ? 'applied'
        : 'session'
  // WO-1712: a machine this panel shows that Control does not drive gets its
  // own plain-words line instead of the ordinary "Saved profile" text, which
  // read as though this WAS the machine that would receive Apply. Checked
  // before `connectedHere` (which is about this same non-driven machine 99%
  // of the time anyway, since `sessionMachine` tracks `controlledMachine`)
  // because this is the more specific fact: not just unconnected, but not
  // even the record Control would apply to once something IS connected.
  const authorityText = !editsConnectedMachine
    ? controlText('useMachineDefinitionPanel.text055', { value1: String(draft.name), value2: String(connectedMachineName) })
      + controlText('useMachineDefinitionPanel.text056', { value1: String(draft.name), value2: String(draft.name) })
    : !connectedHere
      ? controlText('useMachineDefinitionPanel.text057')
      : reconnectPending
        ? controllerDefinitionPending
          ? controlText('useMachineDefinitionPanel.text058')
          : controlText('useMachineDefinitionPanel.text059')
        : controllerDefinitionPending
          ? controlText('useMachineDefinitionPanel.text060')
          : authorityState === 'applied'
            ? controlText('useMachineDefinitionPanel.text061')
            : controlText('useMachineDefinitionPanel.text062')

  // The import issues, BY NAME. A surface that said "3 issues" instead of
  // naming them would rebuild the exact class of defect that cost this project
  // an evening - a report that says something happened without saying what.
  const importIssues = draft.controllerDefinition?.importIssues ?? []
  return { absentAxisRow, editsConnectedMachine, allSettingsTyped, applyIsCurrent, applyState, applyTooltip, applying, assignedPins, authorityState, authorityText, bridgeAction, bridgeCapability, bridgeHello, bridgePort, bridgeProcessState, bridgeTextBlurred, bridgeTextFocused, commit, connectedMachineName, connectionBusy, connectionKind, connectionPhase, controllerSetupHighlighted, controllerSetupRef, def, defineController, defineHoming, detectedInstallRoot, dirty, draft, editDraft, enabledAxes, handleApply, handleBridgeAction, hideEmpty, importIssues, legacyBridgeStatusHost, linuxcncHello, linuxcncJoints, linuxcncOwnsSpindle, localLink, notAcceptedCount, noteBridgeSettingChanged, order, panelBodyRef, patchAxis, patchAxisPin, patchAxisSoftLimit, patchHoming, patchIoPin, pinProblem, pinText, polarityBoxFor, problems, rememberBridgeSetting, rememberPickedPath, revert, saved, section, sectionProblemCount, serialBaud, setAllSettingsTyped, setHideEmpty, setHomingOrderAt, setMachineBridgePort, setSection, setSettingSearch, setSkewTyped, settingSearch, setupKind, skewTyped, slavedAxis, source, spindleLink, spindleLinkIsForeign, spindleLinkOtherMachine, spindleStoredIsStated, toggleAxisEnabled, uccnc, unsent, unsetSoftLimitAxes, vfdEdit, visiblePins }
}

export type MachineDefinitionPanelState = ReturnType<typeof useMachineDefinitionPanel>

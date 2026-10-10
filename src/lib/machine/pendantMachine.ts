import { controlMachine, useCamStore } from '../../store'
import { parkCarrierMachine, useMachineActions } from '../../store/machineActionsStore'
import { useMachineControl } from '../../store/machineControlStore'
import { useMachineToolTable } from '../../store/machineToolTableStore'
import { useUiPrefs } from '../../store/uiPrefs'
import {
  CONTROLLER_NEUTRAL_STOP_LINES,
  machineParkList,
  machineSafeZValue,
  resolveBuiltinLines,
  substituteActionLines,
  type BuiltinActionId,
} from './machineActions'
import { resolveDeclaredController } from './machineChoice'
import {
  estopNeedsReset,
  currentResolvedMachineMotion,
  getMachineController,
  gotoWorkXYZero,
  jogToSafeZ,
  runFeatureProbeCycle,
  runMachineAction,
  runParkMove,
  runZProbeCycle,
  selectWorkOffset,
  setWorkOffsetValue,
  zeroWorkAxes,
} from './machineSession'
import { startHeldJog, type HeldJog } from './heldJog'
import { planFeatureProbeCycle, type ProbeCycleTouchKey } from './probeFeatureCycle'
import {
  calculateBoreCenter,
  calculateBossCenter,
  calculateCorner,
  calculateEdge,
  calculateYawAngle,
} from './probeRoutines'
import { resolveProbeConfig } from './toolTable'
import type {
  PendantCommand,
  PendantCommandContext,
  PendantCommandExecutor,
  PendantCommandOutcome,
} from './pendantBridge'

interface StoredProbeResult {
  display: Record<string, unknown>
  offsets: Partial<Record<'X' | 'Y' | 'Z', number>>
}

const probeResults = new Map<string, StoredProbeResult>()
const ESTOP_REFUSAL = 'Reset the desktop E-stop control before remote motion is allowed.'

/** The pendant's held continuous jog, if one is running (WO-2468). */
let pendantHeldJog: HeldJog | null = null

/** Release the pendant's held jog: timers first, then jogStop and jogCancel.
 *  Returns whether there was one. */
function stopPendantHeldJog(): boolean {
  const held = pendantHeldJog
  if (held === null) return false
  pendantHeldJog = null
  held.stop()
  return true
}

function sayOnConsole(text: string, severity: 'info' | 'error'): void {
  useMachineControl.getState().pushConsole('tx', text, severity)
}

function fail(error: string): PendantCommandOutcome {
  return { ok: false, error }
}

function requireConnected(): PendantCommandOutcome | null {
  return useMachineControl.getState().connectionPhase === 'connected'
    ? null
    : fail('LienCAM is not connected to a machine or simulator.')
}

function requireMotionReady(): PendantCommandOutcome | null {
  const connection = requireConnected()
  if (connection) return connection
  if (estopNeedsReset()) return fail(ESTOP_REFUSAL)
  return null
}

function setDirectOverride(channel: 'feed' | 'rapid' | 'spindle', value: number): PendantCommandOutcome {
  const connection = requireConnected()
  if (connection) return connection
  const controller = getMachineController()
  if (channel === 'rapid') {
    // WO-422: an absolute rapid percentage, stated as one. GRBL has exactly
    // three rapid levels and its backend maps these three onto them; the
    // pendant still refuses anything else up front so the operator gets a
    // sentence rather than a silent no-op.
    if (value !== 25 && value !== 50 && value !== 100) {
      return fail('Rapid override must be 25%, 50%, or 100%.')
    }
    controller.setOverride({ kind: 'rapid', to: 'percent', percent: value })
    return { ok: true }
  }
  if (!Number.isInteger(value) || value < 10 || value > 200) {
    return fail(`${channel === 'feed' ? 'Feed' : 'Spindle'} override must be a whole percent from 10 to 200.`)
  }
  // WO-422: the same walk as before - reset to 100%, then coarse (10%) and
  // fine (1%) steps - now in the controller-neutral vocabulary rather than in
  // GRBL realtime bytes. Against GRBL the bytes on the wire are unchanged.
  const direction: 1 | -1 = value < 100 ? -1 : 1
  controller.setOverride({ kind: channel, to: 'reset' })
  const delta = Math.abs(value - 100)
  for (let count = Math.floor(delta / 10); count > 0; count--) {
    controller.setOverride({ kind: channel, to: 'step', direction, coarse: true })
  }
  for (let count = delta % 10; count > 0; count--) {
    controller.setOverride({ kind: channel, to: 'step', direction, coarse: false })
  }
  return { ok: true }
}

function runSpindle(direction: 'cw' | 'ccw' | 'off'): PendantCommandOutcome {
  const connection = requireConnected()
  if (connection) return connection
  const machine = controlMachine(useCamStore.getState())
  const machineId = machine?.id ?? 'default'
  const action: BuiltinActionId = direction === 'cw' ? 'spindleCw' : direction === 'ccw' ? 'spindleCcw' : 'spindleOff'
  const config = useMachineActions.getState().configFor(machineId)
  const override = config.overrides[action]
  const controllerResolution = resolveDeclaredController(machine)
  let rawLines: string[]
  if (override && override.length > 0) {
    rawLines = override
  } else {
    if (!controllerResolution.ok) {
      if (direction === 'off') {
        // A declaration gate never blocks a stop. M5 is controller-neutral
        // across the supported set, so this attempts the text route without
        // selecting a default controller.
        rawLines = CONTROLLER_NEUTRAL_STOP_LINES.spindleOff
      } else {
        useMachineControl.getState().pushConsole('tx', controllerResolution.reason, 'error')
        return fail(controllerResolution.reason)
      }
    } else {
      rawLines = resolveBuiltinLines(config, controllerResolution.controller, action)
    }
  }
  const lines = substituteActionLines(
    rawLines,
    { rpm: useUiPrefs.getState().machineSpindleRpm },
  )
  const outcome = runMachineAction(lines, { action })
  return outcome.ok ? { ok: true } : fail(outcome.reason)
}

function runMacro(id: Extract<PendantCommand, { kind: 'macro' }>['id']): PendantCommandOutcome {
  const ready = requireMotionReady()
  if (ready) return ready
  const machine = controlMachine(useCamStore.getState())
  if (!machine) return fail('Select a machine before using remote macros.')
  const config = useMachineActions.getState().configFor(machine.id)
  const feed = machine.rapidRate
  const parkMachine = parkCarrierMachine(useCamStore.getState())
  const safeZ = machineSafeZValue(parkMachine, config)
  if (id === 'raise-z') {
    const outcome = jogToSafeZ(safeZ, feed)
    return outcome.ok ? { ok: true } : fail(outcome.reason ?? 'Safe Z move was refused.')
  }
  if (id === 'go-xy-zero') {
    return gotoWorkXYZero(feed) ? { ok: true } : fail('Goto work XY zero was refused.')
  }
  if (id === 'park-rear') {
    const park = machineParkList(parkMachine, config).find((candidate) => /rear|back/i.test(candidate.label))
    if (!park) return fail('Make a park macro named Rear or Back in the Macros panel (Edit macros) first.')
    const outcome = runParkMove(park, safeZ)
    return outcome.ok ? { ok: true } : fail(outcome.reason ?? 'Rear park was refused.')
  }
  const envelope = currentResolvedMachineMotion().envelope
  if (!envelope.x || !envelope.y) return fail('The machine envelope is unknown; home the machine and read its settings first.')
  const center = {
    id: 'pendant-table-center',
    label: 'Table center',
    x: (envelope.x.min + envelope.x.max) / 2,
    y: (envelope.y.min + envelope.y.max) / 2,
  }
  const outcome = runParkMove(center, safeZ)
  return outcome.ok ? { ok: true } : fail(outcome.reason ?? 'Table center move was refused.')
}

function touchValue(touches: Partial<Record<ProbeCycleTouchKey, number>>, key: ProbeCycleTouchKey): number {
  const value = touches[key]
  if (value === undefined) throw new Error(`Probe cycle did not return ${key}.`)
  return value
}

function featureProbeResult(
  command: Extract<PendantCommand, { kind: 'probe-start' }>,
  touches: Partial<Record<ProbeCycleTouchKey, number>>,
  plan: ReturnType<typeof planFeatureProbeCycle> & { ok: true },
): StoredProbeResult {
  const { routineId, params } = command
  if (routineId === 'edge') {
    const result = calculateEdge({
      axis: params.edgeAxis,
      direction: params.edgeDirection,
      triggerPositionMm: touchValue(touches, 'edge'),
      tipRadiusMm: params.tipRadius,
    })
    return {
      display: { axis: result.axis, edgeCoordinate: result.coordinateMm, compensation: result.compensation },
      offsets: { [result.axis]: result.coordinateMm },
    }
  }
  if (routineId === 'corner') {
    const result = calculateCorner({
      x: { direction: '-', triggerPositionMm: touchValue(touches, 'cornerX'), tipRadiusMm: params.tipRadius },
      y: { direction: '-', triggerPositionMm: touchValue(touches, 'cornerY'), tipRadiusMm: params.tipRadius },
    })
    return {
      display: { centerX: result.xMm, centerY: result.yMm, compensation: result.compensation },
      offsets: { X: result.xMm, Y: result.yMm },
    }
  }
  if (routineId === 'angle') {
    const nominalAxis = params.edgeAxis
    const firstStep = plan.plan.steps.find((step) => step.kind === 'touch' && step.key === 'angleFirst')
    const secondStep = plan.plan.steps.find((step) => step.kind === 'touch' && step.key === 'angleSecond')
    if (!firstStep || firstStep.kind !== 'touch' || !secondStep || secondStep.kind !== 'touch') {
      throw new Error('Angle plan did not contain both touch points.')
    }
    const alongKey = nominalAxis.toLowerCase() as 'x' | 'y'
    const result = calculateYawAngle({
      nominalAxis,
      direction: params.edgeDirection,
      tipRadiusMm: params.tipRadius,
      first: { alongMm: firstStep.expectedStart[alongKey], triggerPositionMm: touchValue(touches, 'angleFirst') },
      second: { alongMm: secondStep.expectedStart[alongKey], triggerPositionMm: touchValue(touches, 'angleSecond') },
    })
    return { display: { thetaDeg: result.thetaDeg, compensation: result.compensation }, offsets: {} }
  }
  const input = {
    xNegativeMm: touchValue(touches, 'xNegative'),
    xPositiveMm: touchValue(touches, 'xPositive'),
    yNegativeMm: touchValue(touches, 'yNegative'),
    yPositiveMm: touchValue(touches, 'yPositive'),
    tipRadiusMm: params.tipRadius,
  }
  const result = routineId === 'bore' || routineId === 'rectPocket'
    ? calculateBoreCenter(input)
    : calculateBossCenter(input)
  return {
    display: {
      centerX: result.centerXmm,
      centerY: result.centerYmm,
      diameterX: result.diameterXmm,
      diameterY: result.diameterYmm,
      compensation: result.compensation,
    },
    offsets: { X: result.centerXmm, Y: result.centerYmm },
  }
}

async function runProbe(
  command: Extract<PendantCommand, { kind: 'probe-start' }>,
  context: PendantCommandContext,
): Promise<PendantCommandOutcome> {
  const ready = requireMotionReady()
  if (ready) return ready
  if (!command.params.pathClearConfirmed) return fail('Confirm that the probe and positioning path are clear before running.')
  const machine = controlMachine(useCamStore.getState())
  if (!machine) return fail('Select a machine before probing.')
  const state = useMachineControl.getState()
  if (!state.mpos) return fail('Wait for a live machine position before probing.')
  const base = resolveProbeConfig(machine.probing, useMachineToolTable.getState().probeConfigFor(machine.id))
  const searchTravel = command.params.searchTravel
  if (!Number.isFinite(searchTravel) || searchTravel <= base.retract) {
    return fail(`Probe search travel must be greater than the ${base.retract} mm retract.`)
  }
  if (!Number.isFinite(command.params.probeFeed) || command.params.probeFeed <= 0) return fail('Probe feed must be greater than zero.')
  const clearance = Math.min(base.surfaceClearance, searchTravel / 2)
  const config = resolveProbeConfig(null, {
    ...base,
    slowFeed: command.params.probeFeed,
    fastFeed: Math.max(base.fastFeed, command.params.probeFeed),
    maxTravel: searchTravel,
    surfaceClearance: clearance,
    overtravel: searchTravel - clearance,
  })
  probeResults.delete(context.clientId)
  if (command.routineId === 'zSurface') {
    context.emit('probe_progress', { stepIndex: 0, totalSteps: 1, stepLabel: 'Probe Z surface', message: 'Probing Z surface...' })
    const cycle = await runZProbeCycle('measureTool', config)
    if (!cycle.ok || cycle.probedMachineZ === null) {
      context.emit('probe_progress', { stepIndex: 0, totalSteps: 1, error: cycle.message, message: cycle.message })
      return fail(cycle.message)
    }
    // A workpiece surface touch is the contacted surface itself. Fixed-pad
    // thickness belongs to tool-length measurement, not work-zero probing.
    const surfaceZ = cycle.probedMachineZ
    const stored = { display: { surfaceZ }, offsets: { Z: surfaceZ } }
    probeResults.set(context.clientId, stored)
    context.emit('probe_progress', {
      stepIndex: 0,
      totalSteps: 1,
      stepLabel: 'Probe Z surface',
      complete: true,
      result: stored.display,
      message: cycle.message,
    })
    return { ok: true, data: stored.display }
  }
  const envelope = currentResolvedMachineMotion().envelope
  const kind = command.routineId === 'corner' ? 'insideCorner' : command.routineId
  const planned = planFeatureProbeCycle({
    kind,
    start: state.mpos,
    envelope,
    config,
    tipRadiusMm: command.params.tipRadius,
    nominalSizeXmm: command.params.nominalSize,
    nominalSizeYmm: command.params.nominalSize,
    edgeAxis: command.params.edgeAxis,
    edgeDirection: command.params.edgeDirection,
    cornerXDirection: '-',
    cornerYDirection: '-',
    angleNominalAxis: command.params.edgeAxis,
    angleProbeDirection: command.params.edgeDirection,
    angleAlongDirection: '+',
    angleSpacingMm: command.params.nominalSize,
    // WO-2035: a boss cross-over with the top unknown runs at the machine's
    // declared Safe Z.
    safeZMachineMm: machineSafeZValue(parkCarrierMachine(useCamStore.getState())),
    // WO-2055: left unchanged here. The pendant's own screen and pictures
    // (pendant/app/probe-diagrams.js) still tell the operator to start beside
    // the face at probing depth; touching the "top" from there would find the
    // table. Edge and Angle on the pendant keep touching from where it stands.
    // WO-2056 (Outside corner from the top) does not reach the pendant: its
    // only corner is 'corner', planned as an Inside corner above.
    // WO-2057 (Inside corner, Bore, Rect pocket descend from work Z0 or a rim
    // touch) does not reach it either: the pendant's screen still says start
    // in the hole at probing depth, so its corner, bore and pocket keep
    // touching from where the probe stands.
    // WO-2058 (Boss and Rect boss start over the middle and cross at the
    // touched top + clearance) does not reach it either: the pendant's screen
    // still says start outside the X max face at probing depth, so its boss
    // keeps the beside-the-face plan and WO-2035's cross-over at Safe Z above.
    approachFromTop: false,
  })
  if (!planned.ok) return fail(planned.reason)
  let touchIndex = 0
  const totalTouches = planned.plan.review.touchOrder.length
  context.emit('probe_progress', { stepIndex: 0, totalSteps: totalTouches, stepLabel: 'Preflight', message: planned.plan.summary })
  const cycle = await runFeatureProbeCycle(planned.plan, config, true, (key, position) => {
    const spec = planned.plan.review.touchOrder[touchIndex]
    context.emit('probe_progress', {
      stepIndex: touchIndex,
      totalSteps: totalTouches,
      stepLabel: `${spec?.axis ?? ''}${spec?.direction ?? ''} ${key}`,
      touch: {
        x: spec?.axis === 'X' ? position : state.mpos!.x,
        y: spec?.axis === 'Y' ? position : state.mpos!.y,
        z: state.mpos!.z,
      },
      message: `Recorded ${key}.`,
    })
    touchIndex++
  })
  if (!cycle.ok) {
    context.emit('probe_progress', { stepIndex: touchIndex, totalSteps: totalTouches, error: cycle.message, message: cycle.message })
    return fail(cycle.message)
  }
  try {
    const stored = featureProbeResult(command, cycle.touches, planned)
    probeResults.set(context.clientId, stored)
    context.emit('probe_progress', {
      stepIndex: totalTouches - 1,
      totalSteps: totalTouches,
      stepLabel: 'Complete',
      complete: true,
      result: stored.display,
      message: cycle.message,
    })
    return { ok: true, data: stored.display }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

async function applyProbeZero(clientId: string): Promise<PendantCommandOutcome> {
  const ready = requireMotionReady()
  if (ready) return ready
  const result = probeResults.get(clientId)
  if (!result) return fail('Run a successful probe cycle from this pendant before applying zero.')
  const wcs = useMachineControl.getState().activeWcs
  if (!wcs) return fail('The active work offset is unknown.')
  for (const axis of ['X', 'Y', 'Z'] as const) {
    const value = result.offsets[axis]
    if (value !== undefined && !setWorkOffsetValue(wcs, axis, value)) return fail(`The controller refused the ${axis} work-offset write.`)
  }
  return { ok: true }
}

export const executePendantMachineCommand: PendantCommandExecutor = async (command, context) => {
  // WO-2468: a held jog has local timers of its own. Every stop ends them
  // first, connected or not, so nothing keeps sending after it.
  if (command.kind === 'feed-hold') {
    stopPendantHeldJog()
    const connection = requireConnected()
    if (connection) return connection
    getMachineController().feedHold()
    return { ok: true }
  }
  if (command.kind === 'soft-reset') {
    stopPendantHeldJog()
    const connection = requireConnected()
    if (connection) return connection
    getMachineController().reset()
    return { ok: true }
  }
  if (command.kind === 'jog-cancel') {
    const stopped = stopPendantHeldJog()
    const connection = requireConnected()
    if (connection) return connection
    if (!stopped) getMachineController().jogCancel()
    return { ok: true }
  }
  if (command.kind === 'jog-step') {
    const ready = requireMotionReady()
    if (ready) return ready
    if (command.deltaMm === 0 || Math.abs(command.deltaMm) > 100 || command.feedMmMin <= 0) return fail('Jog distance or feed is outside the allowed range.')
    return getMachineController().jog(command.axis, command.deltaMm, command.feedMmMin)
      ? { ok: true }
      : fail('The controller refused the jog because the machine is busy, alarmed, or not ready.')
  }
  if (command.kind === 'jog-continuous') {
    const ready = requireMotionReady()
    if (ready) return ready
    if (command.feedMmMin <= 0) return fail('Jog feed must be greater than zero.')
    // WO-2468: the desktop's held route, not one jog of the axis's whole
    // travel - the simulator refused that from anywhere but the table edge.
    // The bridge's keep-alive watchdog ends it with a jog-cancel on release.
    stopPendantHeldJog()
    const held = startHeldJog(command.axis, command.direction, command.feedMmMin, sayOnConsole, () => {
      if (pendantHeldJog === held) stopPendantHeldJog()
    })
    pendantHeldJog = held
    if (await held.started) return { ok: true }
    if (pendantHeldJog === held) stopPendantHeldJog()
    return fail('The controller refused continuous jog because the machine is busy, alarmed, or not ready.')
  }
  if (command.kind === 'zero-axes') {
    const connection = requireConnected()
    if (connection) return connection
    if (useMachineControl.getState().machineState !== 'idle') return fail('The machine must be idle before changing work zero.')
    zeroWorkAxes(command.axes)
    return { ok: true }
  }
  if (command.kind === 'select-wcs') {
    const connection = requireConnected()
    if (connection) return connection
    if (useMachineControl.getState().machineState !== 'idle') return fail('The machine must be idle before changing work offsets.')
    selectWorkOffset(command.wcs)
    return { ok: true }
  }
  if (command.kind === 'override') return setDirectOverride(command.channel, command.value)
  if (command.kind === 'spindle') return runSpindle(command.direction)
  if (command.kind === 'macro') return runMacro(command.id)
  if (command.kind === 'probe-start') return runProbe(command, context)
  return applyProbeZero(context.clientId)
}

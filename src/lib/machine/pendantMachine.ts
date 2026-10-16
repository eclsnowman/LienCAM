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
  probeSensingFor,
  runFeatureProbeCycle,
  runMachineAction,
  runParkMove,
  runZProbeCycle,
  selectWorkOffset,
  setWorkOffsetValue,
  zeroWorkAxes,
} from './machineSession'
import { startHeldJog, type HeldJog } from './heldJog'
import {
  DEFAULT_TOP_SEARCH_MM,
  planFeatureProbeCycle,
  sideCompensationRadiusMm,
  type ProbeCycleTouchKey,
} from './probeFeatureCycle'
import {
  calculateBoreCenter,
  calculateBossCenter,
  calculateEdge,
} from './probeRoutines'
import { resolveProbeConfig } from './toolTable'
import { activeToolFromLibrary, faceAngleFromTouches, probingSessionValues } from './probingSession'
import { probeCalibratedRadius } from '../tool/probeTool'
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
/** WO-2809: the Probing screen's own "Start within" and "Probing depth"
 *  defaults (ProbingPanel.tsx, WO-2063 design 4.4). */
const SCREEN_START_WITHIN_MM = 10
const SCREEN_PROBING_DEPTH_MM = 5
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
  radii: { x: number; y: number },
  cornerDirections: { x: '+' | '-'; y: '+' | '-' },
): StoredProbeResult {
  const { routineId, params } = command
  if (routineId === 'edge') {
    const result = calculateEdge({
      axis: params.edgeAxis,
      direction: params.edgeDirection,
      triggerPositionMm: touchValue(touches, 'edge'),
      tipRadiusMm: radii[params.edgeAxis.toLowerCase() as 'x' | 'y'],
    })
    return {
      display: { axis: result.axis, edgeCoordinate: result.coordinateMm, compensation: result.compensation },
      offsets: { [result.axis]: result.coordinateMm },
    }
  }
  if (routineId === 'corner') {
    const x = calculateEdge({ axis: 'X', direction: cornerDirections.x, triggerPositionMm: touchValue(touches, 'cornerX'), tipRadiusMm: radii.x })
    const y = calculateEdge({ axis: 'Y', direction: cornerDirections.y, triggerPositionMm: touchValue(touches, 'cornerY'), tipRadiusMm: radii.y })
    const result = { xMm: x.coordinateMm, yMm: y.coordinateMm, compensation: `${x.compensation} ${y.compensation}` }
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
    const result = faceAngleFromTouches({
      nominalAxis,
      direction: params.edgeDirection,
      tipRadiusMm: radii[params.edgeAxis === 'X' ? 'y' : 'x'],
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
    tipRadiusMm: radii.x,
  }
  const calculate = routineId === 'bore' || routineId === 'rectPocket' ? calculateBoreCenter : calculateBossCenter
  const result = calculate(input)
  const yResult = calculate({ ...input, tipRadiusMm: radii.y })
  return {
    display: {
      centerX: result.centerXmm,
      centerY: result.centerYmm,
      diameterX: result.diameterXmm,
      diameterY: yResult.diameterYmm,
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
  const machine = controlMachine(useCamStore.getState())
  if (!machine) return fail('Select a machine before probing.')
  const state = useMachineControl.getState()
  if (!state.mpos) return fail('Wait for a live machine position before probing.')
  if (command.routineId === 'zSurface') {
    if (!command.params.pathClearConfirmed) return fail('Confirm that the probe and positioning path are clear before running.')
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
    // A request refused above never starts a cycle and keeps this phone's
    // previous measurement for Apply zero; only a started cycle replaces it.
    probeResults.delete(context.clientId)
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
  // WO-2809: screen session values are shared, including boss work Z0 and
  // separate rectangular sizes. -1 on the existing numeric wire fields means
  // the phone input is blank (inherit); an explicit phone input wins this run.
  const probeCfg = resolveProbeConfig(machine.probing, useMachineToolTable.getState().byMachine[machine.id]?.probe)
  const kind = command.routineId === 'corner' ? 'insideCorner' : command.routineId
  const values = probingSessionValues(machine.id)
  const value = <T,>(key: string, fallback: T): T => key in values ? values[key] as T : fallback
  const tableDia = state.activeTool === null ? null : useMachineToolTable.getState().byMachine[machine.id]?.table.tools.find((tool) => tool.tool === state.activeTool)?.dia ?? null
  const tool = activeToolFromLibrary(state.activeTool, useCamStore.getState().toolLibrary, tableDia)
  const diameter = tool && tool.diameter > 0 ? tool.diameter : tableDia !== null && tableDia > 0 ? tableDia : null
  const phoneRadiusTyped = command.params.tipRadius !== -1
  const typed = phoneRadiusTyped || value('tipRadiusTyped', false)
  const ballRadius = phoneRadiusTyped ? command.params.tipRadius
    : value('tipRadiusTyped', false) ? value('tipRadiusMm', 1.5)
      : diameter !== null ? diameter / 2 : state.activeTool !== null ? 1.5 : value('tipRadiusMm', 1.5)
  const sensing = probeSensingFor(machine.id, kind)
  const senseRadiusXmm = sideCompensationRadiusMm(!typed && tool ? probeCalibratedRadius(tool, 'x') ?? ballRadius : ballRadius, sensing, probeCfg)
  const senseRadiusYmm = sideCompensationRadiusMm(!typed && tool ? probeCalibratedRadius(tool, 'y') ?? ballRadius : ballRadius, sensing, probeCfg)
  const senseRadiusMm = Math.max(senseRadiusXmm, senseRadiusYmm)
  const circular = kind === 'bore' || kind === 'boss'
  const ownSize = command.params.nominalSize !== -1
  const sizeX = ownSize ? command.params.nominalSize : value(circular ? 'nominalDiameterMm' : 'rectSizeXmm', 25)
  const sizeY = ownSize ? command.params.nominalSize : value(circular ? 'nominalDiameterMm' : 'nominalSizeYmm', 25)
  const setup = {
    startWithinMm: value('startDistanceMm', SCREEN_START_WITHIN_MM),
    depthBelowTopMm: value('depthBelowTopMm', SCREEN_PROBING_DEPTH_MM),
    topSearchMm: Math.min(value('topSearchMm', DEFAULT_TOP_SEARCH_MM), probeCfg.maxTravel),
    clearanceMm: probeCfg.surfaceClearance,
    topFromWorkZero: (kind === 'boss' || kind === 'rectBoss') && value<'touch' | 'workZero'>('bossTop', 'touch') === 'workZero',
    nominalSizeXmm: sizeX,
    nominalSizeYmm: sizeY,
    angleSpacingMm: ownSize ? command.params.nominalSize : value('angleSpacingMm', 25),
    cornerXDirection: value<'+' | '-'>('insideCornerXDirection', '-'),
    cornerYDirection: value<'+' | '-'>('insideCornerYDirection', '-'),
    angleAlongDirection: value<'+' | '-'>('angleAlongDirection', '+'),
    tipRadiusXmm: senseRadiusXmm,
    tipRadiusYmm: senseRadiusYmm,
  }
  // A non-confirmed request remains motionless. Return its resolved setup so
  // the phone can draw the actual first step before the operator presses Run,
  // without extending an unowned transport command/parser.
  if (!command.params.pathClearConfirmed) return {
    ok: false, error: 'Confirm that the probe and positioning path are clear before running.', data: setup,
  }
  const envelope = currentResolvedMachineMotion().envelope
  const planned = planFeatureProbeCycle({
    kind,
    start: state.mpos,
    envelope,
    config: probeCfg,
    tipRadiusMm: senseRadiusMm,
    nominalSizeXmm: sizeX,
    nominalSizeYmm: sizeY,
    edgeAxis: command.params.edgeAxis,
    edgeDirection: command.params.edgeDirection,
    cornerXDirection: setup.cornerXDirection,
    cornerYDirection: setup.cornerYDirection,
    angleNominalAxis: command.params.edgeAxis,
    angleProbeDirection: command.params.edgeDirection,
    angleAlongDirection: setup.angleAlongDirection,
    angleSpacingMm: setup.angleSpacingMm,
    startDistanceMm: setup.startWithinMm,
    depthBelowTopMm: setup.depthBelowTopMm,
    topSearchMm: setup.topSearchMm,
    topFromWorkZero: setup.topFromWorkZero,
    // WO-2035: a boss cross-over with the top unknown runs at the machine's
    // declared Safe Z.
    safeZMachineMm: machineSafeZValue(parkCarrierMachine(useCamStore.getState())),
  })
  if (!planned.ok) return fail(planned.reason)
  probeResults.delete(context.clientId)
  let touchIndex = 0
  const totalTouches = planned.plan.review.touchOrder.length
  context.emit('probe_progress', { stepIndex: 0, totalSteps: totalTouches, stepLabel: 'Preflight', message: planned.plan.summary })
  const cycle = await runFeatureProbeCycle(planned.plan, probeCfg, true, (key, position) => {
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
    const stored = featureProbeResult(command, cycle.touches, planned, { x: senseRadiusXmm, y: senseRadiusYmm }, { x: setup.cornerXDirection, y: setup.cornerYDirection })
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

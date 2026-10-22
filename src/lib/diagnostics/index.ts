// WO-2759: Help > Report a problem - the app-facing side of diagnostics.
//
// installDiagnostics() starts the structured history once per page: a session
// start, uncaught renderer errors (code locations only, never the message),
// operation generation outcomes, and machine connection/state/alarm/job
// transitions. Producers only READ existing stores; recording can never change
// a motion gate, and nothing here sends anything to the controller.
//
// freezeReportSources() is the one place a report reads app state. The dialog
// calls it when it opens (and on Refresh); the preview and the saved ZIP are
// both built from that frozen copy. The off-by-default categories (precise
// environment, operation settings) are not in it: they are read by
// readOptionalSource() only once their box is ticked (design section 3).

import { snapshotCurrentProjectFile, useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useUiPrefs } from '../../store/uiPrefs'
import { ALL_OPERATION_TYPES } from '../../store/opModelOriginGuard'
import { DiagnosticHistory, IndexedDbHistoryStorage, MemoryHistoryStorage } from './history'
import { stackLocations } from './schema'
import {
  basicEnvironment, currentSurface, machineAvailable, machineSnapshot, operationSettings,
  preciseEnvironment, probeBasicEnvironment, probePreciseEnvironment, readAppVersions, type MachineInput,
} from './sources'
import type { Attachment, ConsoleTailSource, ReportSources } from './report'
import type { OperationSettingsSnapshot, PreciseEnvironment } from './sources'
import { routeForConsoleSource, type FailureContext } from './failure'

export * from './report'
export * from './githubPrefill'
export * from './failure'
export { captureApp, type AppCapture, type CaptureResult } from './capture'
export { DiagnosticHistory, MemoryHistoryStorage } from './history'
export type { SessionSummary } from './history'

let history: DiagnosticHistory | null = null

export function diagnosticHistory(): DiagnosticHistory {
  if (history) return history
  const storage = typeof indexedDB !== 'undefined' ? new IndexedDbHistoryStorage() : new MemoryHistoryStorage()
  history = new DiagnosticHistory(storage)
  return history
}

function appOrigins(): string[] {
  if (typeof location === 'undefined') return []
  const base = new URL('./', location.href).href
  return [...new Set([base, `${location.origin}/`])]
}

/** For an error boundary: records where it failed, never what it said. */
export function recordBoundaryError(error: unknown) {
  const stack = error instanceof Error ? error.stack : undefined
  diagnosticHistory().record('renderer.uncaught-error', { kind: 'boundary', frames: stackLocations(stack, appOrigins()) })
}

let installed = false
let clearChannel: BroadcastChannel | null = null
// Design section 5: prune periodically while open, not only at startup.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

/** Clear saved history here and in every other open LienCAM tab. */
export async function clearDiagnosticHistory(): Promise<void> {
  clearChannel?.postMessage('clear')
  await diagnosticHistory().clear()
}

export function installDiagnostics(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const h = diagnosticHistory()
  h.setRecording(useUiPrefs.getState().diagnosticHistoryRecording !== false)
  useUiPrefs.subscribe((s) => h.setRecording(s.diagnosticHistoryRecording !== false))
  h.record('session.start', { surface: currentSurface() })
  void h.whenReady().then(() => {
    if (!h.previousEndedUnexpectedly) return
    h.record('session.previous-ended-unexpectedly')
    useCamStore.getState().addConsoleEvent({
      severity: 'info',
      source: 'diagnostics',
      message: 'Previous session ended unexpectedly. Help > Report a problem can save available details.',
    })
  })

  window.addEventListener('error', (event) => {
    const stack = (event.error as Error | undefined)?.stack
    h.record('renderer.uncaught-error', { kind: 'error', frames: stackLocations(stack, appOrigins()) })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const stack = (event.reason as Error | undefined)?.stack
    h.record('renderer.uncaught-error', { kind: 'rejection', frames: stackLocations(stack, appOrigins()) })
  })
  window.addEventListener('pagehide', () => h.endSession())
  window.addEventListener('pageshow', (event) => { if (event.persisted) h.resumeSession() })
  // Clear in one tab clears every open tab, so none writes its copy back.
  clearChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('liencam-diagnostics') : null
  if (clearChannel) clearChannel.onmessage = (event) => { if (event.data === 'clear') void h.clear() }
  setInterval(() => { void h.prune() }, PRUNE_INTERVAL_MS)

  // Operation outcomes: report-local operation numbers, never ids or names.
  const operationRefs = new Map<string, number>()
  const refFor = (id: string) => {
    let ref = operationRefs.get(id)
    if (ref === undefined) { ref = operationRefs.size + 1; operationRefs.set(id, ref) }
    return ref
  }
  const lastStatus = new Map<string, string>()
  let lastSetups: unknown = null
  useCamStore.subscribe((s) => {
    const setups = s.project?.setups
    if (setups === lastSetups || !Array.isArray(setups)) return
    lastSetups = setups
    for (const setup of setups) {
      for (const op of setup.operations ?? []) {
        const before = lastStatus.get(op.id)
        if (before === op.status) continue
        lastStatus.set(op.id, op.status)
        if (before === undefined && op.status !== 'computing') continue
        if (op.status === 'computing') {
          h.record('cam.generation.started', { family: op.type, operation: refFor(op.id) })
        } else if (before === 'computing') {
          h.record('cam.generation.finished', {
            family: op.type, operation: refFor(op.id), outcome: op.status,
            ms: typeof op.computeTimeMs === 'number' ? op.computeTimeMs : null,
          })
        }
      }
    }
  })

  // Machine transitions, coalesced: only a change is an event (no polling chatter).
  let last = { phase: '', kind: '' as string | null, state: '', alarm: '', job: '' }
  useMachineControl.subscribe((m) => {
    if (m.connectionPhase !== last.phase || m.connectionKind !== last.kind) {
      h.record('machine.connection', { phase: m.connectionPhase, transport: m.connectionKind })
    }
    if (m.machineState !== last.state) h.record('machine.state', { state: m.machineState })
    const alarm = m.alarm ? `${m.alarm.code}:${m.alarm.positionLost}` : ''
    if (alarm !== last.alarm && m.alarm) {
      h.record('machine.alarm', { code: m.alarm.code, positionLost: m.alarm.positionLost === true })
    }
    const job = `${m.job.phase}`
    if (job !== last.job && m.job.phase !== 'empty') {
      h.record('machine.job', { phase: m.job.phase, totalLines: m.job.totalLines, sentLines: m.job.sentLines, ackedLines: m.job.ackedLines })
    }
    last = { phase: m.connectionPhase, kind: m.connectionKind, state: m.machineState, alarm, job }
  })
}

function machineInput(): MachineInput {
  const m = useMachineControl.getState()
  return {
    connectionPhase: m.connectionPhase, connectionKind: m.connectionKind, machineState: m.machineState,
    grblVersion: m.grblVersion, alarm: m.alarm ? { code: m.alarm.code, positionLost: m.alarm.positionLost } : null,
    job: { phase: m.job.phase, totalLines: m.job.totalLines, sentLines: m.job.sentLines, ackedLines: m.job.ackedLines },
    parserModal: m.parserModal ? { units: m.parserModal.units, distanceMode: m.parserModal.distanceMode, motionMode: m.parserModal.motionMode } : null,
  }
}

export function sessionLabel(index: number, current: boolean): string {
  return current ? 'this session' : `earlier session ${index}`
}

function activeOperation() {
  const cam = useCamStore.getState()
  const activeId = cam.project?.activeOperationId ?? null
  return activeId ? cam.project.setups.flatMap((s) => s.operations ?? []).find((o) => o.id === activeId) ?? null : null
}

/** Freeze the default categories' sources for one report. Attachments are
 *  passed in already read to bytes, so a file changed on disk later cannot
 *  change it. The optional categories stay null until readOptionalSource(). */
export function freezeReportSources(
  incidentSessionId: string,
  attachments: { project: Attachment | null; program: Attachment | null; image: Attachment | null },
): ReportSources {
  const h = diagnosticHistory()
  const summaries = h.summaries()
  const index = summaries.findIndex((s) => s.id === incidentSessionId)
  const snap = h.snapshot(incidentSessionId)
  const machine = machineInput()
  return {
    appVersions: readAppVersions(),
    basicEnvironment: basicEnvironment(probeBasicEnvironment()),
    preciseEnvironment: null,
    incident: snap && index >= 0
      ? { label: sessionLabel(index, snap.current), events: snap.events, dropped: snap.dropped, omissions: snap.omissions }
      : null,
    machineState: machineAvailable(machine) ? machineSnapshot(machine) : null,
    operationSettings: null,
    ...attachments,
  }
}

export type OptionalSourceId = 'preciseEnvironment' | 'operationSettings'

/** Whether an optional category could be read, without reading it. */
export function optionalSourceAvailable(id: OptionalSourceId): boolean {
  return id === 'preciseEnvironment' || activeOperation() !== null
}

/** Read one optional category - called only after the user ticks it. */
export function readOptionalSource(id: 'preciseEnvironment'): PreciseEnvironment
export function readOptionalSource(id: 'operationSettings'): OperationSettingsSnapshot | null
export function readOptionalSource(id: OptionalSourceId): PreciseEnvironment | OperationSettingsSnapshot | null {
  if (id === 'preciseEnvironment') return preciseEnvironment(probePreciseEnvironment())
  const op = activeOperation()
  if (!op) return null
  const tool = useCamStore.getState().toolLibrary.find((t) => t.id === op.toolId) ?? null
  return operationSettings(op, tool, ALL_OPERATION_TYPES)
}

// --- WO-2911: a report started at the failure ---------------------------------

/** The view the operator was in: Model, or the CAM tab. */
function currentView(): string {
  const cam = useCamStore.getState()
  return (cam as { workspace?: string }).workspace === 'part' ? 'model' : cam.viewer.mode
}

/** Freeze one console line as the failure to report. Reads only; selects nothing. */
export function failureFromConsoleEvent(eventId: number, reportedAt = Date.now()): FailureContext | null {
  const cam = useCamStore.getState()
  const event = cam.consoleEvents.find((e) => e.id === eventId)
  if (!event) return null
  const opRef = event.entityRef?.kind === 'op' ? event.entityRef.id : null
  let operation: FailureContext['operation'] = null
  if (opRef) {
    const setup = cam.project.setups.find((st) => (st.operations ?? []).some((o) => o.id === opRef)) ?? null
    const op = setup?.operations.find((o) => o.id === opRef) ?? null
    if (op) {
      const tool = cam.toolLibrary.find((t) => t.id === op.toolId) ?? null
      operation = {
        name: op.name, family: op.type, setupName: setup?.name ?? null,
        settings: operationSettings(op, tool, ALL_OPERATION_TYPES),
      }
    }
  }
  return {
    route: routeForConsoleSource(event.source, opRef !== null),
    source: event.source, errorText: event.message, shownAt: event.at, reportedAt,
    view: currentView(), operation, frames: [],
  }
}

/** Freeze an error screen's error as the failure to report (code locations, never the stack text). */
export function failureFromError(error: unknown, screen: 'app-error-screen' | 'view-error-screen', reportedAt = Date.now()): FailureContext {
  const e = error instanceof Error ? error : null
  let view: string | null = null
  try { view = currentView() } catch { /* the store itself may be what failed */ }
  return {
    route: screen, source: screen === 'app-error-screen' ? 'app error screen' : '3D view error screen',
    errorText: e ? (e.message || e.name) : String(error), shownAt: reportedAt, reportedAt, view, operation: null,
    frames: stackLocations(e?.stack, appOrigins()),
  }
}

export const CONSOLE_TAIL_LINES = 50

/** The last console lines, as the operator saw them (time, severity, source, message). */
export function readConsoleTail(): ConsoleTailSource | null {
  const events = useCamStore.getState().consoleEvents
  if (events.length === 0) return null
  const tail = events.slice(-CONSOLE_TAIL_LINES)
  return {
    total: events.length,
    lines: tail.map((e) => `${new Date(e.at).toISOString().slice(11, 19)} ${e.severity} ${e.source}: ${e.message}`),
  }
}

/** The open project as Save would write it, unsaved changes included. Read only
 *  when the operator ticks "Current project"; never written to disk here. */
export async function readCurrentProject(): Promise<Attachment | null> {
  try {
    const text = await snapshotCurrentProjectFile()
    return text === null ? null : { bytes: new TextEncoder().encode(text) }
  } catch {
    return null
  }
}

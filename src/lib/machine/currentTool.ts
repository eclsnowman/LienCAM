// WO-2878: which tool is in the spindle right now - ONE rule for every place
// the Control screen names it (position chip, TOOL glance, folded TOOL header,
// used-tool highlight, the Tools table row).
//
// Two sources speak to it:
//   - the stream: the last T word of the loaded program the controller has
//     acknowledged (job.toolChanges at or before job.ackedSourceLine);
//   - the controller's report: the store's activeTool, set by a $G parser
//     report, a guided tool change or a manual set / probe receipt.
// While a job is running or held, the stream speaks - $G is polled only
// between jobs, so activeTool lags all through a run. Outside a job, the
// NEWER of the two wins: a finished program keeps its acked cursor, and an MDI
// T3 M6 after it must read T3, not the program's last T (audit 10-16).
//
// "Newer" is an EVENT, never a value diff (audit 10-16, round 2): Measure T3
// when the store already said T3 changes no value, yet it is the newest fact.
// The store stamps every report and every stream crossing on one monotonic
// sequence (toolReportStamp / streamToolStamp); this module only compares.

import type { StreamerPhase } from './controller'
import type { MachineControlState } from '../../store/machineControlStore'

type ToolChanges = MachineControlState['job']['toolChanges']
type ToolChange = ToolChanges[number]

/** The last tool change the stream has acknowledged, or null before any. */
export function streamedToolChange(toolChanges: ToolChanges, ackedSourceLine: number): ToolChange | null {
  let found: ToolChange | null = null
  for (const tc of toolChanges) {
    if (tc.tool !== null && tc.sourceLine <= ackedSourceLine) found = tc
  }
  return found
}

/** The last T word the stream has acknowledged, or null before any. */
export function streamedTool(toolChanges: ToolChanges, ackedSourceLine: number): number | null {
  return streamedToolChange(toolChanges, ackedSourceLine)?.tool ?? null
}

/** A job is running or held: the stream is the truth. */
export function jobInFlight(phase: StreamerPhase): boolean {
  return phase === 'streaming' || phase === 'paused'
}

type CurrentToolInput = Pick<MachineControlState, 'activeTool' | 'toolReportStamp' | 'streamToolStamp'> & {
  job: Pick<MachineControlState['job'], 'phase' | 'toolChanges' | 'ackedSourceLine'>
}

/** The rule, pure: the one selector every current-tool readout uses. */
export function currentToolOf(s: CurrentToolInput): number | null {
  const streamTool = streamedTool(s.job.toolChanges, s.job.ackedSourceLine)
  if (streamTool === null) return s.activeTool
  if (jobInFlight(s.job.phase) || s.streamToolStamp > s.toolReportStamp) return streamTool
  return s.activeTool
}

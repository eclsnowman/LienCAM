// ToolGlance - the at-a-glance TOOL readout in the left column's TOOL panel
// (WO-048, from the WO-036 uix=12 prototype Operator approved): current tool,
// the program's used-tools chips in first-use order, and a Change tool
// button. Full detail stays in the Tools / Probe sub-view; the button jumps
// there via the onChangeTool callback ControlPage wires to its view state.

import { useSyncExternalStore } from 'react'
import { Replace } from 'lucide-react'
import { subscribeToolChangeHold, toolChangeHoldActive } from '../../lib/machine/machineSession'
import { controlMachine, useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useMachineToolTable } from '../../store/machineToolTableStore'
import { EMPTY_TOOL_TABLE, findTool } from '../../lib/machine/toolTable'
import { authorize } from '../../lib/machine/operatorAuthority'

/**
 * Which tool is in the spindle right now, and what the table says about it.
 *
 * Extracted for WO-184: the TOOL panel's COLLAPSED header shows the same
 * identity this glance shows expanded, and two copies of the mid-run rule
 * below would drift the moment one of them was touched.
 */
export function useCurrentTool() {
  const activeTool = useMachineControl((s) => s.activeTool)
  const toolChanges = useMachineControl((s) => s.job.toolChanges)
  const ackedLine = useMachineControl((s) => s.job.ackedSourceLine)
  const machineId = useCamStore((s) => controlMachine(s).id ?? 'default')
  const table = useMachineToolTable((s) => s.byMachine[machineId]?.table ?? EMPTY_TOOL_TABLE)

  // Mid-run the truth is the last T word the stream has passed - the
  // controller's $G tool report is only polled between jobs, so the store's
  // activeTool lags while a program is running/held.
  let programTool: number | null = null
  for (const tc of toolChanges) {
    if (tc.tool !== null && tc.sourceLine <= ackedLine) programTool = tc.tool
  }
  const currentTool = programTool ?? activeTool
  return {
    currentTool,
    entry: currentTool !== null ? findTool(table, currentTool) : undefined,
    toolChanges,
    ackedLine,
  }
}

/** The tool's table description ("6mm flat", "3mm"), or '' if it has none. */
export function toolDescription(entry: ReturnType<typeof useCurrentTool>['entry']): string {
  if (!entry) return ''
  return [entry.dia !== null ? `${entry.dia}mm` : null, entry.note || null].filter(Boolean).join(' ')
}

export function ToolGlance({ onChangeTool }: { onChangeTool: () => void }) {
  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const { currentTool, entry, toolChanges, ackedLine } = useCurrentTool()
  // WO-1979: the button only opens the Tools tab; it keeps the "Change tool"
  // wording while a guided tool change is actually running.
  const toolChangeHold = useSyncExternalStore(
    subscribeToolChangeHold,
    toolChangeHoldActive,
    () => false,
  )
  // Tools this PROGRAM uses, in first-use order (from the same scan that
  // drives tool-change holds).
  const used: number[] = []
  for (const tc of toolChanges) {
    if (tc.tool !== null && !used.includes(tc.tool)) used.push(tc.tool)
  }

  return (
    <div className="control-tool-glance" data-testid="control-tool-glance">
      <span className="control-tool-glance-label">Tool</span>
      <span className="control-tool-glance-current" data-testid="control-tool-glance-current">
        {currentTool !== null ? `T${currentTool}` : '--'}
      </span>
      {toolDescription(entry) && (
        <span className="control-tool-glance-desc">{toolDescription(entry)}</span>
      )}
      {used.length > 0 && (
        <span className="control-tool-glance-used" data-testid="control-tool-glance-used">
          <span className="control-tool-glance-usedlabel">used</span>
          {used.map((t) => {
            const change = toolChanges.find((tc) => tc.tool === t)
            const upcoming = change !== undefined && change.sourceLine > ackedLine
            return (
              <span
                key={t}
                className={`control-tool-glance-chip ${
                  t === currentTool ? 'control-tool-glance-chip-active' : ''
                }`}
                data-tooltip={
                  t === currentTool
                    ? `T${t} is in the spindle`
                    : upcoming
                      ? `T${t} comes up at line ${change.sourceLine}`
                      : `T${t} - done`
                }
              >
                T{t}
              </span>
            )
          })}
        </span>
      )}
      <button
        className="modal-btn modal-btn-ghost control-tool-glance-change"
        data-testid="control-tool-glance-change"
        disabled={authorize('toolGlance', { connected }).disabled}
        data-tooltip="Swap the tool - measurement and the full table live in Tools / Probe"
        onClick={onChangeTool}
      >
        <Replace size={13} /> {toolChangeHold ? 'Change tool' : 'Open tool table'}
      </button>
    </div>
  )
}

import { catalogChildren } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

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
import { currentToolOf } from '../../lib/machine/currentTool'

/**
 * Which tool is in the spindle right now, and what the table says about it.
 *
 * Extracted for WO-184: the TOOL panel's COLLAPSED header shows the same
 * identity this glance shows expanded, and two copies of the mid-run rule
 * below would drift the moment one of them was touched.
 */
export function useCurrentTool() {
  // Mid-run the truth is the last T word the stream has passed - the
  // controller's $G tool report is only polled between jobs, so the store's
  // activeTool lags while a program is running/held. Outside a job the newer
  // of the two wins, by event stamp (WO-2878: MDI T3 M6 or Measure T3 after a
  // finished program reads T3, even when the store already said 3).
  const currentTool = useMachineControl(currentToolOf)
  const toolChanges = useMachineControl((s) => s.job.toolChanges)
  const ackedLine = useMachineControl((s) => s.job.ackedSourceLine)
  const machineId = useCamStore((s) => controlMachine(s).id ?? 'default')
  const table = useMachineToolTable((s) => s.byMachine[machineId]?.table ?? EMPTY_TOOL_TABLE)

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
  useText('control-screens-not-probing')
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
      <span className="control-tool-glance-label">{controlText('ToolGlance.text001')}</span>
      <span className="control-tool-glance-current" data-testid="control-tool-glance-current">
        {currentTool !== null ? `T${currentTool}` : '--'}
      </span>
      {toolDescription(entry) && (
        <span className="control-tool-glance-desc">{toolDescription(entry)}</span>
      )}
      {used.length > 0 && (
        <span className="control-tool-glance-used" data-testid="control-tool-glance-used">
          <span className="control-tool-glance-usedlabel">{controlText('ToolGlance.text002')}</span>
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
                    ? controlText('ToolGlance.text004', { value1: String(t) })
                    : upcoming
                      ? controlText('ToolGlance.text005', { value1: String(t), value2: String(change.sourceLine) })
                      : controlText('ToolGlance.text006', { value1: String(t) })
                }
              >{catalogChildren(controlText('ToolGlance.text003', { value1: '\u0000value1\u0000' }), { value1: t })}</span>
            )
          })}
        </span>
      )}
      <button
        className="modal-btn modal-btn-ghost control-tool-glance-change"
        data-testid="control-tool-glance-change"
        disabled={authorize('toolGlance', { connected }).disabled}
        data-tooltip={controlText('ToolGlance.text007')}
        onClick={onChangeTool}
      >
        <Replace size={13} /> {toolChangeHold ? controlText('ToolGlance.text008') : controlText('ToolGlance.text009')}
      </button>
    </div>
  )
}

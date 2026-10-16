import { catalogChildren } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import { fmtMachineLength, unitLabel } from '../../lib/ui/unitFormat'
import { useDisplayUnits } from './useDisplayUnits'
// SimulatedPartPanel - WO-416: a small read-only card on the Diagnostics
// sub-tab, shown ONLY while the connected transport is the built-in
// simulator, naming the virtual part G38.2 probes against (position, size,
// bore, boss, surface bow) and two plain-word actions: "Place under probe"
// (slides the part so its bore centre sits under the probe's current XY,
// nothing moves on the machine) and "Reset" (back to the default
// placement). Presentational - all state lives in the connected
// SimulatedGrblTransport via machineSession's thin pass-through; this
// component just mirrors it locally so the numbers redraw after an action.

import { useEffect, useState } from 'react'
import { useMachineControl } from '../../store/machineControlStore'
import {
  buildDefaultSimulatedPart,
  getSimulatedPart,
  setSimulatedPart,
  type SimulatedPart,
} from '../../lib/machine/machineSession'

export function SimulatedPartPanel() {
  useText('control-screens-not-probing')
  const units = useDisplayUnits()
  const fmt = (mm: number): string => Number.isFinite(mm) ? `${fmtMachineLength(mm, units)} ${unitLabel(units)}` : '-'
  const connectionKind = useMachineControl((s) => s.connectionKind)
  const mpos = useMachineControl((s) => s.mpos)
  const [part, setPart] = useState<SimulatedPart | null>(null)

  // Re-sync from the transport whenever the simulator (re)connects; the
  // first time this card is seen with nothing placed yet, seed the default
  // part so there is something to probe against without an extra click.
  useEffect(() => {
    if (connectionKind !== 'simulator') {
      setPart(null)
      return
    }
    const existing = getSimulatedPart()
    if (existing) {
      setPart(existing)
      return
    }
    const seeded = buildDefaultSimulatedPart()
    setSimulatedPart(seeded)
    setPart(seeded)
  }, [connectionKind])

  if (connectionKind !== 'simulator') return null

  const applyAndShow = (next: SimulatedPart) => {
    setSimulatedPart(next)
    setPart(next)
  }

  const reset = () => applyAndShow(buildDefaultSimulatedPart())

  const placeUnderProbe = () => {
    if (!part || !mpos) return
    const boreCx = part.bore?.cx ?? part.origin.x + part.sizeX / 2
    const boreCy = part.bore?.cy ?? part.origin.y + part.sizeY / 2
    const dx = mpos.x - boreCx
    const dy = mpos.y - boreCy
    applyAndShow({
      ...part,
      origin: { x: part.origin.x + dx, y: part.origin.y + dy },
      bore: part.bore ? { ...part.bore, cx: part.bore.cx + dx, cy: part.bore.cy + dy } : part.bore,
      boss: part.boss ? { ...part.boss, cx: part.boss.cx + dx, cy: part.boss.cy + dy } : part.boss,
    })
  }

  return (
    <section className="panel control-panel" data-testid="simulated-part-panel">
      <div className="panel-header">
        <span className="panel-title">{controlText('SimulatedPartPanel.text001')}</span>
      </div>
      <div className="panel-body" data-testid="simulated-part-body">
        {!part ? (
          <div className="panel-empty">{controlText('SimulatedPartPanel.text002')}</div>
        ) : (
          <>
            <div data-testid="simulated-part-position">{catalogChildren(controlText('SimulatedPartPanel.text003', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000' }), { value1: fmt(part.origin.x), value2: fmt(part.origin.y), value3: fmt(part.topZ) })}</div>
            <div data-testid="simulated-part-size">{catalogChildren(controlText('SimulatedPartPanel.text004', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000' }), { value1: fmt(part.sizeX), value2: fmt(part.sizeY), value3: fmt(part.height) })}</div>
            <div data-testid="simulated-part-bow">{catalogChildren(controlText('SimulatedPartPanel.text005', { value1: '\u0000value1\u0000' }), { value1: fmt(part.bowMm ?? 0.3) })}</div>
            {part.bore && (
              <div data-testid="simulated-part-bore">{catalogChildren(controlText('SimulatedPartPanel.text006', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000', value4: '\u0000value4\u0000' }), { value1: fmt(part.bore.diameter), value2: fmt(part.bore.depth), value3: fmt(part.bore.cx), value4: fmt(part.bore.cy) })}</div>
            )}
            {part.boss && (
              <div data-testid="simulated-part-boss">{catalogChildren(controlText('SimulatedPartPanel.text007', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000', value4: '\u0000value4\u0000' }), { value1: fmt(part.boss.diameter), value2: fmt(part.boss.height), value3: fmt(part.boss.cx), value4: fmt(part.boss.cy) })}</div>
            )}
          </>
        )}
        <div className="control-simulated-part-actions">
          <button
            type="button"
            className="panel-action-btn"
            data-testid="simulated-part-place-under-probe"
            disabled={!part || !mpos}
            onClick={placeUnderProbe}
            data-tooltip={controlText('SimulatedPartPanel.text008')}
          >{controlText('SimulatedPartPanel.text009')}</button>
          <button
            type="button"
            className="panel-action-btn"
            data-testid="simulated-part-reset"
            onClick={reset}
            data-tooltip={controlText('SimulatedPartPanel.text010')}
          >{controlText('SimulatedPartPanel.text011')}</button>
        </div>
      </div>
    </section>
  )
}

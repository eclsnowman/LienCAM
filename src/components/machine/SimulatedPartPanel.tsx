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
        <span className="panel-title">Simulated part</span>
      </div>
      <div className="panel-body" data-testid="simulated-part-body">
        {!part ? (
          <div className="panel-empty">No part placed.</div>
        ) : (
          <>
            <div data-testid="simulated-part-position">
              Position (machine): X {fmt(part.origin.x)}, Y {fmt(part.origin.y)}, top Z {fmt(part.topZ)}
            </div>
            <div data-testid="simulated-part-size">
              Size: {fmt(part.sizeX)} (X) x {fmt(part.sizeY)} (Y) x {fmt(part.height)} (height)
            </div>
            <div data-testid="simulated-part-bow">Surface bow: {fmt(part.bowMm ?? 0.3)}</div>
            {part.bore && (
              <div data-testid="simulated-part-bore">
                Bore: {fmt(part.bore.diameter)} diameter, {fmt(part.bore.depth)} deep, centre X {fmt(part.bore.cx)} Y {fmt(part.bore.cy)}
              </div>
            )}
            {part.boss && (
              <div data-testid="simulated-part-boss">
                Boss: {fmt(part.boss.diameter)} diameter, {fmt(part.boss.height)} tall, centre X {fmt(part.boss.cx)} Y {fmt(part.boss.cy)}
              </div>
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
            data-tooltip="Move the part so the probe's current position sits over the bore centre, at the part's top"
          >
            Place under probe
          </button>
          <button
            type="button"
            className="panel-action-btn"
            data-testid="simulated-part-reset"
            onClick={reset}
            data-tooltip="Put the part back at its default position and size"
          >
            Reset
          </button>
        </div>
      </div>
    </section>
  )
}

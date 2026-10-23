import { useCamStore } from '../../store'
import { HOLDING_METHODS, isHoldingMethodId } from '../../lib/workholding/holdingMethods'
import type { Setup } from '../../types'

/** WO-2438: how this setup's stock is held - a method picker and the setup's notes
 *  (labelled "Setup notes", the same notes Control's Setup notes panel shows - WO-3079).
 *  Both go through updateSetup, which outdates nothing for these fields. */
export function SetupHoldingEditor({ setup }: { setup: Setup }) {
  const updateSetup = useCamStore((s) => s.updateSetup)
  return (
    <>
      <div className="props-group">
        <div className="props-label">Holding method</div>
        <div className="props-value">
          <select
            className="props-select"
            data-testid="setup-holding-method"
            aria-label="Holding method"
            value={setup.holdingMethod ?? ''}
            onChange={(e) => {
              const v = e.currentTarget.value
              updateSetup(setup.id, { holdingMethod: isHoldingMethodId(v) ? v : undefined })
            }}
          >
            <option value="">None</option>
            {HOLDING_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      </div>
      <div className="props-group" style={{ alignItems: 'flex-start' }}>
        <div className="props-label">Setup notes</div>
        <div className="props-value">
          <textarea
            key={`${setup.id}:${setup.notes ?? ''}`}
            className="props-text-input"
            data-testid="setup-holding-note"
            aria-label="Setup notes"
            rows={3}
            defaultValue={setup.notes ?? ''}
            onBlur={(e) => {
              if (e.currentTarget.value !== (setup.notes ?? '')) updateSetup(setup.id, { notes: e.currentTarget.value })
            }}
          />
        </div>
      </div>
    </>
  )
}

import { NumericInput, OptionalNumericInput } from '../../../../ui/NumericInput'
import { machineSafeZ, withMachineSafeZ, type AxisName } from '../../../../../types'
import { SkewField } from '../../SkewField'
import type { MachineDefinitionPanelState } from '../../useMachineDefinitionPanel'

// WO-1696 step 3 (v2/SLICES.md T13) - where is home: the homing order, each
// enabled axis's homing direction, gantry skew and safe Z. The rest of
// WO-1690's homing detail (fast speed, back-off, zero-after-homing) stays on
// the Machine area's drawer - reachable there after this step, never a
// second editor here.

type Step3Props = Pick<MachineDefinitionPanelState,
  | 'draft' | 'editDraft' | 'order' | 'setHomingOrderAt' | 'patchHoming' | 'defineHoming'
  | 'enabledAxes' | 'skewTyped' | 'setSkewTyped'
> & { def: NonNullable<MachineDefinitionPanelState['def']> }

export function Step3WhereIsHome({
  def, draft, editDraft, order, setHomingOrderAt, patchHoming, defineHoming, enabledAxes,
  skewTyped, setSkewTyped,
}: Step3Props) {
  const safeZ = machineSafeZ(draft)
  return (
    <div data-testid="setup-step-home" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 480 }}>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>Where is home, and in what order?</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="mform-label">Home order</span>
        {order.map((ax, i) => (
          <select
            key={`${ax}-${i}`}
            className="mform-select"
            aria-label={`Homing order position ${i + 1}`}
            data-testid={`setup-step-home-order-${i}`}
            style={{ flex: 'none', width: 56 }}
            value={ax}
            onChange={(e) => setHomingOrderAt(i, e.target.value as AxisName)}
          >
            {Array.from(new Set<AxisName>([...enabledAxes.map((a) => a.axis), ax]))
              .map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        ))}
        {order.length === 0 && (
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>no axes enabled</span>
        )}
      </div>

      <table className="mform-axis-table" data-testid="setup-step-home-table" style={{ width: 'auto' }}>
        <thead><tr><th>Axis</th><th>homes toward</th></tr></thead>
        <tbody>
          {enabledAxes.map((a) => {
            const h = def.homing.perAxis[a.axis]
            return (
              <tr key={a.axis} data-testid={`setup-step-home-${a.axis}`}>
                <td>{a.axis}</td>
                <td>
                  {h ? (
                    <select
                      className="mform-select"
                      aria-label={`${a.axis} homing direction`}
                      data-testid={`setup-step-home-direction-${a.axis}`}
                      style={{ width: 80 }}
                      value={h.direction}
                      onChange={(e) => patchHoming(a.axis, { direction: e.target.value as 'negative' | 'positive' })}
                    >
                      <option value="negative">At min</option>
                      <option value="positive">At max</option>
                    </select>
                  ) : (
                    <button
                      type="button"
                      className="control-chip-btn"
                      data-testid={`setup-step-home-define-${a.axis}`}
                      onClick={() => defineHoming(a.axis)}
                    >
                      Define {a.axis} homing
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <SkewField machine={draft} typed={skewTyped} onTyped={setSkewTyped} onChange={editDraft} standalone />

      <label
        className="mform-label"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
      >
        <span>Safe Z</span>
        {safeZ?.from === 'profile' ? (
          <NumericInput
            value={safeZ.z}
            ariaLabel="Safe Z"
            className="mform-input mform-input-mono"
            style={{ flex: 'none', width: 78 }}
            onChange={(v) => editDraft((m) => withMachineSafeZ(m, v))}
          />
        ) : (
          <OptionalNumericInput
            value={safeZ?.z}
            ariaLabel="Safe Z"
            className="mform-input mform-input-mono"
            style={{ flex: 'none', width: 78 }}
            onChange={(v) => editDraft((m) => withMachineSafeZ(m, v ?? null))}
          />
        )}
        {safeZ === null && (
          <span data-testid="setup-step-home-safe-z-unset" style={{ color: 'var(--text-muted)' }}>not stated</span>
        )}
      </label>
    </div>
  )
}

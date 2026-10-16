import { catalogChildren } from '../../catalogText'
import { textFor, useText } from '../../../../../i18n'
const controlText = textFor('control-screens-not-probing')

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
  useText('control-screens-not-probing')
  const safeZ = machineSafeZ(draft)
  return (
    <div data-testid="setup-step-home" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 480 }}>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{controlText('Step3WhereIsHome.text001')}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="mform-label">{controlText('Step3WhereIsHome.text002')}</span>
        {order.map((ax, i) => (
          <select
            key={`${ax}-${i}`}
            className="mform-select"
            aria-label={controlText('Step3WhereIsHome.text003', { value1: String(i + 1) })}
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
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('Step3WhereIsHome.text004')}</span>
        )}
      </div>

      <table className="mform-axis-table" data-testid="setup-step-home-table" style={{ width: 'auto' }}>
        <thead><tr><th>{controlText('Step3WhereIsHome.text005')}</th><th>{controlText('Step3WhereIsHome.text006')}</th></tr></thead>
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
                      aria-label={controlText('Step3WhereIsHome.text007', { value1: String(a.axis) })}
                      data-testid={`setup-step-home-direction-${a.axis}`}
                      style={{ width: 80 }}
                      value={h.direction}
                      onChange={(e) => patchHoming(a.axis, { direction: e.target.value as 'negative' | 'positive' })}
                    >
                      <option value="negative">{controlText('Step3WhereIsHome.text008')}</option>
                      <option value="positive">{controlText('Step3WhereIsHome.text009')}</option>
                    </select>
                  ) : (
                    <button
                      type="button"
                      className="control-chip-btn"
                      data-testid={`setup-step-home-define-${a.axis}`}
                      onClick={() => defineHoming(a.axis)}
                    >{catalogChildren(controlText('Step3WhereIsHome.text010', { value1: '\u0000value1\u0000' }), { value1: a.axis })}</button>
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
        <span>{controlText('Step3WhereIsHome.text011')}</span>
        {safeZ?.from === 'profile' ? (
          <NumericInput
            value={safeZ.z}
            ariaLabel={controlText('Step3WhereIsHome.text012')}
            className="mform-input mform-input-mono"
            style={{ flex: 'none', width: 78 }}
            onChange={(v) => editDraft((m) => withMachineSafeZ(m, v))}
          />
        ) : (
          <OptionalNumericInput
            value={safeZ?.z}
            ariaLabel={controlText('Step3WhereIsHome.text013')}
            className="mform-input mform-input-mono"
            style={{ flex: 'none', width: 78 }}
            onChange={(v) => editDraft((m) => withMachineSafeZ(m, v ?? null))}
          />
        )}
        {safeZ === null && (
          <span data-testid="setup-step-home-safe-z-unset" style={{ color: 'var(--text-muted)' }}>{controlText('Step3WhereIsHome.text014')}</span>
        )}
      </label>
    </div>
  )
}

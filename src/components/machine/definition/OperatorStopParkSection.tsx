import { OptionalNumericInput } from '../../ui/NumericInput'
import { withOperatorStopParkAxis, workholdingStopPark } from '../../../lib/machine/macros/clampPauseMacro'
import type { MachineConfig } from '../../../types'

/** WO-2437: WHERE AN OPERATOR STOP PARKS - the machine's own setting (Operator ruling
 * 2026-10-02: "User setable"), beside the G30 points. The posted stop and
 * Control's clamp pause both read it; a blank field means the machine's Park 1,
 * shown as the placeholder. */
export function OperatorStopParkSection({ machine, onChange }: {
  machine: MachineConfig
  onChange: (mut: (machine: MachineConfig) => MachineConfig) => void
}) {
  const set = machine.operatorStopPark ?? null
  const fallback = workholdingStopPark({ ...machine, operatorStopPark: null }, undefined)
  return (
    <div data-testid="machine-def-operator-stop-park" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 'var(--font-size-sm)' }}>Operator stop park</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>
          Machine coordinates (mm). Where an operator stop parks{fallback ? `; blank uses "${fallback.label}"` : ''}.
        </span>
      </div>
      <table className="machine-def-table">
        <thead><tr><th>X</th><th>Y</th><th>Z</th></tr></thead>
        <tbody>
          <tr>
            {(['x', 'y', 'z'] as const).map((axis) => {
              const shown = fallback?.[axis]
              return (
                <td key={axis} data-drives-this-app="">
                  <OptionalNumericInput
                    value={set?.[axis]}
                    step={0.1}
                    placeholder={typeof shown === 'number' && Number.isFinite(shown) ? String(shown) : undefined}
                    ariaLabel={`Operator stop park ${axis.toUpperCase()} machine coordinate`}
                    className="mform-input mform-input-mono"
                    style={{ width: 90 }}
                    onChange={(value) => onChange((current) => withOperatorStopParkAxis(current, axis, value ?? null))}
                  />
                </td>
              )
            })}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

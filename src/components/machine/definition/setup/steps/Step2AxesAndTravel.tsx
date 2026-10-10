import { AXIS_NAMES } from '../../../../../types'
import { DefNumber } from '../../DefinitionFields'
import { StepsPerMm } from '../StepsPerMm'
import type { MachineDefinitionPanelState } from '../../useMachineDefinitionPanel'

// WO-1696 step 2 (v2/SLICES.md T13) - the axis table WO-1690's Machine area
// draws, trimmed to what this step asks: which axes exist, their steps per
// unit, and how far each may travel. Pins, homing and the drawer belong to
// step 3 and to the Machine area itself - this step edits the SAME fields
// through the SAME callbacks (`patchAxis`, `patchAxisSoftLimit`,
// `toggleAxisEnabled`), never a second copy of the record.
//
// WO-1697 (v2/SLICES.md T14) - "work it out": a popover beside the steps/mm
// box, one per axis. It writes through the SAME `patchAxis(name, {
// stepsPerUnit: v })` callback the box above calls directly - one field, two
// ways in, never a second writer.

type Step2Props = Pick<MachineDefinitionPanelState, 'draft' | 'patchAxis' | 'patchAxisSoftLimit' | 'toggleAxisEnabled'> & {
  def: NonNullable<MachineDefinitionPanelState['def']>
}

export function Step2AxesAndTravel({ def, patchAxis, patchAxisSoftLimit, toggleAxisEnabled }: Step2Props) {
  return (
    <div data-testid="setup-step-axes">
      <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)' }}>
        Which axes does this machine have, and how far may each travel?
      </p>
      <table className="mform-axis-table" data-testid="setup-step-axes-table" style={{ width: 'auto' }}>
        <thead>
          <tr>
            <th>Axis</th>
            <th>steps/mm</th>
            <th></th>
            <th>travel from</th>
            <th>travel to</th>
          </tr>
        </thead>
        <tbody>
          {AXIS_NAMES.map((name) => {
            const a = def.axes.find((x) => x.axis === name)
            if (!a) {
              return (
                <tr key={name} data-testid={`setup-step-axes-absent-${name}`}>
                  <td>{name}</td>
                  <td colSpan={4} style={{ color: 'var(--text-muted)' }}>not carried in this record</td>
                </tr>
              )
            }
            return (
              <tr key={name} data-testid={`setup-step-axes-${name}`}>
                <td>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="checkbox"
                      aria-label={`${name} axis enabled`}
                      data-testid={`setup-step-axes-enabled-${name}`}
                      checked={a.enabled}
                      onChange={(e) => toggleAxisEnabled(name, e.target.checked)}
                      style={{ margin: 0 }}
                    />
                    {name}
                  </label>
                </td>
                <td>
                  <DefNumber
                    label="" name={`${name} steps per unit`} width={78}
                    value={a.stepsPerUnit} min={0} step={10}
                    onChange={(v) => patchAxis(name, { stepsPerUnit: v })}
                  />
                </td>
                <td>
                  <StepsPerMm onChange={(v) => patchAxis(name, { stepsPerUnit: v })} />
                </td>
                <td>
                  <DefNumber
                    label="" name={`${name} soft limit minimum`} width={72}
                    value={a.softLimitMin} step={1}
                    onChange={(v) => patchAxisSoftLimit(name, 'min', v)}
                  />
                </td>
                <td>
                  <DefNumber
                    label="" name={`${name} soft limit maximum`} width={72}
                    value={a.softLimitMax} step={1}
                    onChange={(v) => patchAxisSoftLimit(name, 'max', v)}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

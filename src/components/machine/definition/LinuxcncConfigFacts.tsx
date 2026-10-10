import type { LinuxcncConfig } from '../../../lib/machine/linuxcnc/linuxcncController'

// WO-2097: the facts in LinuxCNC's own INI/HAL, as the gateway read them for
// this session (hello.config), shown in LinuxCNC's own terms - INI section and
// key names, the INI's own strings and units, HAL pin and signal names. A key
// the INI does not set says so; nothing is converted, defaulted or invented.

const NOT_SET = 'not set'

function withUnits(value: string | null, units: string | null, perSecond = false): string {
  if (value === null) return NOT_SET
  if (!units) return value
  return `${value} ${units}${perSecond ? '/s' : ''}`
}

const GROUP_LABEL: Record<string, string> = {
  probe: 'Probe',
  estop: 'E-STOP chain',
  coolant: 'Coolant',
  spindle: 'Spindle',
}

const noteStyle = { marginTop: 6, color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' } as const
const headingStyle = { marginTop: 14, marginBottom: 4, fontWeight: 600, color: 'var(--text-primary)' } as const
// Cells read as columns: without spacing "E-STOP chain" ran into its pin name.
const tableStyle = { borderCollapse: 'separate', borderSpacing: '18px 2px', marginLeft: -18, textAlign: 'left' } as const

export function LinuxcncConfigFacts({ config }: { config: LinuxcncConfig | null }) {
  if (!config) {
    return (
      <div data-testid="machine-controller-gateway-config-absent" style={noteStyle}>
        This gateway does not send LinuxCNC's INI/HAL facts (axis limits, spindle RPM range, I/O links).
        Update gateway.py on the LinuxCNC PC to show them here.
      </div>
    )
  }
  return (
    <div data-testid="machine-controller-gateway-config">
      <div style={headingStyle}>Axes (INI [AXIS_*])</div>
      <table className="machine-def-table" data-testid="machine-controller-gateway-axes" style={tableStyle}>
        <thead><tr><th>Axis</th><th>MIN_LIMIT</th><th>MAX_LIMIT</th><th>MAX_VELOCITY</th></tr></thead>
        <tbody>
          {config.axes.map((axis) => (
            <tr key={axis.axis} data-testid={`machine-controller-gateway-axis-${axis.axis}`}>
              <th scope="row">{axis.axis}</th>
              <td>{withUnits(axis.minLimit, axis.units)}</td>
              <td>{withUnits(axis.maxLimit, axis.units)}</td>
              <td>{withUnits(axis.maxVelocity, axis.units, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={headingStyle}>Spindle RPM range (INI [SPINDLE_*])</div>
      <table className="machine-def-table" data-testid="machine-controller-gateway-spindles" style={tableStyle}>
        <thead>
          <tr>
            <th>Spindle</th><th>MIN_FORWARD_VELOCITY</th><th>MAX_FORWARD_VELOCITY</th>
            <th>MIN_REVERSE_VELOCITY</th><th>MAX_REVERSE_VELOCITY</th>
          </tr>
        </thead>
        <tbody>
          {config.spindles.map((spindle) => (
            <tr key={spindle.spindle} data-testid={`machine-controller-gateway-spindle-${spindle.spindle}`}>
              <th scope="row">{spindle.spindle}</th>
              <td>{withUnits(spindle.minForwardVelocity, 'rpm')}</td>
              <td>{withUnits(spindle.maxForwardVelocity, 'rpm')}</td>
              <td>{withUnits(spindle.minReverseVelocity, 'rpm')}</td>
              <td>{withUnits(spindle.maxReverseVelocity, 'rpm')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={headingStyle}>I/O (running HAL)</div>
      {!config.io.read ? (
        <div data-testid="machine-controller-gateway-io-unread" style={noteStyle}>
          {config.io.error ?? 'The gateway could not read the running HAL.'}
        </div>
      ) : (
        <table className="machine-def-table" data-testid="machine-controller-gateway-io" style={tableStyle}>
          <thead><tr><th></th><th>Pin</th><th>Signal</th><th>Linked to</th></tr></thead>
          <tbody>
            {config.io.pins.map((pin) => (
              <tr key={pin.pin} data-testid={`machine-controller-gateway-io-${pin.pin}`}>
                <td>{GROUP_LABEL[pin.group] ?? pin.group}</td>
                <td className="mform-input-mono">{pin.pin}{pin.dir ? ` (${pin.dir})` : ''}</td>
                <td className="mform-input-mono">{!pin.inHal ? 'not in HAL' : pin.signal ?? 'not linked'}</td>
                <td className="mform-input-mono">
                  {pin.linked.length === 0 ? '-' : pin.linked.map((end) => `${end.arrow} ${end.pin}`).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

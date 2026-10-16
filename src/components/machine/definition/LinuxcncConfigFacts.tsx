import { liveCatalog } from './catalogText'
import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import type { LinuxcncConfig } from '../../../lib/machine/linuxcnc/linuxcncController'

// WO-2097: the facts in LinuxCNC's own INI/HAL, as the gateway read them for
// this session (hello.config), shown in LinuxCNC's own terms - INI section and
// key names, the INI's own strings and units, HAL pin and signal names. A key
// the INI does not set says so; nothing is converted, defaulted or invented.

const NOT_SET = controlText('LinuxcncConfigFacts.text001')

function withUnits(value: string | null, units: string | null, perSecond = false): string {
  if (value === null) return NOT_SET
  if (!units) return value
  return `${value} ${units}${perSecond ? '/s' : ''}`
}

const GROUP_LABEL: Record<string, string> = liveCatalog(() => ({
  probe: controlText('LinuxcncConfigFacts.text002'),
  estop: controlText('LinuxcncConfigFacts.text003'),
  coolant: controlText('LinuxcncConfigFacts.text004'),
  spindle: controlText('LinuxcncConfigFacts.text005'),
}))

const noteStyle = { marginTop: 6, color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' } as const
const headingStyle = { marginTop: 14, marginBottom: 4, fontWeight: 600, color: 'var(--text-primary)' } as const
// Cells read as columns: without spacing "E-STOP chain" ran into its pin name.
const tableStyle = { borderCollapse: 'separate', borderSpacing: '18px 2px', marginLeft: -18, textAlign: 'left' } as const

export function LinuxcncConfigFacts({ config }: { config: LinuxcncConfig | null }) {
  useText('control-screens-not-probing')
  if (!config) {
    return (
      <div data-testid="machine-controller-gateway-config-absent" style={noteStyle}>{controlText('LinuxcncConfigFacts.text006')}</div>
    )
  }
  return (
    <div data-testid="machine-controller-gateway-config">
      <div style={headingStyle}>{controlText('LinuxcncConfigFacts.text007')}</div>
      <table className="machine-def-table" data-testid="machine-controller-gateway-axes" style={tableStyle}>
        <thead><tr><th>{controlText('LinuxcncConfigFacts.text008')}</th><th>{controlText('LinuxcncConfigFacts.text009')}</th><th>{controlText('LinuxcncConfigFacts.text010')}</th><th>{controlText('LinuxcncConfigFacts.text011')}</th></tr></thead>
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

      <div style={headingStyle}>{controlText('LinuxcncConfigFacts.text012')}</div>
      <table className="machine-def-table" data-testid="machine-controller-gateway-spindles" style={tableStyle}>
        <thead>
          <tr>
            <th>{controlText('LinuxcncConfigFacts.text013')}</th><th>{controlText('LinuxcncConfigFacts.text014')}</th><th>{controlText('LinuxcncConfigFacts.text015')}</th>
            <th>{controlText('LinuxcncConfigFacts.text016')}</th><th>{controlText('LinuxcncConfigFacts.text017')}</th>
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

      <div style={headingStyle}>{controlText('LinuxcncConfigFacts.text018')}</div>
      {!config.io.read ? (
        <div data-testid="machine-controller-gateway-io-unread" style={noteStyle}>
          {config.io.error ?? controlText('LinuxcncConfigFacts.text019')}
        </div>
      ) : (
        <table className="machine-def-table" data-testid="machine-controller-gateway-io" style={tableStyle}>
          <thead><tr><th></th><th>{controlText('LinuxcncConfigFacts.text020')}</th><th>{controlText('LinuxcncConfigFacts.text021')}</th><th>{controlText('LinuxcncConfigFacts.text022')}</th></tr></thead>
          <tbody>
            {config.io.pins.map((pin) => (
              <tr key={pin.pin} data-testid={`machine-controller-gateway-io-${pin.pin}`}>
                <td>{GROUP_LABEL[pin.group] ?? pin.group}</td>
                <td className="mform-input-mono">{pin.pin}{pin.dir ? ` (${pin.dir})` : ''}</td>
                <td className="mform-input-mono">{!pin.inHal ? controlText('LinuxcncConfigFacts.text023') : pin.signal ?? controlText('LinuxcncConfigFacts.text024')}</td>
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

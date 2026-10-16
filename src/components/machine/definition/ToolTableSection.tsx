import { catalogChildren, liveCatalog } from './catalogText'
import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

// ToolTableSection - THE TOOL TABLE, PROBE OVERRIDES AND M-CODE OVERRIDES,
// shown on the machine record itself (WO-1676).
//
// These are edited live on the Control page (the Tools/Probe panel measures
// and stars tools and edits the probe cycle; the Machine actions modal edits
// the M-code overrides) - this section is the definition editor's OWN VIEW of
// what a machine currently carries, so an operator reviewing or about to
// export a machine can see all three without leaving the Library modal. It is
// deliberately read-only: a second place to edit the same fields is a second
// source of truth for how to edit them, not for what they hold.

import { machineProbeOverride, machineToolTable, type MachineToolTable } from '../../../lib/machine/toolTable'
import { BUILTIN_ACTION_LABELS, machineActionOverride, type BuiltinActionId } from '../../../lib/machine/machineActions'
import { fmtDim, fmtMachineLength, fmtFeed, unitLabel } from '../../../lib/ui/unitFormat'
import type { Units } from '../../../lib/ui/unitFormat'
import type { MachineConfig } from '../../../types'

const PROBE_OVERRIDE_FIELDS: Array<[string, keyof NonNullable<ReturnType<typeof machineProbeOverride>>, 'dim' | 'feed']> = liveCatalog(() => ([
  [controlText('ToolTableSection.text001'), 'positioningFeed', 'feed'],
  [controlText('ToolTableSection.text002'), 'fastFeed', 'feed'],
  [controlText('ToolTableSection.text003'), 'slowFeed', 'feed'],
  [controlText('ToolTableSection.text004'), 'retract', 'dim'],
  [controlText('ToolTableSection.text005'), 'maxTravel', 'dim'],
  [controlText('ToolTableSection.text006'), 'surfaceClearance', 'dim'],
  [controlText('ToolTableSection.text007'), 'overtravel', 'dim'],
  [controlText('ToolTableSection.text008'), 'crossOverLift', 'dim'],
  [controlText('ToolTableSection.text009'), 'padThickness', 'dim'],
]))

function ToolTableRows({ table, units }: { table: MachineToolTable; units: Units }) {
  useText('control-screens-not-probing')
  if (table.tools.length === 0) {
    return <div className="mform-hint" data-testid="machine-def-tooltable-none">{controlText('ToolTableSection.text010')}</div>
  }
  return (
    <table className="mform-axis-table" data-testid="machine-def-tooltable-table">
      <thead>
        <tr><th>{controlText('ToolTableSection.text011')}</th><th>{controlText('ToolTableSection.text012')}</th><th>{catalogChildren(controlText('ToolTableSection.text013', { value1: '\u0000value1\u0000' }), { value1: unitLabel(units) })}</th><th>{controlText('ToolTableSection.text014')}</th><th>{controlText('ToolTableSection.text015')}</th></tr>
      </thead>
      <tbody>
        {table.tools.map((t) => (
          <tr key={t.tool} data-testid={`machine-def-tooltable-row-${t.tool}`}>
            <td>{table.reference === t.tool ? controlText('ToolTableSection.text016') : ''}</td>
            <td>{catalogChildren(controlText('ToolTableSection.text017', { value1: '\u0000value1\u0000' }), { value1: t.tool })}</td>
            <td>{t.probedMachineZ === null ? '-' : fmtMachineLength(t.probedMachineZ, units)}</td>
            <td>{t.dia === null ? '-' : fmtDim(t.dia, units)}</td>
            <td>{t.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ProbeOverrideRows({ machine, units }: { machine: MachineConfig; units: Units }) {
  useText('control-screens-not-probing')
  const override = machineProbeOverride(machine) ?? {}
  const entries = PROBE_OVERRIDE_FIELDS.filter(([, key]) => override[key] !== undefined)
  if (entries.length === 0) {
    return <div className="mform-hint" data-testid="machine-def-probeoverride-none">{controlText('ToolTableSection.text018')}</div>
  }
  return (
    <div data-testid="machine-def-probeoverride-list">
      {entries.map(([label, key, kind]) => {
        const value = override[key]!
        return (
          <div className="mform-row" key={key} data-testid={`machine-def-probeoverride-${key}`}>
            <span className="mform-label">{label}</span>
            <span className="mform-hint">{kind === 'feed' ? fmtFeed(value, units) : fmtMachineLength(value, units)}</span>
          </div>
        )
      })}
    </div>
  )
}

function ActionOverrideRows({ machine }: { machine: MachineConfig }) {
  useText('control-screens-not-probing')
  const overrides = machineActionOverride(machine) ?? {}
  const ids = (Object.keys(overrides) as BuiltinActionId[]).filter((id) => overrides[id] !== undefined)
  if (ids.length === 0) {
    return <div className="mform-hint" data-testid="machine-def-actionoverride-none">{controlText('ToolTableSection.text019')}</div>
  }
  return (
    <div data-testid="machine-def-actionoverride-list">
      {ids.map((id) => (
        <div className="mform-row" key={id} data-testid={`machine-def-actionoverride-${id}`}>
          <span className="mform-label">{BUILTIN_ACTION_LABELS[id]}</span>
          <span className="mform-hint mform-input-mono">{overrides[id]!.join(' / ')}</span>
        </div>
      ))}
    </div>
  )
}

export function ToolTableSection({ machine, units }: { machine: MachineConfig; units: Units }) {
  useText('control-screens-not-probing')
  const table = machineToolTable(machine)
  return (
    <div data-testid="machine-def-tooltable-section">
      <ToolTableRows table={table} units={units} />
      <div className="mform-hint" style={{ marginTop: 8, marginBottom: 2 }}>{controlText('ToolTableSection.text020')}</div>
      <ProbeOverrideRows machine={machine} units={units} />
      <div className="mform-hint" style={{ marginTop: 8, marginBottom: 2 }}>{controlText('ToolTableSection.text021')}</div>
      <ActionOverrideRows machine={machine} />
    </div>
  )
}

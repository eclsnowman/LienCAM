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

const PROBE_OVERRIDE_FIELDS: Array<[string, keyof NonNullable<ReturnType<typeof machineProbeOverride>>, 'dim' | 'feed']> = [
  ['Clear positioning', 'positioningFeed', 'feed'],
  ['Search speed', 'fastFeed', 'feed'],
  ['Probe speed', 'slowFeed', 'feed'],
  ['Retract / step-off', 'retract', 'dim'],
  ['Maximum search', 'maxTravel', 'dim'],
  ['Surface clearance', 'surfaceClearance', 'dim'],
  ['Search overtravel', 'overtravel', 'dim'],
  ['Boss cross-over lift', 'crossOverLift', 'dim'],
  ['Probe pad thickness', 'padThickness', 'dim'],
]

function ToolTableRows({ table, units }: { table: MachineToolTable; units: Units }) {
  if (table.tools.length === 0) {
    return <div className="mform-hint" data-testid="machine-def-tooltable-none">No tools measured yet.</div>
  }
  return (
    <table className="mform-axis-table" data-testid="machine-def-tooltable-table">
      <thead>
        <tr><th>Ref</th><th>Tool</th><th>Pad Z ({unitLabel(units)})</th><th>Dia</th><th>Note</th></tr>
      </thead>
      <tbody>
        {table.tools.map((t) => (
          <tr key={t.tool} data-testid={`machine-def-tooltable-row-${t.tool}`}>
            <td>{table.reference === t.tool ? 'Yes' : ''}</td>
            <td>T{t.tool}</td>
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
  const override = machineProbeOverride(machine) ?? {}
  const entries = PROBE_OVERRIDE_FIELDS.filter(([, key]) => override[key] !== undefined)
  if (entries.length === 0) {
    return <div className="mform-hint" data-testid="machine-def-probeoverride-none">No probe overrides - this machine uses its own defaults above.</div>
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
  const overrides = machineActionOverride(machine) ?? {}
  const ids = (Object.keys(overrides) as BuiltinActionId[]).filter((id) => overrides[id] !== undefined)
  if (ids.length === 0) {
    return <div className="mform-hint" data-testid="machine-def-actionoverride-none">No M-code overrides - every built-in action sends its controller default.</div>
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
  const table = machineToolTable(machine)
  return (
    <div data-testid="machine-def-tooltable-section">
      <ToolTableRows table={table} units={units} />
      <div className="mform-hint" style={{ marginTop: 8, marginBottom: 2 }}>Probe overrides</div>
      <ProbeOverrideRows machine={machine} units={units} />
      <div className="mform-hint" style={{ marginTop: 8, marginBottom: 2 }}>M-code overrides</div>
      <ActionOverrideRows machine={machine} />
    </div>
  )
}

import { catalogChildren } from './probing/catalogText'
import { jsxTextValue } from '../../i18n/locales/en/probing-screens'
import { textFor, useText } from '../../i18n'
const probeText = textFor('probing-screens')

// WO-411 - the Routines view of the Control page (Operator ruling 2026-08-21: "Perhaps
// custom probe needs its own tab? Probe tab is getting pretty busy."). The
// routine library / editor / preview station (ProbeRoutineEditor) was born as
// a collapsible card under the Probing operator station; at Operator's window
// size it sat below the fold of a panel that did not scroll. Here it is the
// whole tab: open, no Show/Hide toggle. Operator 2026-08-21 cleanup: no transport
// row, no DRO/WCS strip, the routine list is a dropdown, and the tab must not
// scroll - the editor and the preview scroll inside their own boxes.
//
// Presentation only. The same live facts ProbingPanel derives (envelope
// status, honest machine position, the declared-or-reported envelope, the
// effective probe profile) feed the editor's PREVIEW; nothing here moves the
// machine - the routine runner is slice 3.

import { useEffect, useMemo, useRef, useState } from 'react'
import { controlMachine, useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { ProbeLamp, useProbeSignals } from './ProbeLamp'
import { useMachineToolTable } from '../../store/machineToolTableStore'
import { resolveProbeConfig } from '../../lib/machine/toolTable'
import {
  deriveEnvelopeStatus,
  safeMachinePosition,
} from '../../lib/machine/machineEnvelope'
import { resolveMachineMotion } from '../../lib/machine/resolvedMachineMotion'
import { toolSetterDefaultsForMachine, toolSetterPlanContext } from '../../lib/machine/machineSession'
import { machineSafeZValue } from '../../lib/machine/machineActions'
import { bossCrossOverDefaultZ } from '../../lib/machine/probeRoutineFactory'
import { parkCarrierMachine } from '../../store/machineActionsStore'
import { fmtMachineLength, parseDimToMm, unitLabel } from '../../lib/ui/unitFormat'
import { useDisplayUnits } from './useDisplayUnits'
import { NumCell } from './NumCell'
import { ProbeRoutineEditor } from './ProbeRoutineEditor'
import { activeToolFromLibrary } from './ProbingPanel'

export function ProbeRoutinesTab() {
  useText('probing-screens')
  const probeSignals = useProbeSignals()
  const machine = useCamStore(controlMachine)
  const machineId = machine?.id ?? 'default'
  const probeOverride = useMachineToolTable((s) => s.byMachine[machineId]?.probe)
  const probeCfg = useMemo(
    () => resolveProbeConfig(machine?.probing, probeOverride),
    [machine?.probing, probeOverride],
  )

  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const connectionKind = useMachineControl((s) => s.connectionKind)
  const activeWcs = useMachineControl((s) => s.activeWcs)
  const offsets = useMachineControl((s) => s.offsets)
  const mpos = useMachineControl((s) => s.mpos)
  const homed = useMachineControl((s) => s.homed)
  const settings = useMachineControl((s) => s.settings)
  const activeTool = useMachineControl((s) => s.activeTool)
  const toolLibrary = useCamStore((s) => s.toolLibrary)
  const units = useDisplayUnits()
  // The tip radius the preview compensates with - the Probing tab's Feature
  // setup field starts from the same default and the same WO-1634 rule:
  // follow the active tool (Operator probes with the cutter in the collet)
  // until the operator types a value of their own.
  const [tipRadiusMm, setTipRadiusMm] = useState(1.5)
  const [tipRadiusSource, setTipRadiusSource] = useState<string | null>(null)
  const tipRadiusTypedRef = useRef(false)
  const activeToolEntry = useMemo(
    () => activeToolFromLibrary(activeTool, toolLibrary),
    [activeTool, toolLibrary],
  )
  useEffect(() => {
    if (tipRadiusTypedRef.current || !activeToolEntry) return
    setTipRadiusMm(activeToolEntry.diameter / 2)
    setTipRadiusSource(`T${activeTool} ${activeToolEntry.name}`)
  }, [activeTool, activeToolEntry])

  const motionEnvelope = useMemo(
    () => resolveMachineMotion({ machine, connectionKind, settings, datumKnown: homed }).envelope,
    [connectionKind, homed, machine, settings],
  )
  // WO-1682: same fix WO-1669 made on the Probing tab - a UCCNC session's
  // applied and read-back definition never populates the GRBL-shaped
  // `settings` dump, so "limits known" must also accept
  // resolveMachineMotion's own envelope.
  const envelopeStatus = useMemo(
    () =>
      deriveEnvelopeStatus({
        connected,
        settingsKnown: Object.keys(settings).length > 0
          || Boolean(motionEnvelope.x && motionEnvelope.y && motionEnvelope.z),
        homed,
        noHomingSwitches: machine?.noHomingSwitches,
      }),
    [connected, settings, homed, machine?.noHomingSwitches, motionEnvelope],
  )
  const safeMpos = safeMachinePosition(envelopeStatus, mpos)

  // WO-1613: the tool setter routine's defaults (setter, crossing height,
  // search depth, speeds) and the facts its preview reads - the active tool's
  // recorded length and where Z stands - re-read whenever they change.
  const toolTable = useMachineToolTable((s) => s.byMachine[machineId]?.table)
  const toolSetter = useMemo(
    () => ({
      defaults: toolSetterDefaultsForMachine(machine, probeCfg),
      context: { ...toolSetterPlanContext(probeCfg), envelope: motionEnvelope },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [machine, probeCfg, toolTable, activeTool, mpos?.z, motionEnvelope],
  )

  // WO-2052: the Boss centre crosses over at the height the Probing panel's
  // boss does (WO-2035): the machine's declared safe Z, read through the same
  // resolver, else the top of Z travel less 1 mm.
  const declaredSafeZ = useCamStore((s) => machineSafeZValue(parkCarrierMachine(s)))
  const bossCrossOverZ = bossCrossOverDefaultZ(declaredSafeZ, motionEnvelope.z?.max)

  // WO-2074: the factory Bore centre and Inside corner routines' `topZ`
  // default - the active work offset's Z0, machine Z (the hole is in the face
  // Z0 was probed on). `offsets[wcs]` is [x, y, z] in machine coordinates.
  const activeOffsetZ = activeWcs ? offsets[activeWcs]?.[2] : undefined
  const workZeroMachineZ = typeof activeOffsetZ === 'number' && Number.isFinite(activeOffsetZ) ? activeOffsetZ : null

  // Operator 2026-08-21 cleanup: no DRO strip and no active-offset chip on this
  // tab (they live on the Probing tab). Check still reads the honest machine
  // position and the active offset below; the preview's first line states
  // where the routine starts, and its error sentence says why when the
  // machine is not homed. Only the tip radius stays, as one small field in
  // the picker row - it is the one live number the operator owns here.
  const tipRadiusField = (
    <label className="control-routines-tip" data-testid="control-routines-tip-radius">{catalogChildren(probeText('probeRoutinesTab4', { value1: '\u0000value1\u0000' }), { value1: unitLabel(units) })}<NumCell
        shown={fmtMachineLength(tipRadiusMm, units)}
        editable
        testId="control-routines-tip-radius-cell"
        onCommit={(text) => {
          const mm = parseDimToMm(text, units)
          if (!Number.isFinite(mm) || mm < 0) return false
          tipRadiusTypedRef.current = true
          setTipRadiusSource(null)
          setTipRadiusMm(mm)
          return true
        }}
      />
      {tipRadiusSource && (
        <span className="control-probe-field-note" data-testid="control-routines-tip-radius-source">{probeText('probeRoutinesTab3', { value1: jsxTextValue(tipRadiusSource) })}
        </span>
      )}
    </label>
  )

  return (
    <section className="panel control-panel" data-testid="control-routines-panel">
      <div className="panel-header">
        <span className="panel-title">{probeText('probeRoutinesTab6')}</span>
        <ProbeLamp kind="probe" value={probeSignals.probe} testId="routines-lamp-probe" />
      </div>
      <div className="panel-body control-routines-body">
        <ProbeRoutineEditor
          standalone
          start={safeMpos}
          envelopeStatus={envelopeStatus}
          envelope={motionEnvelope}
          probe={probeCfg}
          tipRadiusMm={tipRadiusMm}
          axisLimits={machine?.axisLimits ?? null}
          activeWcs={activeWcs}
          units={units}
          headerExtra={tipRadiusField}
          toolSetter={toolSetter}
          bossCrossOverZ={bossCrossOverZ}
          workZeroMachineZ={workZeroMachineZ}
        />
      </div>
    </section>
  )
}

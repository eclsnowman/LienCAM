import { catalogChildren } from './catalogText'
import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { SectionHead } from './DefinitionFields'
import { axisColorVar } from './DefinitionFields'
import { DefNumber } from './DefinitionFields'
import { NumericInput, OptionalNumericInput } from '../../ui/NumericInput'
import { SkewField } from './SkewField'
import { AxisDrawer } from './AxisDrawer'
import { MachineDrawing, type HomeDirection } from './MachineDrawing'
import { AXIS_NAMES, type AxisName } from '../../../types'
import { machineSafeZ, withMachineSafeZ } from '../../../types'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'
import { useMachineControl } from '../../../store/machineControlStore'
import { controllerSurface } from '../../../lib/machine/controllerSurface'
import { grblFlag, grblMaskBit } from '../../../lib/machine/grbl/settings'

// WO-1690 - THE MACHINE AREA. v2/SLICES.md T7 (Operator's second-pass verdict,
// README.md 2026-09-18): "one table, one row per axis, the columns a
// machinist changes ... a pin drawer for one axis adds 26 when opened."
//
// This retires MotionSection's axis table, TravelHomingSection and
// WiringSection's axis pin table - the three places an axis used to have a
// row - and replaces them with ONE table, so comparing X's travel against
// Y's never means flipping tabs (the same argument WO-1687's file docs make
// for the outer bar). Everything a person checks once per axis (six pins,
// the homing numbers beyond direction and search speed, backlash, enable
// delay) moves behind the "Pins and more" drawer rather than crowding the row.
//
// Catalogue-only extras remain indexed in All settings. Current hi/lo is also
// in the axis drawer because it is a physical per-axis output the pushed
// definition now drives; the drawer uses the same shared SettingSource, not a
// second value or writer.

type MachineAreaProps = Pick<MachineDefinitionPanelState,
  | 'absentAxisRow' | 'draft' | 'editDraft' | 'order' | 'patchAxis' | 'patchAxisPin'
  | 'patchAxisSoftLimit' | 'patchHoming' | 'defineHoming' | 'setHomingOrderAt' | 'pinProblem'
  | 'polarityBoxFor' | 'skewTyped' | 'setSkewTyped' | 'toggleAxisEnabled'
  | 'unsetSoftLimitAxes' | 'enabledAxes' | 'pinText' | 'unsent'
> & { def: NonNullable<MachineDefinitionPanelState['def']> }

export function MachineArea({
  absentAxisRow, def, draft, editDraft, order, patchAxis, patchAxisPin, patchAxisSoftLimit,
  patchHoming, defineHoming, setHomingOrderAt, pinProblem, polarityBoxFor, skewTyped, setSkewTyped,
  toggleAxisEnabled, unsetSoftLimitAxes, enabledAxes, pinText, unsent,
}: MachineAreaProps) {
  useText('control-screens-not-probing')
  const [openAxis, setOpenAxis] = useState<AxisName | null>(null)

  const connectionPhase = useMachineControl((state) => state.connectionPhase)
  const connectionKind = useMachineControl((state) => state.connectionKind)
  const reportedGrblSettings = useMachineControl((state) => state.settings)
  const grbl = controllerSurface(draft).grblSettings
  const liveGrblSettings = connectionPhase === 'connected' && connectionKind === 'serial'
    ? reportedGrblSettings
    : undefined
  const grblValue = (id: number): string | null =>
    liveGrblSettings?.[id] ?? draft.grblSettings?.[id] ?? null
  const grblAxisOffset = (axis: AxisName): number | null =>
    axis === 'X' ? 0 : axis === 'Y' ? 1 : axis === 'Z' ? 2 : null
  const grblAxisValue = (axis: AxisName, base: number): string | null => {
    // Only a GRBL machine reads $100-$122: a UCCNC machine open while some GRBL
    // board is connected over serial keeps its own values and editors (WO-1690 review).
    if (!grbl) return null
    const offset = grblAxisOffset(axis)
    return offset === null ? null : grblValue(base + offset)
  }
  const grblDirection = (axis: AxisName): string => {
    const offset = grblAxisOffset(axis)
    const mask = grblValue(23)
    if (offset === null || mask === null || !Number.isSafeInteger(Number(mask))) return '--'
    return (Number(mask) & (1 << offset)) !== 0 ? 'negative' : 'positive'
  }
  const hasGrblTravelHomingRows = [20, 21, 22, 23, 24, 25, 26, 27, 130, 131, 132]
    .some((id) => grblValue(id) !== null)
  const grblOnOff = (id: number): string => {
    const value = grblValue(id)
    if (value === null) return '--'
    return Number(value) === 0 ? 'off' : 'on'
  }
  const grblSettingsRecord = liveGrblSettings ?? draft.grblSettings ?? {}
  /** GRBL owns the polarity of a wired pin through its own $3/$5 masks - not
   *  named/typed like everything else here, but a live controller fact this
   *  page must not offer a second editor for. Ported unchanged from the
   *  pre-WO-1690 WiringSection. */
  const grblPolarityFor = (axis: AxisName, field: string): { value: boolean; setting: string } | null => {
    if (!grbl) return null
    const offset = grblAxisOffset(axis)
    if (offset === null) return null
    if (field === 'dirPin') {
      const value = grblMaskBit(grblSettingsRecord, 3, offset)
      return value === null ? null : { value, setting: controlText('MachineArea.text001') }
    }
    if (field === 'homePin' || field === 'limitMinusPin' || field === 'limitPlusPin') {
      const value = grblFlag(grblSettingsRecord, 5)
      return value === null ? null : { value, setting: controlText('MachineArea.text002') }
    }
    return null
  }

  const openAxisDef = openAxis ? def.axes.find((a) => a.axis === openAxis) : undefined
  const openAxisHoming = openAxis ? def.homing.perAxis[openAxis] : undefined
  const openAxisGrblHoming = (() => {
    if (!openAxis || !grbl || !hasGrblTravelHomingRows) return null
    const offset = grblAxisOffset(openAxis)
    if (offset === null) return null
    const slowSpeed = grblValue(24)
    const backOff = grblValue(27)
    if (slowSpeed === null || backOff === null) return null
    return { slowSpeed, backOff }
  })()

  const xAxis = def.axes.find((a) => a.axis === 'X')
  const yAxis = def.axes.find((a) => a.axis === 'Y')
  const xHome: HomeDirection = def.homing.perAxis.X?.direction ?? null
  const yHome: HomeDirection = def.homing.perAxis.Y?.direction ?? null

  const safeZ = machineSafeZ(draft)

  return (
    <div data-testid="machine-def-group-machine" style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <SectionHead
          title={controlText('MachineArea.text003')}
          summary={`${enabledAxes.map((a) => a.axis).join('') || 'none'} enabled of ${AXIS_NAMES.length}`}
          testId="machine-def-panel-head-machine"
        />

        {Boolean(grbl) && hasGrblTravelHomingRows && (
          <>
            <p className="mform-help" data-testid="machine-def-grbl-travel-authority">{controlText('MachineArea.text004')}</p>
            <div
              data-testid="machine-def-grbl-homing-summary"
              style={{ display: 'flex', gap: '6px 18px', flexWrap: 'wrap', marginBottom: 6 }}
            >
              <span>{catalogChildren(controlText('MachineArea.text005', { value1: '\u0000value1\u0000' }), { value1: grblOnOff(20) })}</span>
              <span>{catalogChildren(controlText('MachineArea.text006', { value1: '\u0000value1\u0000' }), { value1: grblOnOff(21) })}</span>
              <span>{catalogChildren(controlText('MachineArea.text007', { value1: '\u0000value1\u0000' }), { value1: grblOnOff(22) })}</span>
            </div>
          </>
        )}

        <table
          className="mform-axis-table"
          data-testid="machine-def-panel-axis-table"
          style={{ width: 'auto' }}
        >
          <thead>
            <tr>
              <th data-tooltip={controlText('MachineArea.text008')}>{controlText('MachineArea.text009')}</th>
              <th data-tooltip={controlText('MachineArea.text010')}>{controlText('MachineArea.text011')}</th>
              <th data-tooltip={controlText('MachineArea.text012')}>{controlText('MachineArea.text013')}</th>
              <th data-tooltip={controlText('MachineArea.text014')}>{controlText('MachineArea.text015')}</th>
              <th data-tooltip={controlText('MachineArea.text016')}>{controlText('MachineArea.text017')}</th>
              <th data-tooltip={controlText('MachineArea.text018')}>{controlText('MachineArea.text019')}</th>
              <th data-tooltip={controlText('MachineArea.text020')}>{controlText('MachineArea.text021')}</th>
              <th data-tooltip={controlText('MachineArea.text022')}>{controlText('MachineArea.text023')}</th>
              <th data-tooltip={controlText('MachineArea.text024')}>{controlText('MachineArea.text025')}</th>
              <th>{controlText('MachineArea.text026')}</th>
            </tr>
          </thead>
          <tbody>
            {AXIS_NAMES.map((name) => {
              const a = def.axes.find((x) => x.axis === name)
              if (!a) return absentAxisRow(name, 9)
              const h = def.homing.perAxis[a.axis]
              const offset = grblAxisOffset(name)
              const grblAuthority = Boolean(grbl) && hasGrblTravelHomingRows && offset !== null
              return (
                <tr
                  key={name}
                  data-testid={`machine-def-panel-axis-${name}`}
                  data-axis-enabled={a.enabled ? '' : undefined}
                  style={{ opacity: a.enabled ? 1 : 0.72 }}
                >
                  <td>
                    <label
                      data-wired=""
                      data-tooltip={controlText('MachineArea.text027', { value1: String(name) })}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      <input
                        type="checkbox"
                        aria-label={controlText('MachineArea.text028', { value1: String(name) })}
                        data-testid={`machine-def-panel-axis-enabled-${name}`}
                        checked={a.enabled}
                        onChange={(e) => toggleAxisEnabled(name, e.target.checked)}
                        style={{ margin: 0 }}
                      />
                      <span className="mform-axis-label" style={{ color: axisColorVar(name) }}>
                        {name}
                      </span>
                    </label>
                  </td>
                  <td>
                    {grblAxisValue(name, 100) !== null ? (
                      <span data-testid={`machine-def-grbl-axis-steps-${name}`}>{grblAxisValue(name, 100)}</span>
                    ) : <DefNumber
                      label="" name={`${name} steps per unit`} width={78}
                      value={a.stepsPerUnit} min={0} step={10}
                      onChange={(v) => patchAxis(name, { stepsPerUnit: v })}
                    />}
                  </td>
                  <td>
                    {grblAxisValue(name, 110) !== null ? (
                      <span data-testid={`machine-def-grbl-axis-rate-${name}`}>{grblAxisValue(name, 110)}</span>
                    ) : <DefNumber
                      label="" name={`${name} max velocity (units per minute)`} width={78}
                      value={a.maxVelocity} min={0} step={100}
                      onChange={(v) => patchAxis(name, { maxVelocity: v })}
                    />}
                  </td>
                  <td>
                    {grblAxisValue(name, 120) !== null ? (
                      <span data-testid={`machine-def-grbl-axis-accel-${name}`}>{grblAxisValue(name, 120)}</span>
                    ) : <DefNumber
                      label="" name={`${name} acceleration (units per second squared)`} width={72}
                      value={a.acceleration} min={0} step={10}
                      onChange={(v) => patchAxis(name, { acceleration: v })}
                    />}
                  </td>
                  {grblAuthority ? (
                    <td colSpan={2} data-testid={`machine-def-grbl-travel-${name}`}>
                      {grblValue(130 + offset!) ?? '--'}
                    </td>
                  ) : <>
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
                  </>}
                  {grblAuthority ? (
                    <>
                      <td data-testid={`machine-def-grbl-homing-direction-${name}`}>{grblDirection(name)}</td>
                      <td>
                        {grblValue(25) ?? '--'}
                        {/* Home value/auto-zero are this software's own either
                            way - GRBL has no concept of either - so a homing
                            block is still worth creating on a GRBL-owned axis. */}
                        {!h && (
                          <button
                            type="button"
                            className="control-chip-btn"
                            data-testid={`machine-def-panel-homing-define-${name}`}
                            data-tooltip={controlText('MachineArea.text030', { value1: String(name) })}
                            onClick={() => defineHoming(name)}
                            style={{ marginLeft: 6 }}
                          >{catalogChildren(controlText('MachineArea.text029', { value1: '\u0000value1\u0000' }), { value1: name })}</button>
                        )}
                      </td>
                    </>
                  ) : h ? (
                    <>
                      <td data-wired="">
                        <select
                          className="mform-select"
                          aria-label={controlText('MachineArea.text031', { value1: String(name) })}
                          style={{ width: 72 }}
                          value={h.direction}
                          onChange={(e) => patchHoming(name, {
                            direction: e.target.value as 'negative' | 'positive',
                          })}
                        >
                          <option value="negative">{controlText('MachineArea.text032')}</option>
                          <option value="positive">{controlText('MachineArea.text033')}</option>
                        </select>
                      </td>
                      <td data-wired="">
                        <NumericInput
                          min={0} step={100} value={h.fastSpeed}
                          ariaLabel={controlText('MachineArea.text034', { value1: String(name) })}
                          className="mform-input mform-input-mono"
                          style={{ flex: 'none', width: 78 }}
                          onChange={(v) => patchHoming(name, { fastSpeed: v })}
                        />
                      </td>
                    </>
                  ) : (
                    <td colSpan={2} style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('MachineArea.text035')}<button
                        type="button"
                        className="control-chip-btn"
                        data-testid={`machine-def-panel-homing-define-${name}`}
                        data-tooltip={controlText('MachineArea.text037', { value1: String(name) })}
                        onClick={() => defineHoming(name)}
                        style={{ marginLeft: 6 }}
                      >{catalogChildren(controlText('MachineArea.text036', { value1: '\u0000value1\u0000' }), { value1: name })}</button>
                    </td>
                  )}
                  <td>
                    <select
                      data-wired=""
                      className="mform-select"
                      aria-label={controlText('MachineArea.text038', { value1: String(name) })}
                      data-tooltip={controlText('MachineArea.text039', { value1: String(name) })}
                      style={{ flex: 'none', width: 68 }}
                      value={a.slaveAxis ?? ''}
                      onChange={(e) => patchAxis(name, {
                        slaveAxis: e.target.value === '' ? null : e.target.value as AxisName,
                      })}
                    >
                      <option value="">{controlText('MachineArea.text040')}</option>
                      {AXIS_NAMES.filter((n) => n !== name).map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="control-chip-btn"
                      data-testid={`machine-def-panel-axis-pins-more-${name}`}
                      data-tooltip={controlText('MachineArea.text041', { value1: String(name), value2: String(pinText(a.stepPin)), value3: String(pinText(a.dirPin)) })
                        + controlText('MachineArea.text042', { value1: String(pinText(a.homePin)), value2: String(pinText(a.limitMinusPin)) })
                        + controlText('MachineArea.text043', { value1: String(pinText(a.limitPlusPin)), value2: String(pinText(a.enablePin)) })}
                      onClick={() => setOpenAxis(name)}
                    >{controlText('MachineArea.text044')}<ChevronRight size={12} />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {openAxis && openAxisDef && (
          <AxisDrawer
            axis={openAxis}
            a={openAxisDef}
            h={openAxisHoming}
            controller={draft.controller}
            grblHoming={openAxisGrblHoming}
            onClose={() => setOpenAxis(null)}
            patchAxis={patchAxis}
            patchAxisPin={patchAxisPin}
            patchHoming={patchHoming}
            defineHoming={defineHoming}
            pinProblem={pinProblem}
            polarityBoxFor={polarityBoxFor}
            grblPolarityFor={grblPolarityFor}
            settings={unsent}
          />
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
          <span
            className="mform-label"
            style={{ minWidth: 44 }}
            data-tooltip={
              controlText('MachineArea.text045')
              + controlText('MachineArea.text046')
              + controlText('MachineArea.text047')
            }
          >{controlText('MachineArea.text048')}</span>
          {order.map((ax, i) => (
            <select
              key={`${ax}-${i}`}
              data-wired=""
              className="mform-select"
              aria-label={controlText('MachineArea.text049', { value1: String(i + 1) })}
              data-testid={`machine-def-panel-homing-order-${i}`}
              style={{ flex: 'none', width: 56 }}
              value={ax}
              onChange={(e) => setHomingOrderAt(i, e.target.value as AxisName)}
            >
              {Array.from(new Set<AxisName>([...enabledAxes.map((a) => a.axis), ax]))
                .map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          ))}
          {order.length === 0 && (
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{controlText('MachineArea.text050')}</span>
          )}
        </div>

        {unsetSoftLimitAxes.length > 0 && (
          <div
            data-testid="machine-def-panel-unset-soft-limits"
            style={{ margin: '6px 0', color: 'var(--warning)', fontSize: 'var(--font-size-sm)' }}
          >{catalogChildren(controlText('MachineArea.text053', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000' }), { value1: unsetSoftLimitAxes.join(', '), value2: grbl && hasGrblTravelHomingRows
              ? controlText('MachineArea.text051')
              : controlText('MachineArea.text052'), value3: ' ' })}</div>
        )}

        <div style={{ marginTop: 10 }}>
          <SkewField
            machine={draft}
            typed={skewTyped}
            onTyped={setSkewTyped}
            onChange={editDraft}
            standalone
          />
        </div>

        <label
          data-wired=""
          data-tooltip={
            controlText('MachineArea.text054')
            + controlText('MachineArea.text055')
          }
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 10,
            fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
          }}
        >
          <span>{controlText('MachineArea.text056')}</span>
          {/* An imported profile Safe Z cannot be cleared here, so its box
              reverts a blank. App-owned definition values and typed values are
              clearable; unset stays blank, never a 0 nobody typed. */}
          {safeZ?.from === 'profile' ? (
            <NumericInput
              value={safeZ.z}
              ariaLabel={controlText('MachineArea.text057')}
              className="mform-input mform-input-mono"
              style={{ flex: 'none', width: 78 }}
              onChange={(v) => editDraft((m) => withMachineSafeZ(m, v))}
            />
          ) : (
            <OptionalNumericInput
              value={safeZ?.z}
              ariaLabel={controlText('MachineArea.text058')}
              className="mform-input mform-input-mono"
              style={{ flex: 'none', width: 78 }}
              onChange={(v) => editDraft((m) => withMachineSafeZ(m, v ?? null))}
            />
          )}
          {safeZ === null && (
            <span
              data-testid="machine-def-panel-safe-z-unset"
              style={{ color: 'var(--text-muted)' }}
            >{controlText('MachineArea.text059')}</span>
          )}
        </label>
      </div>

      <MachineDrawing
        travel={draft.travel}
        xHome={xAxis?.enabled ? xHome : null}
        yHome={yAxis?.enabled ? yHome : null}
      />
    </div>
  )
}

import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
// BK-178-DECOMP: leaf presentational components extracted verbatim from
// NewOperationModal.tsx. These are pure, props-only render helpers (no hooks,
// no store access), so relocating them shrinks the wizard body and keeps the
// hooks-order boundary trivially clean. Behaviour is byte-identical.

import { NumericInput, type NumericKind } from '../ui/NumericInput'
import { HelpLink } from '../ui/HelpLink'
import { feedLabel, unitLabel, fmtDim } from '../../lib/ui/unitFormat'
import type { Units, HeightParams } from '../../types'

// ── Auto-from-model badge ─────────────────────────────────────────────────────
// A quiet "inferred from the 3D model" chip for B-rep (3D) operations where the
// software derives geometry automatically. Mirrors the thread-mill source badge's
// green "auto" styling (op-hint chip, same colours) so the family reads as one.
// Display-only with a manual-override link (onClear) that drops the user into the
// hand-pick path. NOT rendered on 2D (curves_2d) ops — a flat part has nothing to
// infer, so callers gate this on a brep being present.
export function AutoFromModelBadge({ note, onClear, clearLabel = tx('newOperationModalParts.Set_manually') }: {
  note: string
  onClear: () => void
  clearLabel?: string
}) {
  useText('cam-operations-new-operation')
  return (
    <div
      data-testid="auto-from-model-badge"
      className="op-hint"
      style={{
        marginBottom: 10,
        padding: '6px 10px',
        borderRadius: 4,
        border: '1px solid',
        // MODAL-CONTRAST: was a raw dark hex (#1f7a3d) on a near-transparent
        // tint of itself -- 2.68:1, failed WCAG text (4.5:1). Swapped onto
        // the app's existing --accent-green success-badge recipe (5.20:1).
        color: 'var(--accent-green)',
        borderColor: 'rgba(76, 175, 80, .35)',
        background: 'rgba(76, 175, 80, .12)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontWeight: 600 }}>{tx('newOperationModalParts.Auto_from_3D_model')}</span>
      <span style={{ fontWeight: 400, flex: 1 }}>{note}</span>
      <button
        type="button"
        data-testid="auto-from-model-clear"
        onClick={onClear}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent-green)',
          textDecoration: 'underline',
          cursor: 'pointer',
          padding: 0,
          font: 'inherit',
          fontWeight: 600,
        }}
      >{clearLabel}</button>
    </div>
  )
}

export function NumberField({
  label, unit, value, min, max, step, onChange, units, kind = 'dim',
}: {
  label: string; unit: string
  value: number; min?: number; max?: number; step?: number
  onChange: (v: number) => void
  // ADR-0022: when `units` is provided this field is dimensioned (length or
  // feed). `value`/`onChange` STILL speak mm (mm/min for feed); only display +
  // parse convert. The rendered unit suffix comes from the shim, ignoring the
  // literal `unit` prop. Invariant fields (°, %, RPM, s, "") pass no `units` and
  // keep their literal `unit` string unchanged.
  units?: Units
  kind?: NumericKind
}) {
  useText('cam-operations-new-operation')
  const suffix = units !== undefined
    ? (kind === 'feed' ? feedLabel(units) : unitLabel(units))
    : unit
  return (
    <div className="op-field-row">
      <span className="op-field-label">{label}</span>
      <div className="op-field-right">
        <div className="op-field-input-row">
          <NumericInput
            className="op-field-input"
            value={value}
            min={min}
            max={max}
            step={step ?? 1}
            onChange={onChange}
            units={units}
            kind={kind}
          />
          {suffix && <span className="op-field-unit">{suffix}</span>}
        </div>
      </div>
    </div>
  )
}

// Explanatory only: reference planes are not a promise about every generated move.
export function HeightsExplainedNotice() {
  useText('cam-operations-new-operation')
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
      <details data-testid="heights-explained" className="op-hint" style={{ flex: 1, border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '6px 10px' }}>
        <summary style={{ cursor: 'pointer', color: 'var(--accent)', fontWeight: 600 }}>{tx('newOperationModalParts.Heights_explained')}</summary>
        <p>{tx('newOperationModalParts.Entry_explained')}</p>
        <p>{tx('newOperationModalParts.Travel_explained')}</p>
        <p>{tx('newOperationModalParts.Clearance_explained')}</p>
      </details>
      <HelpLink topic="height-references" />
    </div>
  )
}

// Heights diagram
export function HeightDiagram({ heights, topOverride, bottomOverride, units }: {
  heights: HeightParams
  /** Resolved top-of-cut Z (WCS) when an op derives its top from a reference
   *  plane (face/engrave). Replaces heights.topHeight in the drawing. */
  topOverride?: number
  /** Resolved bottom-of-cut Z (WCS) when an op derives its bottom from a
   *  reference plane (contour/drill/AC). Replaces heights.bottomHeight. */
  bottomOverride?: number
  /** Active display unit (ADR-0022). The legend values are mm; only their
   *  display converts. The geometry (toY positions) stays in mm. */
  units?: Units
}) {
  useText('cam-operations-new-operation')
  const { clearanceHeight, retractHeight, feedHeight } = heights
  const topHeight    = topOverride    ?? heights.topHeight
  const bottomHeight = bottomOverride ?? heights.bottomHeight

  const rows = [
    { z: clearanceHeight, get label() { return tx('newOperationModalParts.Clearance') },    color: 'var(--vp-plane-clearance)', dash: '6,3' },
    { z: retractHeight,   get label() { return tx('newOperationModalParts.Retract') },       color: '#00e5ff', dash: '5,3' },
    { z: feedHeight,      get label() { return tx('newOperationModalParts.Feed_height') },   color: 'var(--vp-plane-feed)', dash: '3,2' },
    { z: topHeight,       get label() { return tx('newOperationModalParts.Top_of_cut') },    color: 'var(--vp-plane-top)', dash: '' },
    { z: bottomHeight,    get label() { return tx('newOperationModalParts.Bottom_of_cut') }, color: 'var(--vp-plane-bottom)', dash: '' },
  ]

  // Wide-flat layout (Operator, manual audit follow-up 2026-06-12): the SVG
  // renders at 100% modal width, so viewBox aspect IS the rendered height.
  // 600x140 ~= 1/3 of the old 300x210. Legend = five single-line entries
  // stacked vertically ("Label  +N mm" - value AFTER the label, no color
  // bar; the colored text is the cue), with leaders from each height line.
  const SVG_W = 600, SVG_H = 150, PAD = 14
  const DIAG_X = 8, DIAG_W = 110
  const STOCK_X = DIAG_X + 26, STOCK_W = 56
  const LINE_X1 = DIAG_X + 4, LINE_X2 = DIAG_X + DIAG_W - 4

  const allZ  = rows.map(r => r.z)
  const maxZ  = Math.max(...allZ)
  const minZ  = Math.min(...allZ)
  const span  = Math.max(maxZ - minZ, 0.1)
  const toY   = (z: number) => PAD + (1 - (z - minZ) / span) * (SVG_H - PAD * 2)

  const LEG_X = DIAG_X + DIAG_W + 34
  const LEG_ROW = (SVG_H - PAD * 2) / rows.length
  const legY = (i: number) => PAD + i * LEG_ROW + LEG_ROW / 2
  const stockTopY = toY(topHeight), stockBotY = toY(bottomHeight)

  return (
    <div className="op-heights-diag-wrap">
      <div className="op-hint">{tx('newOperationModalParts.Reference_planes')}</div>
      <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="op-heights-diag">
        <rect x={STOCK_X} y={stockTopY}
          width={STOCK_W} height={Math.max(4, stockBotY - stockTopY)}
          fill="#1a2d45" stroke="#2d5070" strokeWidth="1.5" />
        {Array.from({ length: 7 }, (_, i) => {
          const yy = stockTopY + (i + 1) * (stockBotY - stockTopY) / 8
          return yy < stockBotY
            ? <line key={i} x1={STOCK_X + 5} y1={yy} x2={STOCK_X + STOCK_W - 5} y2={yy}
                stroke="#2d5070" strokeWidth="0.6" opacity="0.55" />
            : null
        })}
        {rows.map(({ z, label, color, dash }) => (
          <line key={label} x1={LINE_X1} y1={toY(z)} x2={LINE_X2} y2={toY(z)}
            stroke={color}
            strokeWidth={z === topHeight || z === bottomHeight ? 2 : 1.5}
            strokeDasharray={dash} />
        ))}
        {rows.map(({ z, label, color }, i) => (
          <line key={label}
            x1={LINE_X2 + 1} y1={toY(z)}
            x2={LEG_X - 6}   y2={legY(i)}
            stroke={color} strokeWidth="0.6" opacity="0.3" strokeDasharray="2,3" />
        ))}
        {rows.map(({ z, label, color }, i) => (
          <text key={label} x={LEG_X} y={legY(i) + 4.5}
            fontSize="12.4" fontWeight="600" fill={color} fontFamily="var(--font-ui)">
            {label}
            <tspan dx="10" fontSize="11.4" fontWeight="400" opacity="0.8"
              fontFamily="var(--font-mono)">{
                // mm-mode prints the bare value to at most three decimals (a
                // resolved drill floor printed 14 of them); only inch
                // converts+formats via the shim (ADR-0022).
                units === 'inch'
                  ? `${z >= 0 ? '+' : ''}${fmtDim(z, 'inch')} ${unitLabel('inch')}`
                  : `${z >= 0 ? '+' : ''}${Number(z.toFixed(3))} mm`
              }</tspan>
          </text>
        ))}
      </svg>
      {/* Separate schematic: never project invented travel onto the numeric Z scale. */}
      <svg viewBox="0 0 600 114" className="op-heights-diag" role="img" aria-label={tx('newOperationModalParts.Illustrative_route')}>
        <text x="8" y="14" fill="currentColor" fontSize="12">{tx('newOperationModalParts.Illustrative_route')}</text>
        <path d="M 12 84 H 115 V 94 H 220 V 84 H 580 V 108 H 12 Z" fill="#1a2d45" stroke="#6690b0" />
        <rect x="380" y="52" width="44" height="32" fill="#785c35" stroke="#d9b77c" />
        <path d="M 46 74 V 84 M 46 74 H 150 V 58 H 280 V 74 H 338 V 34 H 468 V 74 H 558" fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="5 3" />
        <circle cx="46" cy="74" r="3" fill="var(--accent)" />
        <g fill="currentColor" fontSize="11">
          <text x="12" y="65">{tx('newOperationModalParts.Entry_start')}</text>
          <text x="156" y="49">{tx('newOperationModalParts.Ordinary_hop')}</text>
          <text x="348" y="28">{tx('newOperationModalParts.Clamp_crossing')}</text>
          <text x="228" y="104">{tx('newOperationModalParts.Material_left')}</text>
        </g>
      </svg>
    </div>
  )
}

// WO-3188: Heights says in one plain line when the outline is plain 2D and a
// height is assumed - what it assumed and where to change it. Never a refusal.
const txHeights2d = textFor('heights-2d-source.wo3188')
export function HeightlessOutlineNote({ kind, planeWcsZ, units }: {
  kind: 'chamfer' | 'geometry'
  /** The assumed geometry plane in WCS mm ('geometry' only). */
  planeWcsZ?: number
  units: Units
}) {
  useText('heights-2d-source.wo3188')
  return (
    <p className="op-hint" data-testid="heightless-outline-note" style={{ margin: '0 0 8px' }}>
      {kind === 'chamfer'
        ? txHeights2d('chamferAssumed')
        : txHeights2d('geometryAssumed', { z: fmtDim(planeWcsZ ?? 0, units), unit: unitLabel(units) })}
    </p>
  )
}

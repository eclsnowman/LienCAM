import { useText } from '../../../../i18n'
import { useState } from 'react'
import { useSketcherTool } from '../useSketcherTool'
import { sketcherTools } from '../toolController'
import { sketcherToolStore } from '../toolStore'
import { useSelectAllOnClick } from '../../../../components/ui/selectAllOnClick'
import {
  confirmOverlayModel, type ConfirmOverlayField,
} from '../../confirmOverlay'
import {
  chamferSetMode, chamferSetD2, chamferSetAngleDeg, chamferToggleSwap,
  type ChamferChainState, type ChamferMode,
} from '../../tools/chamferTool'
import type { PathPatternChainState } from '../../tools/patternTools'
import { toDisplay, unitLabel } from '../../../ui/unitFormat'
import { formatNumUnit } from '../../../../components/ui/NumericInput'
import { isEquationInput, previewDimInput, resolveCountToInteger, resolveDimInput } from '../../dimExpr'
import type { SketcherOverlaysPort } from './port'
import { Check, X } from 'lucide-react'

// WO-1570: mode/d2/angle/swap live on each staged ChamferCornerPick (see
// chamferTool.ts), not a new toolStore scalar -- out of this WO's owned
// paths. Writing straight to the singleton store's `chain` field mirrors
// the precedent in SketchDrawValueInput.tsx (same package, same store),
// and `chain` is already a generic field every tool's chain flows through.
function editChamferChain(edit: (chain: ChamferChainState) => ChamferChainState): void {
  sketcherToolStore.setState((s) => {
    if (!s.chain || s.chain.kind !== 'chamfer') return {}
    return { chain: edit(s.chain) }
  })
}

// WO-1569 (decide-and-log #3, patternTools.ts): Count/Spacing mode/Orientation
// live on the pathpat chain itself, not a toolStore scalar. Same precedent as
// editChamferChain above.
function editPathPatternChain(edit: (chain: PathPatternChainState) => PathPatternChainState): void {
  sketcherToolStore.setState((s) => {
    if (!s.chain || s.chain.kind !== 'pathpat') return {}
    return { chain: edit(s.chain) }
  })
}

/**
 * Floating confirm overlay for staged MODIFY flows (interaction
 * framework rework): fillet corner batches, offset distance, pattern
 * count/angle. Docked just above the prompt bar (consistent position).
 * Pure render of the headless confirmOverlayModel — value edits dispatch
 * the per-field package setters (live preview re-renders through the tool
 * overlay channel), Apply commits via sketcherTools.overlayApply, Cancel = Esc
 * (back one step, not full disarm).
 *
 * WO SKC-14C: the scalars it edits were already package state; the session flag
 * and the document now arrive through the host port.
 */
export function SketchConfirmOverlay({ port }: { port: SketcherOverlaysPort }) {
  const workbenchText = useText('sketch-and-model-workbench')
  const isSketch = port.useIsSketchActive()
  const tool = useSketcherTool((s) => s.tool)
  const chain = useSketcherTool((s) => s.chain)
  const activeSketch = port.useSketch()
  const filletRadius = useSketcherTool((s) => s.filletRadius)
  const chamferSetback = useSketcherTool((s) => s.chamferSetback)
  const offsetDistance = useSketcherTool((s) => s.offsetDistance)
  const linearCount = useSketcherTool((s) => s.linearPatternCount)
  const circularCount = useSketcherTool((s) => s.circularPatternCount)
  const circularAngleDeg = useSketcherTool((s) => s.circularPatternAngleDeg)
  const apply = sketcherTools.overlayApply
  const escape = sketcherTools.escape
  const setFilletRadius = sketcherTools.setFilletRadius
  const setChamferSetback = sketcherTools.setChamferSetback
  const setOffsetDistance = sketcherTools.setOffsetDistance
  const setLinearCount = sketcherTools.setLinearPatternCount
  const setCircularCount = sketcherTools.setCircularPatternCount
  const setCircularAngle = sketcherTools.setCircularPatternAngle
  const setTransformValue = sketcherTools.setTransformValue
  const setKeepOriginal = sketcherTools.setTransformKeepOriginal
  const displayUnits = port.useDisplayUnits()

  // A field carries a LENGTH (radius/distance, model mm) when its model unit
  // is 'mm'. Those convert mm<->display at this overlay edge (ADR-0022); the
  // store/solver keep radius+distance in mm. Counts (unit===null) and the
  // pattern step ANGLE (unit==='deg') are not lengths and pass through.
  const isLengthField = (f: ConfirmOverlayField) => f.unit === 'mm'

  // B12: per-field editable draft so the field tolerates an empty/partial
  // intermediate state (select-all-overwrite) without snapping back. A valid
  // parse still drives the live preview immediately (keystroke -> store).
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // SKC-DRAW-EXPR: live fail-loud feedback for "=..." equations on length/angle
  // draw-time fields (same resolver the placed-dimension editor uses). Null for
  // plain-number text so the pre-existing path stays byte-identical.
  const [previews, setPreviews] = useState<Record<string, { text: string; isError: boolean }>>({})
  // Shared click-selects-all contract (selectAllOnClick.ts); one instance
  // serves every field (focus arms, the paired mouseUp consumes).
  const selectAll = useSelectAllOnClick()

  if (!isSketch || !activeSketch) return null

  const model = confirmOverlayModel(
    { tool, chain },
    {
      entities: activeSketch.entities,
      constraints: activeSketch.constraints,
      dimensions: activeSketch.dimensions,
      filletRadius,
      chamferSetback,
      offsetDistance,
      linearPatternCount: linearCount,
      circularPatternCount: circularCount,
      circularPatternAngleDeg: circularAngleDeg,
    },
  )
  if (!model) return null

  // WO-1437 (BUG-496): the OK button must refuse exactly like Enter when a
  // visible field carries an unresolved expression error. An erroring draft is
  // never dispatched into the store, so applying would silently commit the last
  // successfully-resolved value. Guard BOTH entry points against any visible
  // field error and disable the button so the refusal is visible up front.
  const hasFieldError = model.fields.some((f) => previews[f.id]?.isError)

  const onFieldChange = (field: ConfirmOverlayField, raw: string) => {
    // Keep the raw draft so empty/partial states ("", "-", "1.") survive.
    setDrafts((d) => ({ ...d, [field.id]: raw }))
    // SKC-DRAW-EXPR: length/angle draw-time fields reuse the placed-dimension
    // equation resolver (dimExpr.ts); integer counts keep the pre-existing path.
    // SKC-COUNT-EXPR: pattern count fields ALSO accept "=..." arithmetic through
    // the same DOC-4 engine, then truncate/validate to a positive integer >= min.
    if (field.integer) {
      if (isEquationInput(raw)) {
        const r = resolveCountToInteger(raw, field.min)
        if (!r.ok) {
          setPreviews((p) => ({ ...p, [field.id]: { text: r.message, isError: true } }))
          return
        }
        setPreviews((p) => ({ ...p, [field.id]: { text: `= ${r.count}`, isError: false } }))
        switch (field.id) {
          case 'pattern-count':
            if (model.tool === 'pattern-path') editPathPatternChain((c) => ({ ...c, count: r.count }))
            else if (model.tool === 'pattern-linear') setLinearCount(r.count)
            else setCircularCount(r.count)
            break
        }
        return
      }
      const v = parseInt(raw, 10)
      if (!Number.isFinite(v)) {
        setPreviews((p) => { const n = { ...p }; delete n[field.id]; return n })
        return
      }
      setPreviews((p) => { const n = { ...p }; delete n[field.id]; return n })
      switch (field.id) {
        case 'pattern-count':
          if (model.tool === 'pattern-path') editPathPatternChain((c) => ({ ...c, count: v }))
          else if (model.tool === 'pattern-linear') setLinearCount(v)
          else setCircularCount(v)
          break
      }
      return
    }
    const isAngle = field.unit === 'deg'
    // A unitless field (the scale factor) is a plain number: resolve it in mm so
    // inch display never converts it as a length.
    const units = field.unit === null ? 'mm' : displayUnits
    const r = resolveDimInput(raw, isAngle, units)
    const preview = previewDimInput(raw, isAngle, units)
    if (preview) setPreviews((p) => ({ ...p, [field.id]: preview }))
    else setPreviews((p) => { const n = { ...p }; delete n[field.id]; return n })
    if (!r.ok) return  // don't push an invalid/NaN value into the tool store
    // The tool store keeps lengths in mm and the circular-pattern step in
    // degrees; resolveDimInput returns radians for angles, so convert back.
    const v = isAngle ? (r.mm * 180) / Math.PI : r.mm
    switch (field.id) {
      case 'fillet-radius': setFilletRadius(v); break
      case 'chamfer-setback': setChamferSetback(v); break
      case 'chamfer-d2': editChamferChain((c) => chamferSetD2(c, v)); break
      case 'chamfer-angle': editChamferChain((c) => chamferSetAngleDeg(c, v)); break
      case 'offset-distance': setOffsetDistance(v); break
      case 'pattern-angle': setCircularAngle(v); break
      case 'pattern-path-spacing': editPathPatternChain((c) => ({ ...c, fixedSpacing: v })); break
      case 'move-dx': setTransformValue('dx', v); break
      case 'move-dy': setTransformValue('dy', v); break
      case 'rotate-angle': setTransformValue('angleDeg', v); break
      case 'scale-factor': setTransformValue('factor', v); break
    }
  }

  return (
    <div className="sketch-confirm-overlay" role="dialog" aria-label={workbenchText('SketchConfirmOverlay.confirm', { title: String(model.title) })}>
      <span className="sketch-confirm-title">{model.title}</span>
      {model.modeOptions && (
        <span className="sketch-confirm-field sketch-confirm-chamfer-modes">
          {model.modeOptions.map((m) => (
            <button
              key={m.id}
              type="button"
              className="sketch-prompt-btn"
              style={m.selected ? { fontWeight: 700, textDecoration: 'underline' } : undefined}
              aria-pressed={m.selected}
              onClick={() => {
                if (m.id === 'path-spacing-equal') editPathPatternChain((c) => ({ ...c, spacingMode: 'equal' }))
                else if (m.id === 'path-spacing-fixed') editPathPatternChain((c) => ({ ...c, spacingMode: 'fixed' }))
                else editChamferChain((c) => chamferSetMode(c, m.id as ChamferMode))
              }}
              data-tooltip={m.label}
            >
              <span>{m.label}</span>
            </button>
          ))}
          {model.swapAvailable && (
            <button
              type="button"
              className="sketch-prompt-btn"
              onClick={() => editChamferChain((c) => chamferToggleSwap(c))}
              data-tooltip={workbenchText('SketchConfirmOverlay.swapWhichLegGetsD1TheDistance')}
            >
              <span>{workbenchText('SketchConfirmOverlay.swap')}</span>
            </button>
          )}
        </span>
      )}
      {model.fields.map((f) => {
        const len = isLengthField(f)
        // Display value (no suffix): length fields convert mm -> display.
        //
        // HELP-QA-9 (second half). This used fmtDim, which is toFixed(3) for
        // mm, while every NumericInput in the app renders the SAME stored
        // number through formatNumUnit -> formatNum, which is
        // String(parseFloat(v.toFixed(10))). One fillet radius therefore
        // appeared twice, differently, on one screen: the strip said "17.500"
        // while the toolbox's Fillet radius row said "17.499", and the
        // in-canvas popup said "17.5". Three readouts of one value is the
        // "confusing / uninformative" criterion by itself, and it also reads
        // as a precision bug the app does not actually have.
        //
        // Use the shared editable-number formatter so a value renders
        // identically wherever it is shown. fmtDim stays right for read-only
        // dimension TEXT (fixed decimals line up in a column); this is an
        // editable field, and editable fields are formatNumUnit's job.
        // Non-length fields (the circular-pattern angle, counts) still go
        // through formatNumUnit with no `units` arg: that's the noise-strip
        // ONLY path (formatNum), since an angle/count is not a length and
        // must not take the mm<->inch conversion branch.
        const dispValue = len ? formatNumUnit(f.value, displayUnits) : formatNumUnit(f.value)
        const dispMin = len ? toDisplay(f.min, displayUnits) : f.min
        const dispUnit = len ? unitLabel(displayUnits) : f.unit
        // Preserve the number-input arrow-key stepping (1 for counts, 0.1
        // otherwise, clamped at min like the native spinner) — same live
        // keystroke -> store path as typing. Equation drafts are not nudged.
        const stepField = (dir: 1 | -1) => {
          const raw = String(drafts[f.id] ?? dispValue)
          if (isEquationInput(raw)) return
          const cur = parseFloat(raw)
          let next = (Number.isFinite(cur) ? cur : 0) + dir * (f.integer ? 1 : 0.1)
          next = parseFloat(next.toFixed(6))  // kill float noise
          if (next < dispMin) next = dispMin
          onFieldChange(f, String(next))
        }
        return (
          <label key={f.id} className="sketch-confirm-field">
            <span>{f.label}</span>
            <input
              // type="text" + inputMode (not type="number") so the shared
              // click-selects-all contract works (selection APIs are a spec
              // no-op on number inputs). min lives in stepField above.
              // SKC-DRAW-EXPR/SKC-COUNT-EXPR: all confirm fields accept "=..."
              // equations, so keep inputMode "text" (letters/symbols are
              // reachable). Count fields still show no unit suffix.
              type="text"
              inputMode="text"
              value={drafts[f.id] ?? dispValue}
              style={len && displayUnits === 'inch' ? { width: '5.5em' } : undefined}
              onChange={(e) => onFieldChange(f, e.target.value)}
              onFocus={selectAll.onFocus}
              onMouseUp={selectAll.onMouseUp}
              onBlur={(e) => {
                // ADR-0003: a bad equation never quietly reverts to the old
                // value on click-away -- keep the error visible and focused.
                if (previews[f.id]?.isError) { e.target.focus(); return }
                setDrafts((d) => { const n = { ...d }; delete n[f.id]; return n })
              }}
              onKeyDown={(e) => {
                // Enter applies, Esc cancels — handled here so the
                // viewport's window-level handler never double-fires.
                if (e.key === 'Enter') {
                  if (previews[f.id]?.isError) { e.preventDefault(); e.stopPropagation(); return }
                  e.preventDefault(); e.stopPropagation(); apply()
                }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); escape() }
                if (e.key === 'ArrowUp')   { e.preventDefault(); stepField(1) }
                if (e.key === 'ArrowDown') { e.preventDefault(); stepField(-1) }
              }}
            />
            {dispUnit && <span className="sketch-confirm-unit">{dispUnit}</span>}
            {previews[f.id] && (
              <span
                className={`sketch-dim-eq-preview${previews[f.id].isError ? ' sketch-dim-eq-preview-error' : ''}`}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {previews[f.id].text}
              </span>
            )}
          </label>
        )
      })}
      {model.toggles?.map((t) => (
        <label key={t.id} className="sketch-confirm-field">
          <input
            type="checkbox"
            // The field rule sizes and restyles text inputs (64px, padded, input
            // background); a checkbox needs its own size and native look back.
            style={{ width: 14, height: 14, padding: 0, margin: 0, appearance: 'auto' }}
            checked={t.checked}
            onChange={(e) => {
              if (t.id === 'follow-tangent') editPathPatternChain((c) => ({ ...c, followTangent: e.target.checked }))
              else setKeepOriginal(e.target.checked)
            }}
          />
          <span>{t.label}</span>
        </label>
      ))}
      {model.info && <span className="sketch-confirm-info">{model.info}</span>}
      <span className="sketch-confirm-hint">{model.hint}</span>
      <span className="sketch-confirm-actions">
        <button
          className="sketch-prompt-btn sketch-prompt-btn-confirm"
          onClick={() => { if (hasFieldError) return; apply() }}
          disabled={hasFieldError}
          data-tooltip={workbenchText('SketchConfirmOverlay.enter', { applyLabel: String(model.applyLabel) })}
        >
          <Check size={12} aria-hidden />
          <span>{model.applyLabel}</span>
        </button>
        <button
          className="sketch-prompt-btn"
          onClick={escape}
          data-tooltip={workbenchText('SketchConfirmOverlay.cancelEscBackOneStep')}
        >
          <X size={12} aria-hidden />
          <span>{workbenchText('SketchConfirmOverlay.cancel')}</span>
        </button>
      </span>
    </div>
  )
}

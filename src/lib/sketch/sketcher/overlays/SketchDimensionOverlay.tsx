import { useEffect, useRef, useState } from 'react'
import { Ruler, Eye } from 'lucide-react'
import { useSketcherTool } from '../useSketcherTool'
import { sketcherToolStore } from '../toolStore'
import { useSelectAllOnClick } from '../../../../components/ui/selectAllOnClick'
import { dimensionDisplay } from '../sketchLayer'
import { dimPreview } from '../../tools/dimTool'
import { toDisplay, unitLabel, type Units } from '../../../ui/unitFormat'
import { isEquationInput, previewDimInput, resolveDimInput } from '../../dimExpr'
import type { SketchDimension } from '../../types'
import type { SketcherOverlaysPort } from './port'

// HTML overlay for sketch dimension VALUE labels (Stage 2). The leader and
// extension lines live in the Three.js sketch layer; the text lives here in
// DOM so it stays crisp and constant-size while panning/zooming (same
// pattern as the other viewport overlays).
//
// Positions are synced to the camera every animation frame by mutating the
// label transforms directly (no React re-render per frame); React only
// re-renders when the dimension LIST changes.
//
// WO SKC-14-R1: this file RENDERS labels; it does not own a gesture. The label drag (3px
// threshold, its one undo step, the label move), the trailing click-select and the
// double-click-to-edit all live in the sketcher component, which reaches these elements through
// their `data-dim-id` tag on the viewport root's overlay surface. Before the rework this file
// held a complete second sketch pointer-gesture owner -- the blocker SKC-14's audit found.

interface Props {
  port: SketcherOverlaysPort
}

function trimNum(v: number): string {
  return String(+v.toFixed(4))
}

// Dimension value input (the intended behavior): opens pre-filled with the
// current value, focused and select-all, so typing replaces it. Enter
// commits AND blur (click-away) commits (the host's verdict solve rejects a
// conflicting value and names the set); Esc keeps the current value (a fresh
// placement keeps its measured value, still driving) and cancels without a
// blur-commit. Angles display/accept DEGREES; the document stores radians.
// LINEAR dims display/accept the active display units (mm/inch) while the
// document/solver stay in mm — the conversion happens only here at the edge
// (ADR-0022): the pre-filled value is toDisplay(mm) and Enter/blur convert
// back via parseDimToMm.
export function DimValueInput(
  { port, dim, units }: { port: SketcherOverlaysPort; dim: SketchDimension; units: Units },
) {
  if (dim.kind === 'd1xd2') {
    return <ChamferSetbackInputs port={port} dim={dim} units={units} />
  }
  return <DrivableDimValueInput port={port} dim={dim} units={units} />
}

// The chamfer setback pair is TWO numbers, so it gets two value boxes rather
// than the single-value drivable input above (which only ever surfaces d1).
// Each box drives its own half through the same commitDimensionValue the
// single-value input uses, naming which half it sets (WO-1858); the shared
// driving/reference toggle flips both together, because the pair is one
// dimension. A REFERENCE pair shows both numbers disabled, exactly as a
// reference distance dimension shows its one -- and the toggle beside them is
// live, so the control is never a dead end.
function ChamferSetbackInputs(
  { port, dim, units }: {
    port: SketcherOverlaysPort
    dim: Extract<SketchDimension, { kind: 'd1xd2' }>
    units: Units
  },
) {
  return (
    <>
      <button
        className={`sketch-dim-drive-toggle${dim.driving ? '' : ' sketch-dim-drive-toggle-ref'}`}
        data-tooltip={dim.driving
          ? 'Driving dimension - click to make it reference (driven)'
          : 'Reference dimension - click to make it driving'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => port.toggleDimensionDriving(dim.id)}
      >
        {dim.driving ? <Ruler size={12} /> : <Eye size={12} />}
      </button>
      <ChamferSetbackHalfInput port={port} dim={dim} units={units} half="d1" autoFocus />
      <span className="sketch-dim-unit">x</span>
      <ChamferSetbackHalfInput port={port} dim={dim} units={units} half="d2" />
      <span className="sketch-dim-unit">{unitLabel(units)}</span>
    </>
  )
}

// One half of the pair. Same edit contract as DrivableDimValueInput's input
// (Enter commits + blurs, click-away commits, Esc cancels, equations resolve
// through dimExpr) -- a setback is always LINEAR, so there is no angle branch
// and no signed-sector handling here.
function ChamferSetbackHalfInput(
  { port, dim, units, half, autoFocus }: {
    port: SketcherOverlaysPort
    dim: Extract<SketchDimension, { kind: 'd1xd2' }>
    units: Units
    half: 'd1' | 'd2'
    autoFocus?: boolean
  },
) {
  const inputRef = useRef<HTMLInputElement>(null)
  const skipBlurCommitRef = useRef(false)
  const selectAll = useSelectAllOnClick()
  const [equationPreview, setEquationPreview] = useState<{ text: string; isError: boolean } | null>(null)
  const mm = half === 'd2' ? dim.d2 : dim.value
  useEffect(() => {
    if (!autoFocus || !dim.driving) return
    inputRef.current?.focus()
    selectAll.arm(inputRef.current)
  }, [autoFocus, dim.driving, selectAll])
  return (
    <>
      <input
        key={`${dim.driving}-${mm}`} // re-seed after toggle/commit
        ref={inputRef}
        className="sketch-dim-input"
        type="text"
        inputMode="text"
        defaultValue={trimNum(toDisplay(mm, units))}
        disabled={!dim.driving}
        data-dim-half={half}
        data-tooltip={dim.driving
          ? (half === 'd2' ? 'Setback 2 (d2) from the theoretical corner' : 'Setback 1 (d1) from the theoretical corner')
          : 'Reference dimension tracks the measured value'}
        onChange={(e) => setEquationPreview(previewDimInput(e.target.value, false, units))}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            const r = resolveDimInput((e.target as HTMLInputElement).value, false, units)
            if (!r.ok) { setEquationPreview({ text: r.message, isError: true }); return }
            port.commitDimensionValue(dim.id, r.mm, r.expression, half)
            skipBlurCommitRef.current = true
            inputRef.current?.blur()
          } else if (e.key === 'Escape') {
            skipBlurCommitRef.current = true
            port.closeDimensionEditor()
          }
        }}
        onBlur={(e) => {
          if (skipBlurCommitRef.current) { skipBlurCommitRef.current = false; return }
          const raw = e.target.value
          const r = resolveDimInput(raw, false, units)
          if (!r.ok) {
            if (isEquationInput(raw)) {
              setEquationPreview({ text: r.message, isError: true })
              e.target.focus()
              return
            }
            port.closeDimensionEditor()
            return
          }
          port.commitDimensionValue(dim.id, r.mm, r.expression, half)
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onFocus={selectAll.onFocus}
        onMouseUp={selectAll.onMouseUp}
      />
      {equationPreview && (
        <span
          className={`sketch-dim-eq-preview${equationPreview.isError ? ' sketch-dim-eq-preview-error' : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {equationPreview.text}
        </span>
      )}
    </>
  )
}

function DrivableDimValueInput(
  { port, dim, units }: { port: SketcherOverlaysPort; dim: SketchDimension; units: Units },
) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Escape always resolves the edit itself (cancel) and a successful Enter
  // commits + explicitly blurs; the blur that follows in either case must NOT
  // re-resolve it a second time. An UNPARSEABLE Enter leaves this unarmed --
  // the editor stays open, still awaiting a genuine blur to close/commit it.
  // Armed only on a resolved path, consumed once by the very next blur.
  const skipBlurCommitRef = useRef(false)
  // Shared click-selects-all contract (selectAllOnClick.ts). The editor opens
  // ALREADY FOCUSED (effect below), so a user's first click fires NO focus
  // event — the one-shot select-on-mouseUp flag must be armed by the
  // programmatic focus too, or the browser's default caret placement wins
  // (the twice-rejected bug, root-caused in a real-browser event trace).
  const selectAll = useSelectAllOnClick()
  // "sketch-dim equations wiring" (src/lib/sketch/dimExpr.ts): live inline feedback while typing an
  // "=..." equation -- the resolved value (success) or the fail-loud typed message (failure). Null
  // for plain-number text (the pre-existing path has no live preview and none is added for it).
  const [equationPreview, setEquationPreview] = useState<{ text: string; isError: boolean } | null>(null)
  useEffect(() => {
    if (dim.driving) {
      inputRef.current?.focus()
      // focus() above fires onFocus (select + arm) when the input was not yet
      // focused; arm() again explicitly so the already-focused path (no event)
      // is covered too. Chrome-URL-bar feel: first click into the auto-focused
      // field selects all, second click places the caret.
      selectAll.arm(inputRef.current)
    }
  }, [dim.driving, selectAll])
  const isAngle = dim.kind === 'angle' || dim.kind === 'angle3' // WO-1868: radians -> degrees
  // Angle: stored radians -> degrees. Linear: stored mm -> display units. "sketch-dim equations
  // wiring": reopening an equation-driven dimension shows the EQUATION again (equation-preserving
  // behavior), not just its resolved number -- `dim.expression`, when present, IS the reseed text.
  const initial = dim.expression ?? trimNum(isAngle ? (dim.value * 180) / Math.PI : toDisplay(dim.value, units))
  return (
    <>
      <button
        className={`sketch-dim-drive-toggle${dim.driving ? '' : ' sketch-dim-drive-toggle-ref'}`}
        data-tooltip={dim.driving
          ? 'Driving dimension - click to make it reference (driven)'
          : 'Reference dimension - click to make it driving'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => port.toggleDimensionDriving(dim.id)}
      >
        {dim.driving ? <Ruler size={12} /> : <Eye size={12} />}
      </button>
      <input
        key={`${dim.driving}-${dim.value}-${dim.expression ?? ''}`} // re-seed after toggle/commit
        ref={inputRef}
        className="sketch-dim-input"
        type="text"
        // "text" not "decimal": equations use letters ("sqrt", "sin") and symbols a decimal-only
        // mobile keyboard would hide.
        inputMode="text"
        defaultValue={initial}
        disabled={!dim.driving}
        data-tooltip={dim.driving ? undefined
          : 'Reference dimension tracks the measured value'}
        onChange={(e) => setEquationPreview(previewDimInput(e.target.value, isAngle, units))}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            const raw = (e.target as HTMLInputElement).value
            // dimExpr.ts resolves BOTH an "=..." equation (DOC-4 engine) and a plain typed number
            // (the pre-existing parseFloat/parseDimToMm path, unchanged). Angle: degrees -> radians.
            // Linear: display units (or, inside an equation, mm-canonical) -> mm. The
            // solver/document only ever see millimeters (and radians).
            const r = resolveDimInput(raw, isAngle, units)
            // Unresolvable: keep editing, leave the flag UNARMED. Arming here (before we know the
            // value resolves) is what let a stale flag survive to consume a later genuine
            // click-away (audit finding). ADR-0003: the fail-loud message is shown, never a silent
            // revert to the old value.
            if (!r.ok) { setEquationPreview({ text: r.message, isError: true }); return }
            port.commitDimensionValue(dim.id, r.mm, r.expression)
            // Mirrors SketchDrawValueInput: arm, then blur SYNCHRONOUSLY in
            // this same handler so the flag is consumed right here, not left
            // armed for whatever blur happens next. Both hosts can reject a
            // finite value and keep this same input mounted (CAM: store/
            // index.ts commitDimensionValue's isFinite/driving/focusDistance
            // guards; workbench: applyWithVerdict returning false) -- the
            // explicit blur() resets skipBlurCommitRef immediately either way,
            // so the NEXT real blur (after a refocus + correction) commits.
            skipBlurCommitRef.current = true
            inputRef.current?.blur()
          } else if (e.key === 'Escape') {
            skipBlurCommitRef.current = true // cancel: the editor unmounting must not commit
            port.closeDimensionEditor()
          }
        }}
        onBlur={(e) => {
          if (skipBlurCommitRef.current) { skipBlurCommitRef.current = false; return }
          // Click-away (cross-workspace parity: matches the bottom confirm overlay's
          // live-commit behavior). Same resolve/guard as Enter.
          const raw = e.target.value
          const r = resolveDimInput(raw, isAngle, units)
          if (!r.ok) {
            if (isEquationInput(raw)) {
              // ADR-0003 ("no silent fallbacks"): a bad EQUATION never quietly reverts to the old
              // value on click-away -- keep the editor open with the typed error visible and put
              // focus straight back so the click-away cannot dismiss it unseen. Esc still cancels
              // explicitly. The pre-existing plain-number path below is UNCHANGED (close without
              // commit) -- that behavior predates this WO and is out of its scope.
              setEquationPreview({ text: r.message, isError: true })
              e.target.focus()
              return
            }
            port.closeDimensionEditor() // unparseable plain number: keep the current value, close without commit
            return
          }
          port.commitDimensionValue(dim.id, r.mm, r.expression)
        }}
        // Keep the viewport from stealing the press; the shared focus/mouseUp
        // pair implements click-selects-all (first click) / caret (second).
        onPointerDown={(e) => e.stopPropagation()}
        onFocus={selectAll.onFocus}
        onMouseUp={selectAll.onMouseUp}
      />
      <span className="sketch-dim-unit">{isAngle ? 'deg' : unitLabel(units)}</span>
      {equationPreview && (
        <span
          className={`sketch-dim-eq-preview${equationPreview.isError ? ' sketch-dim-eq-preview-error' : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {equationPreview.text}
        </span>
      )}
    </>
  )
}

export function SketchDimensionOverlay({ port }: Props) {
  const activeSketch = port.useSketch()
  const isSketch = port.useIsSketchActive()
  const selectedIds = port.useSelectedIds()
  const sketchTool = useSketcherTool((s) => s.tool)
  const sketchToolChain = useSketcherTool((s) => s.chain)
  const dimEditor = port.useDimEditor()
  const displayUnits = port.useDisplayUnits()
  const rootRef = useRef<HTMLDivElement>(null)
  // WO-1489: a REFERENCE d1xd2 has no focusable/blurrable child of its own (both its value boxes
  // are disabled, exactly like a reference distance dim's single box), so ITS CONTAINER -- this
  // popover div -- carries the dismissal lifecycle instead: focus it on open, Escape/outside-
  // click(blur) both call the same closeDimensionEditor() an editable input already uses. A
  // DRIVING d1xd2 has two live inputs and owns its dismissal through them, like every other kind
  // (WO-1858). dimEditor is reference-stable while open (same object until the store opens/closes
  // a different one), so this only re-fires on an actual open, not on every unrelated solve
  // re-render.
  const readonlyEditorRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  // Value + mode spans inside the preview: their text is refreshed
  // imperatively from the LIVE cursor (below) so the shown value/mode track
  // the resolved orientation without a React re-render per pointermove.
  const previewValueRef = useRef<HTMLSpanElement>(null)
  const previewModeRef = useRef<HTMLSpanElement>(null)

  // Smart-dim live preview: the inferred dimension type/value for the
  // accumulated operand set, as a label beside the cursor. Its TEXT only
  // changes when the operand set changes (React render); its POSITION
  // follows the pointer via direct transform mutation (no re-render).
  const preview =
    isSketch && activeSketch &&
    sketchTool === 'smart-dimension' && sketchToolChain?.kind === 'dim'
      ? dimPreview(activeSketch.entities, sketchToolChain, displayUnits,
          null, undefined, activeSketch.constraints)
      : null

  useEffect(() => {
    if (!preview) return
    // Refresh the value + mode text from the LIVE cursor via the SAME resolver
    // the witness lines and the commit use, so the readout reflects the ACTUAL
    // resolved orientation (Tab-forced included) and matches what lands on
    // click (preview === commit). Called on pointermove (cursor changed) and
    // once per effect run (Tab / operand-add re-render, which emit no move).
    const refreshText = () => {
      const sk = port.getSketch()
      const chain = sketcherToolStore.getState().chain
      if (!sk || chain?.kind !== 'dim') return
      const cursor = port.getSurface()?.getLastSketchCursor() ?? null
      const p = dimPreview(sk.entities, chain, port.getDisplayUnits(), cursor,
        undefined, sk.constraints)
      if (!p) return
      if (previewValueRef.current) previewValueRef.current.textContent = p.text
      if (previewModeRef.current) previewModeRef.current.textContent = p.mode ?? ''
    }
    const onMove = (e: PointerEvent) => {
      const root = rootRef.current
      const el = previewRef.current
      if (root && el) {
        const r = root.getBoundingClientRect()
        el.style.transform =
          `translate(${(e.clientX - r.left + 14).toFixed(1)}px, ` +
          `${(e.clientY - r.top + 14).toFixed(1)}px)`
      }
      refreshText()
    }
    window.addEventListener('pointermove', onMove)
    refreshText()
    return () => window.removeEventListener('pointermove', onMove)
  }, [preview !== null, sketchToolChain, displayUnits, port])

  // Per-frame position sync: world anchor -> screen px.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const vp = port.getSurface()
      const root = rootRef.current
      if (!vp || !root) return
      for (const el of Array.from(root.children) as HTMLElement[]) {
        const wx = Number(el.dataset.wx)
        const wy = Number(el.dataset.wy)
        if (!isFinite(wx) || !isFinite(wy)) continue
        const s = vp.worldToScreen(wx, wy, 0.4)
        el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`
      }
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [port])

  useEffect(() => {
    if (!dimEditor) return
    const dim = activeSketch?.dimensions.find((d) => d.id === dimEditor.dimId)
    if (dim?.kind !== 'd1xd2' || dim.driving) return
    readonlyEditorRef.current?.focus()
    // WO-1489 audit: a canvas press preventDefaults its own native focus-shift
    // (sketchInteraction.ts's handlePointerDown) and only explicitly blurs a focused
    // `.sketch-dim-input`, so this container's onBlur below never fires for a real canvas click --
    // sketchInteraction.ts is outside this WO's owned-paths, so it cannot be widened to also blur
    // `.sketch-dim-editor`. Listening for the outside pointerdown directly here, inside the one file
    // this WO owns, makes the close independent of blur ever firing at all; onBlur stays as a second
    // path for a keyboard-driven focus loss (Tab), which has no pointerdown to catch.
    const onPointerDown = (e: PointerEvent) => {
      if (readonlyEditorRef.current?.contains(e.target as Node)) return
      port.closeDimensionEditor()
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [dimEditor, activeSketch, port])

  if (!isSketch || !activeSketch) return null

  // null solveStatus = never solved: no conflict info yet.
  const conflicting = new Set(activeSketch.solveStatus?.conflicting ?? [])

  // The label press/drag/click/double-click gesture belongs to the sketcher component. It finds
  // these elements by their `data-dim-id` tag; every threshold, undo step and selection rule lives
  // there, shared with the canvas leader-line drag. Nothing to do here but render.

  return (
    <div className="sketch-dim-layer" ref={rootRef}>
      {activeSketch.dimensions.map((d) => {
        const disp = dimensionDisplay(activeSketch, d, displayUnits)
        if (!disp) return null
        const cls = [
          'sketch-dim-label',
          d.driving ? '' : 'sketch-dim-label-reference',
          conflicting.has(d.id) ? 'sketch-dim-label-conflict' : '',
          selectedIds.includes(d.id) ? 'sketch-dim-label-selected' : '',
        ].filter(Boolean).join(' ')
        return (
          <div
            key={d.id}
            className={cls}
            data-wx={disp.anchor.x}
            data-wy={disp.anchor.y}
            // The component's gesture handle. Drag = reposition (one undo step), click = select,
            // double-click = open the value editor -- all decided in sketchInteraction.ts.
            data-dim-id={d.id}
          >
            {disp.text}
          </div>
        )
      })}
      {dimEditor && (() => {
        const dim = activeSketch.dimensions.find((d) => d.id === dimEditor.dimId)
        if (!dim) return null
        const disp = dimensionDisplay(activeSketch, dim, displayUnits)
        if (!disp) return null
        // d1xd2 (WO-1489): a REFERENCE pair's two value boxes are disabled, so neither can take
        // focus or fire a blur -- the popover container itself becomes the focus/dismiss target,
        // calling the same closeDimensionEditor() an editable input's Escape/blur already call,
        // just wired one level up. A DRIVING pair (WO-1858) and every other dim kind keep their
        // dismissal owned entirely by their own <input>.
        const isReadonlyReadout = dim.kind === 'd1xd2' && !dim.driving
        return (
          <div
            className="sketch-dim-editor"
            data-wx={disp.anchor.x}
            data-wy={disp.anchor.y}
            ref={isReadonlyReadout ? readonlyEditorRef : undefined}
            tabIndex={isReadonlyReadout ? 0 : undefined}
            onKeyDown={isReadonlyReadout ? (e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                port.closeDimensionEditor()
              }
            } : undefined}
            onBlur={isReadonlyReadout ? () => port.closeDimensionEditor() : undefined}
          >
            <DimValueInput key={dim.id} port={port} dim={dim} units={displayUnits} />
          </div>
        )
      })()}
      {preview && (
        <div
          ref={previewRef}
          className={`sketch-dim-label sketch-dim-preview${preview.hint ? ' sketch-dim-preview-hint' : ''}`}
          // Off-screen until the first pointermove positions it.
          style={{ transform: 'translate(-1000px, -1000px)' }}
        >
          {/* value + mode are refreshed imperatively from the live cursor. */}
          <span className="sketch-dim-preview-value" ref={previewValueRef}>{preview.text}</span>
          {!preview.hint && (
            <span className="sketch-dim-preview-mode" ref={previewModeRef}>{preview.mode ?? ''}</span>
          )}
          {preview.showTabHint && (
            <span className="sketch-dim-preview-tabhint">
              {preview.mode === 'Radius' || preview.mode === 'Arc length'
                ? 'Tab: Radius / Arc length'
                : 'Tab: H / V / Aligned'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

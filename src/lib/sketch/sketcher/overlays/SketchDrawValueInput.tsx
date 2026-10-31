import { useText } from '../../../../i18n'
import { useEffect, useRef, useState } from 'react'
import { useSketcherTool } from '../useSketcherTool'
import { sketcherTools } from '../toolController'
import { sketcherToolStore } from '../toolStore'
import { drawValueScalar, resolveCreationSize, hasCreationSize } from '../../tools/drawValue'
import { toDisplay, parseDimToMm, unitLabel } from '../../../ui/unitFormat'
import { useTypeToSet } from '../../../../components/ui/useTypeToSet'
import type { SketcherOverlaysPort } from './port'

// Heads-up "type a value mid-draw" (Tier 1b). While a supported draw tool
// is rubber-banding (line, circle-center), a small numeric box follows the
// cursor showing the live PRIMARY SCALAR (length / radius). Start typing a
// number and the box captures focus; Enter OR blur (click-away) commits the
// entity at EXACTLY the typed value plus a DRIVING dimension
// (store.commitSketchDrawValue -> pure commitDrawValue), same guard on both
// paths (parseDimToMm; NaN or <=0 or no live cursor -> no commit). Escape
// cancels without committing and returns to free rubber-band.
//
// FILLET and CHAMFER reuse the same box for their live size: when either
// tool is armed the box shows the current package-owned scalar (no travel
// to the bottom field). Unlike the rubber-band tools it ANCHORS to the
// GEOMETRY being edited: the FIRST staged corner (Operator's
// verdict on 3dac35e -- it must stay put as more corners are staged, not
// hop to each new click; unselecting the first corner re-anchors to the
// next), else the pending first-line click, else -- before anything is
// picked -- it follows the cursor so it stays discoverable. Typing + Enter
// sets the
// radius LIVE
// (commitSketchDrawValue routes fillet to setSketchFilletRadius) so the ghost
// arc restyles at once; the overlay Apply still bakes the batch. The bottom
// field stays -- both paths write the same scalar.
//
// Crisp DOM text (mirrors DimValueInput) over a canvas sprite. The live
// value + position are mutated per-frame from the viewport's last cursor
// (getLastSketchCursor) WITHOUT a React re-render, so the box re-renders
// only when the tool/chain changes -- "no typed value" draw stays
// byte-identical to before (this box never touches the normal click path).

interface Props {
  port: SketcherOverlaysPort
}

export function SketchDrawValueInput({ port }: Props) {
  const workbenchText = useText('sketch-and-model-workbench')
  const isSketch = port.useIsSketchActive()
  const activeSketch = port.useSketch()
  const sketchTool = useSketcherTool((s) => s.tool)
  const sketchToolChain = useSketcherTool((s) => s.chain)
  const units = port.useDisplayUnits()
  const creationSessionActive = useSketcherTool((s) => s.creationSessionActive)
  const creationDocumentId = useSketcherTool((s) => s.creationDocumentId)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const unitRef = useRef<HTMLSpanElement>(null)
  // True while the user is editing (by focus or type-while-selecting): stops
  // the per-frame live value from overwriting the entry until commit/cancel.
  const userEditedRef = useRef(false)
  // Enter and Escape both resolve the edit themselves (commit / cancel) and
  // then call blur() explicitly to leave typed-entry mode; that self-induced
  // blur must NOT re-resolve it a second time. Armed by both key handlers,
  // consumed once by the next blur.
  const skipBlurCommitRef = useRef(false)
  // The (already ortho-locked) cursor the last frame showed -- the exact
  // point Enter bakes against, so "shown value === baked value".
  const cursorRef = useRef<{ x: number; y: number } | null>(null)
  // Staged-size tools only: true while the size is being typed here. The
  // box's Enter SETS the size (it does not apply); the batch then needs a SECOND Enter
  // (once the box blurs) at the confirm overlay. Surfacing that two-Enter
  // flow right where the first Enter lands stops the "I hit Enter and nothing
  // happened" stuck feeling. Only shown mid-entry so it is never misleading.
  const [editing, setEditing] = useState(false)

  // Supported draw step? Mirrors drawValueScalar's coverage. Line / circle
  // need an anchored chain (rubber-band). FILLET/CHAMFER are armed-is-enough:
  // their persistent store scalar is surfaced near the cursor the moment
  // the tool is active, even before a corner is staged.
  const isStagedSizeTool = sketchTool === 'fillet' || sketchTool === 'chamfer'
  const supported =
    isSketch && !!activeSketch && (
      isStagedSizeTool ||
      (!!sketchToolChain && (
        (sketchTool === 'line' && sketchToolChain.kind === 'line') ||
        (sketchTool === 'circle-center' &&
          sketchToolChain.kind === 'circle' && sketchToolChain.mode === 'center')
      ))
    )

  useTypeToSet(inputRef, { enabled: supported })

  // Per-frame live value + position sync (no React re-render). Reads the
  // CURRENT tool/chain from the store each frame so a continuing polyline
  // (chain advances without a remount) keeps tracking.
  useEffect(() => {
    if (!supported) return
    userEditedRef.current = false
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const vp = port.getSurface()
      const root = rootRef.current
      const input = inputRef.current
      if (!vp || !root || !input) return
      const cursor = vp.getLastSketchCursor()
      if (!cursor) return
      const ts = sketcherToolStore.getState()
      const scalar = drawValueScalar(
        { tool: ts.tool, chain: ts.chain }, cursor,
        { filletRadius: ts.filletRadius, chamferSetback: ts.chamferSetback },
      )
      if (!scalar) return
      cursorRef.current = { x: cursor.x, y: cursor.y }
      // Position. Line / circle follow the CURSOR (rubber-band tools: the
      // cursor IS the geometry). FILLET/CHAMFER anchor to the geometry being
      // edited: the FIRST staged corner (the box stays put while more
      // corners accumulate -- it must not hop to each new click; when the
      // first corner is unselected the anchor moves to the new first),
      // else the pending first-line click, else (nothing picked yet) the
      // cursor so the box is still discoverable before the first click.
      let anchor: { x: number; y: number } = cursor
      let anchored = false
      const sizeChain =
        ts.tool === 'fillet' && ts.chain?.kind === 'fillet'
          ? ts.chain
          : ts.tool === 'chamfer' && ts.chain?.kind === 'chamfer'
            ? ts.chain
            : null
      if (sizeChain) {
        const ch = sizeChain
        const staged = ch.corners.length > 0
          ? ch.corners[0].at
          : ch.pendingClick
        if (staged) { anchor = staged; anchored = true }
      }
      // Offset beside the anchor (cursor offset matches the dimension
      // preview; the geometry anchor sits a hair further so the box never
      // covers the corner marker).
      const off = anchored ? 16 : 14
      const screen = vp.worldToScreen(anchor.x, anchor.y, 0)
      let px = screen.x + off
      let py = screen.y + off
      if (anchored) {
        // A staged corner can sit anywhere (even off-view); keep the box
        // fully on-screen by clamping to the overlay host (viewport-root).
        // Skipped when the measured sizes are degenerate (jsdom / not laid
        // out yet). Cursor-following placement is left untouched.
        const host = root.parentElement
        if (host && host.clientWidth > 0 && host.clientHeight > 0) {
          const margin = 4
          const maxX = host.clientWidth - root.offsetWidth - margin
          const maxY = host.clientHeight - root.offsetHeight - margin
          if (maxX > margin) px = Math.min(Math.max(px, margin), maxX)
          if (maxY > margin) py = Math.min(Math.max(py, margin), maxY)
        }
      }
      root.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`
      if (!userEditedRef.current) {
        input.value = formatScalar(toDisplay(scalar.value, units))
        if (unitRef.current) unitRef.current.textContent = unitLabel(units)
      }
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [supported, port, units])

  // Tool/chain change (or unmount) ends any in-progress entry hint.
  useEffect(() => { if (!supported) setEditing(false) }, [supported])

  if (isSketch && activeSketch && creationSessionActive && creationDocumentId === activeSketch.id &&
      (sketchTool === 'rect-corner' || sketchTool === 'rect-center') &&
      sketchToolChain?.kind === 'rect' && sketchToolChain.anchor && !sketchToolChain.rotated) {
    return <RectangleSizeInput key={`${activeSketch.id}:${units}`} port={port} units={units} documentId={activeSketch.id} />
  }
  if (!supported) return null

  return (
    <div
      className="sketch-dim-editor sketch-draw-value"
      ref={rootRef}
      // The wrapper must never swallow canvas picks: when the fillet box is
      // anchored at a staged corner it can sit ON the next line the user
      // needs to click (real-app repro: second fillet pick eaten, tool stuck
      // at "Step 1 of 2"). Clicks pass through everything except the input
      // itself; numeric-entry capture (window keydown) needs no clicks.
      style={{ transform: 'translate(-1000px, -1000px)', pointerEvents: 'none' }}
    >
      <input
        ref={inputRef}
        className="sketch-dim-input"
        type="text"
        inputMode="decimal"
        defaultValue=""
        style={{ pointerEvents: 'auto' }}
        onPointerDown={(e) => e.stopPropagation()}
        onFocus={() => {
          // Clicking the cursor-side box enters the same protected editing
          // mode as type-while-selecting. Otherwise the next animation frame
          // replaces the browser-managed input value with the live scalar.
          userEditedRef.current = true
          setEditing(true)
        }}
        onBlur={() => {
          if (skipBlurCommitRef.current) { skipBlurCommitRef.current = false; return }
          // Click-away with a valid typed value (cross-workspace parity: matches the
          // bottom confirm overlay's live-commit behavior). Same guard as Enter.
          const mm = parseDimToMm(inputRef.current?.value ?? '', units)
          const cursor = cursorRef.current
          if (!Number.isNaN(mm) && mm > 0 && cursor) sketcherTools.commitDrawValueAt(mm, cursor)
          userEditedRef.current = false
          setEditing(false)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            const mm = parseDimToMm((e.target as HTMLInputElement).value, units)
            const cursor = cursorRef.current
            if (Number.isNaN(mm) || mm <= 0 || !cursor) return // keep editing
            sketcherTools.commitDrawValueAt(mm, cursor)
            userEditedRef.current = false
            setEditing(false)
            skipBlurCommitRef.current = true // already committed above; the blur() below must not re-commit
            inputRef.current?.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            userEditedRef.current = false // resume free rubber-band
            setEditing(false)
            skipBlurCommitRef.current = true // cancel: the blur() below must not commit
            inputRef.current?.blur()
          }
        }}
      />
      <span className="sketch-dim-unit" ref={unitRef}>{unitLabel(units)}</span>
      {isStagedSizeTool && editing && (
        <span className="sketch-draw-value-hint">
          {workbenchText('SketchDrawValueInput.enterSetsThenEnterToApply', { value1: String((sketchTool === 'fillet' ? workbenchText('SketchDrawValueInput.radius') : workbenchText('SketchDrawValueInput.setback'))) })}</span>
      )}
    </div>
  )
}

// Trim to a legible fixed precision (mm 2dp / inch keeps more) without
// trailing-zero noise; mirrors the dimension label's brevity.
function formatScalar(v: number): string {
  return String(+v.toFixed(3))
}

// A pair in the existing draw-value chrome; the document/controller, never
// DOM text, owns the size overrides. Focus alone does not lock a live value.
function RectangleSizeInput({ port, units, documentId }: Props & { units: 'mm' | 'inch'; documentId: string }) {
  const text = useText('sketch-and-model-workbench')
  const root = useRef<HTMLDivElement>(null)
  const width = useRef<HTMLInputElement>(null)
  const height = useRef<HTMLInputElement>(null)
  const cursor = useRef({ x: 0, y: 0 })
  useTypeToSet(width, { enabled: true })
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const surface = port.getSurface()
      const s = sketcherToolStore.getState()
      const ch = s.chain
      if (!surface || ch?.kind !== 'rect' || !ch.anchor) return
      cursor.current = surface.getLastSketchCursor() ?? ch.anchor
      const size = resolveCreationSize(s, cursor.current, s.creationSize)
      const screen = surface.worldToScreen(cursor.current.x, cursor.current.y, 0)
      if (root.current) root.current.style.transform = `translate(${screen.x + 14}px, ${screen.y + 14}px)`
      for (const [field, ref] of [['width', width], ['height', height]] as const) {
        const input = ref.current
        if (!input) continue
        const held = s.creationSize?.[field] !== undefined
        input.dataset.held = String(held)
        input.style.fontWeight = held ? 'bold' : ''
        input.setAttribute('aria-description', held ? text('SketchDrawValueInput.held') : text('SketchDrawValueInput.followsPointer'))
        if (!held && size) input.value = formatScalar(toDisplay(size[field], units))
      }
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      if (sketcherToolStore.getState().creationDocumentId === documentId) sketcherTools.clearCreationSize()
    }
  }, [port, units, text, documentId])
  const apply = () => sketcherTools.commitCreationSizeAt(port.getSurface()?.getLastSketchCursor() ?? cursor.current)
  return <div ref={root} className="sketch-dim-editor sketch-draw-value"
    style={{ transform: 'translate(-1000px, -1000px)', pointerEvents: 'none' }}>
    {(['width', 'height'] as const).map((field, index) => {
      const ref = index === 0 ? width : height
      return <label key={field} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>{index === 0 ? 'W' : 'H'}</span>
        <input ref={ref} className="sketch-dim-input" type="text" inputMode="decimal"
          aria-label={text(index === 0 ? 'SketchDrawValueInput.width' : 'SketchDrawValueInput.height')}
          style={{ pointerEvents: 'auto' }}
          onPointerDown={e => e.stopPropagation()}
          onInput={e => sketcherTools.setCreationSize(field, parseDimToMm(e.currentTarget.value, units))}
          onBlur={e => {
            if (e.relatedTarget instanceof Node && root.current?.contains(e.relatedTarget)) return
            // Tool/mode/cancel buttons change the current operation. Browser
            // blur precedes their click; discard locks before that transition.
            if (e.relatedTarget instanceof Element && e.relatedTarget.closest(
              '.sketch-tool-btn, .sketch-header-toggle, .sketch-prompt-btn:not(.sketch-prompt-btn-confirm)',
            )) { sketcherTools.clearCreationSize(); return }
            if (!sketcherTools.isCreationPlacementPending()) apply()
          }}
          onKeyDown={e => {
            sketcherTools.trackCreationModifiers(e.shiftKey)
            e.stopPropagation()
            if (e.key === 'Escape') {
              e.preventDefault(); sketcherTools.clearCreationSize(); e.currentTarget.blur()
            } else if (e.key === 'Tab') {
              e.preventDefault()
              if (sketcherToolStore.getState().creationSize?.[field] === null) return
              const next = index === 0 ? height.current : width.current
              next?.focus(); next?.select()
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (hasCreationSize(sketcherToolStore.getState().creationSize)) {
                if (apply()) e.currentTarget.blur()
              } else {
                sketcherTools.end(); e.currentTarget.blur()
              }
            }
          }} />
        <span className="sketch-dim-unit">{unitLabel(units)}</span>
      </label>
    })}
  </div>
}

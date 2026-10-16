import { useText } from '../../../../i18n'
import { useEffect, useRef } from 'react'
import { useSketcherTool } from '../useSketcherTool'
import { sketcherTools } from '../toolController'
import { promptBarModel } from '../../promptBar'
import { confirmOverlayActive } from '../../confirmOverlay'
import type { SketcherOverlaysPort } from './port'
import type { SketchToolId } from '../../tools/toolMachine'
import {
  MousePointer2, Slash, Square, SquareDot,
  Tangent, Radius, Pentagon, Ruler, Settings2,
  Scissors, Split, ArrowRightFromLine, FlipHorizontal2,
  Grid3x3, Move, RotateCw, Scaling, Import, Check, X, Type, Waypoints,
  type LucideIcon,
} from 'lucide-react'
import { cadIcon } from '../../../../components/icons/cadIcons'

// Tool icons (same workshop + lucide set as the toolbox buttons).
export const TOOL_ICONS: Record<SketchToolId, LucideIcon> = {
  select: MousePointer2,
  point: cadIcon('point'),
  line: Slash,
  'rect-corner': Square,
  'rect-center': SquareDot,
  'circle-center': cadIcon('circle-center'),
  'circle-3pt': cadIcon('circle-3pt'),
  ellipse: cadIcon('ellipse'),
  'ellipse-arc': cadIcon('ellipse-arc'),
  spline: cadIcon('spline'),
  'spline-control': cadIcon('spline-control'),
  bezier: cadIcon('bezier'),
  conic: cadIcon('conic'),
  text: Type,
  'arc-3pt': cadIcon('arc-3pt'),
  'arc-tangent': Tangent,
  'arc-center': Radius,
  polygon: Pentagon,
  gear: Settings2,
  slot: cadIcon('slot'),
  'slot-arc': cadIcon('slot-arc'),
  'smart-dimension': Ruler,
  trim: Scissors,
  split: Split,
  extend: ArrowRightFromLine,
  fillet: cadIcon('fillet'),
  chamfer: cadIcon('chamfer'),
  offset: cadIcon('offset'),
  mirror: FlipHorizontal2,
  'pattern-linear': Grid3x3,
  'pattern-circular': cadIcon('pattern-circular'),
  'pattern-path': Waypoints,
  move: Move,
  rotate: RotateCw,
  scale: Scaling,
  project: Import,
}

/**
 * Persistent sketch-mode prompt bar (interaction framework, PLAN 3.4) —
 * docked at the bottom of the viewport, a command-prompt layout.
 * Always answers "what state is the tool in, and what do I do next?":
 * armed tool name + icon, the current step's imperative instruction, the
 * live operand count, and Confirm (Enter) / Cancel (Esc) buttons that
 * dispatch the SAME tool actions the keyboard shortcuts take. With no
 * tool armed it shows a quiet hint instead. Pure render of the headless
 * promptBarModel — the bar can never disagree with the machine.
 *
 * WO SKC-14C: the tool state was already package-owned; the session flag, the
 * selection and the document now arrive through the host port instead of
 * `useCamStore`, so this file lives inside the package.
 */
export function SketchPromptBar({ port }: { port: SketcherOverlaysPort }) {
  const workbenchText = useText('sketch-and-model-workbench')
  const isSketch = port.useIsSketchActive()
  const tool = useSketcherTool((s) => s.tool)
  const chain = useSketcherTool((s) => s.chain)
  const selectedIds = port.useSelectedIds()
  const activeSketch = port.useSketch()
  const filletRadius = useSketcherTool((s) => s.filletRadius)
  const chamferSetback = useSketcherTool((s) => s.chamferSetback)
  const offsetDistance = useSketcherTool((s) => s.offsetDistance)
  const linearPatternCount = useSketcherTool((s) => s.linearPatternCount)
  const circularPatternCount = useSketcherTool((s) => s.circularPatternCount)
  const circularPatternAngleDeg = useSketcherTool((s) => s.circularPatternAngleDeg)
  const sketchToolEnd = sketcherTools.end
  const sketchToolEscape = sketcherTools.escape

  // The prompt bar is bottom-anchored and CENTRED; the axis legend (X/Y/Z) is
  // bottom-anchored and RIGHT. A wide prompt runs underneath it - visible in
  // the shipped help image public/help/sketch-draw-tools/tool-grid.webp, where
  // the "Line - Step 2 of 2" bar ends at x~840 and the triad sits at x~765-845.
  //
  // Publish this bar's LIVE height as --sketch-prompt-h so the bottom-anchored
  // overlays lift by exactly its height, then settle back when it goes. This is
  // the SAME mechanism SimulationPanel already uses for --sim-panel-h (P15) --
  // ported rather than re-derived, so the two stack additively in app.css and a
  // sketch bar over a simulation bar cannot re-collide.
  //
  // The bar's height is not a constant: its prompt wraps at narrow widths and
  // the operand chip comes and goes, so a hardcoded offset would be wrong at
  // exactly the widths where the collision bites. ResizeObserver tracks it.
  const barRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const root = document.documentElement
    const el = barRef.current
    if (!el) {
      root.style.setProperty('--sketch-prompt-h', '0px')
      return
    }
    const publish = () => root.style.setProperty('--sketch-prompt-h', `${el.offsetHeight}px`)
    publish()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(publish)
      ro.observe(el)
    }
    return () => {
      ro?.disconnect()
      // Leaving sketch, disarming, or the confirm overlay taking over all end
      // with no bar - the overlays must come back down, not sit lifted.
      root.style.setProperty('--sketch-prompt-h', '0px')
    }
  })

  if (!isSketch) return null

  // HELP-QA-9: when a staged flow raises its confirm overlay, THAT overlay is
  // the single command surface and this bar stands down.
  //
  // Both used to render at once. With two fillet corners staged the app painted
  // the confirm strip ("Fillet - Radius 17.500 mm - 2 corners staged - [Apply]
  // [Cancel]") AND this step bar directly beneath it ("Fillet - Step 2 of 2 -
  // Set the radius in the overlay - Apply (Enter) adds each fil..." with its own
  // [Confirm Enter] [Back Esc]). Two commit buttons for one action, and no way
  // to tell whether they did the same thing - caught auditing
  // public/help/sketch-fillet-chamfer/staged-ghost.webp against its caption.
  // It also truncated, because that prompt was written to be READ, not squeezed
  // beside a step chip and two buttons.
  //
  // The overlay already carries everything this bar would say at that moment -
  // tool name, staged count, the editable value, and the commit - so the honest
  // fix is one surface, not two. This matches the command-strip rule: a staged
  // flow with one value and a live preview gets ONE slim strip.
  //
  // Deliberately the SAME predicate the store's Enter handling consults
  // (confirmOverlayActive), not a copy of its conditions: whatever decides that
  // Enter applies the staged work is exactly what decides who owns the bar, so
  // the two cannot drift apart.
  if (confirmOverlayActive(
    { tool, chain },
    {
      entities: activeSketch?.entities ?? [],
      filletRadius, chamferSetback, offsetDistance,
      linearPatternCount, circularPatternCount, circularPatternAngleDeg,
    },
  )) return null

  const model = promptBarModel(
    { tool, chain },
    { entities: activeSketch?.entities ?? [], selectedIds },
  )

  if (model.kind === 'idle') {
    return (
      <div ref={barRef} className="sketch-prompt-bar sketch-prompt-bar-idle" role="status">
        <MousePointer2 size={13} aria-hidden />
        <span className="sketch-prompt-hint">{model.hint}</span>
      </div>
    )
  }

  const Icon = TOOL_ICONS[model.tool]
  return (
    <div ref={barRef} className="sketch-prompt-bar" role="status" aria-live="polite">
      <span className="sketch-prompt-tool" data-tooltip={workbenchText('SketchPromptBar.armed', { toolLabel: String(model.toolLabel) })}>
        <Icon size={13} aria-hidden />
        <span>{model.toolLabel}</span>
      </span>
      <span className="sketch-prompt-step-chip">{workbenchText('SketchPromptBar.combinedStepOf', { value1: String((model.stepNumber) ?? ''), value2: String((model.stepCount) ?? '') })}</span>
      {/* .sketch-prompt-text ellipsizes (overflow:hidden + text-overflow), so a
          long instruction silently loses its tail - "Apply (Enter) adds each
          fil..." in the shipped staged-ghost help capture. Ellipsis without a
          way to read the rest is the "confusing / uninformative" criterion:
          the bar exists to answer "what do I do next?" and a cut sentence
          answers it halfway.

          Same remedy Operator already accepted for the auto-value placeholders in
          HELP-QA-7 (4e4ff54e0): keep the short visible form, put the FULL text
          in the tooltip. Purely additive - nothing moves, and at widths where
          the prompt already fits the tooltip simply repeats what is on screen. */}
      <span className="sketch-prompt-text" data-tooltip={model.prompt}>{model.prompt}</span>
      {model.operandText && (
        <span className="sketch-prompt-operands">{model.operandText}</span>
      )}
      <span className="sketch-prompt-actions">
        {model.canConfirm && (
          <button
            className="sketch-prompt-btn sketch-prompt-btn-confirm"
            onClick={sketchToolEnd}
            data-tooltip={workbenchText('SketchPromptBar.confirmThisStepEnter')}
            aria-label={workbenchText('SketchPromptBar.confirmStepEnter')}
          >
            <Check size={12} aria-hidden />
            <span>{workbenchText('SketchPromptBar.confirm')}</span>
            <kbd>{workbenchText('SketchPromptBar.enter')}</kbd>
          </button>
        )}
        <button
          className="sketch-prompt-btn"
          onClick={sketchToolEscape}
          data-tooltip={chain
            ? workbenchText('SketchPromptBar.cancelTheInProgressStepEscCommittedGeometryStays')
            : workbenchText('SketchPromptBar.disarmTheToolAndReturnToSelectEsc')}
          aria-label={workbenchText('SketchPromptBar.cancelEsc')}
        >
          <X size={12} aria-hidden />
          <span>{chain ? workbenchText('SketchPromptBar.back') : workbenchText('SketchPromptBar.cancel')}</span>
          <kbd>{workbenchText('SketchPromptBar.esc')}</kbd>
        </button>
      </span>
    </div>
  )
}

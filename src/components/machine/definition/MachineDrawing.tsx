import { catalogChildren } from './catalogText'
import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import type { MachineConfig } from '../../../types'

// WO-1690 - THE MACHINE, DRAWN. v2/SLICES.md T7: "the machine is drawn on the
// right with the home corner marked and redraws as values change." A top-down
// view of the X/Y travel envelope is enough to answer the one question a
// drawing answers that a table of numbers does not: which corner does this
// machine home to. Nothing here is a control - it is read straight off
// `travel` and the X/Y homing directions, and a React re-render on a changed
// prop is the whole "redraws" requirement; there is no separate refresh path
// to keep in step.

const DRAWING_MAX = 160
const DRAWING_MIN = 40

export type HomeDirection = 'positive' | 'negative' | null

export function MachineDrawing({ travel, xHome, yHome }: {
  travel: MachineConfig['travel']
  xHome: HomeDirection
  yHome: HomeDirection
}) {
  useText('control-screens-not-probing')
  const spanX = Math.max(travel.x, 1)
  const spanY = Math.max(travel.y, 1)
  const scale = DRAWING_MAX / Math.max(spanX, spanY)
  const w = Math.max(spanX * scale, DRAWING_MIN)
  const h = Math.max(spanY * scale, DRAWING_MIN)
  // Machine X grows to the right on screen either way; a 'positive' homing
  // direction means the axis travels toward its maximum to find the switch,
  // so the switch - and the marked corner - sits at that end.
  const homeCx = xHome === 'positive' ? w : 0
  // SVG y grows downward while a CNC's Y conventionally grows away from the
  // operator (up on a top-down drawing), so 'positive' Y homing puts the
  // marked corner at the TOP of the drawing.
  const homeCy = yHome === 'positive' ? 0 : h
  const pad = 14
  return (
    <div data-testid="machine-def-drawing" style={{ flex: 'none' }}>
      <svg
        data-testid="machine-def-drawing-svg"
        width={w + pad * 2}
        height={h + pad * 2}
        viewBox={`${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`}
        role="img"
        aria-label={controlText('MachineDrawing.text001', { value1: String(travel.x), value2: String(travel.y) })}
      >
        <rect
          x={0} y={0} width={w} height={h}
          fill="none" stroke="var(--text-secondary)" strokeWidth={1.5}
        />
        {(xHome !== null && yHome !== null) && (
          <circle
            data-testid="machine-def-drawing-home"
            cx={homeCx} cy={homeCy} r={5}
            fill="var(--accent-red)"
          />
        )}
        <text x={w / 2} y={h + pad - 2} textAnchor="middle" fontSize={9} fill="var(--text-muted)">{catalogChildren(controlText('MachineDrawing.text002', { value1: '\u0000value1\u0000' }), { value1: travel.x })}</text>
        <text
          x={-pad + 2} y={h / 2} textAnchor="middle" fontSize={9} fill="var(--text-muted)"
          transform={`rotate(-90 ${-pad + 2} ${h / 2})`}
        >{catalogChildren(controlText('MachineDrawing.text003', { value1: '\u0000value1\u0000' }), { value1: travel.y })}</text>
      </svg>
    </div>
  )
}

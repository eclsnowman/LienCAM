// WO-3303: the machine drawn as a square gantry (both legs stand at the same Y, so the beam is
// square to the rails) with a linear-axis look: a rail along each side, a carriage block under
// each leg, the beam across and the spindle on its carriage. Drawn from the travel alone; the
// home corner is marked from the X and Y homing directions. Colours are tokens, never literals.
import type { MachineConfig } from '../../types'

export type HomeDirection = 'positive' | 'negative' | null

export interface GantryDrawingProps {
  readonly travel: MachineConfig['travel']
  readonly xHome: HomeDirection
  readonly yHome: HomeDirection
  /** The accessible name of the picture (the screen's words). */
  readonly label: string
}

const SIZE = 220
const COS = Math.cos(Math.PI / 6)
const SIN = 0.5

export function GantryDrawing({ travel, xHome, yHome, label }: GantryDrawingProps) {
  const spanX = Math.max(travel.x, 1)
  const spanY = Math.max(travel.y, 1)
  const spanZ = Math.max(travel.z, 1)
  const k = SIZE / Math.max(spanX, spanY, spanZ * 2)
  const w = spanX * k
  const d = spanY * k
  const h = Math.max(spanZ * k, 30)
  // oblique view: machine X runs down-right, Y up-right, Z up
  const pt = (x: number, y: number, z = 0): [number, number] => [(x + y) * COS, (x - y) * SIN - z]
  const r1 = (n: number) => Math.round(n * 10) / 10
  const P = (x: number, y: number, z = 0) => pt(x, y, z).map(r1).join(',')
  const legY = d / 2
  const beamZ = h + 16
  const homeX = xHome === 'positive' ? w : 0
  const homeY = yHome === 'positive' ? d : 0
  const [hx, hy] = pt(homeX, homeY)
  const pad = 24
  const maxX = (w + d) * COS + pad
  const minY = -(beamZ + d * SIN) - pad
  const maxY = w * SIN + pad
  return (
    <svg
      className="ui2-gantry"
      data-testid="machine-gantry"
      data-gantry="square"
      role="img"
      aria-label={label}
      viewBox={`${-pad} ${minY} ${maxX + pad} ${maxY - minY}`}
    >
      <polygon className="ui2-gantry-bed" points={[P(0, 0), P(w, 0), P(w, d), P(0, d)].join(' ')} />
      {/* the rail along each side, with its carriage block under the leg */}
      {[0, w].map(x => (
        <g key={x} data-testid="machine-gantry-leg" data-leg-y={r1(legY)} data-leg-x={r1(x)}>
          <polyline className="ui2-gantry-rail" points={[P(x, 0), P(x, d)].join(' ')} />
          <polygon className="ui2-gantry-block" points={[P(x - 5, legY - 9), P(x + 5, legY - 9), P(x + 5, legY + 9), P(x - 5, legY + 9)].join(' ')} />
          <polyline className="ui2-gantry-leg" points={[P(x, legY), P(x, legY, beamZ)].join(' ')} />
        </g>
      ))}
      <polyline className="ui2-gantry-beam" data-testid="machine-gantry-beam" points={[P(0, legY, beamZ), P(w, legY, beamZ)].join(' ')} />
      <rect className="ui2-gantry-spindle" x={pt(w / 2, legY, beamZ)[0] - 5} y={pt(w / 2, legY, beamZ)[1]} width={10} height={Math.max(h * 0.45, 12)} />
      {xHome !== null && yHome !== null && <circle className="ui2-gantry-home" data-testid="machine-gantry-home" cx={hx} cy={hy} r={4} />}
    </svg>
  )
}

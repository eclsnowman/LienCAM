// AP item 2 declarations from alpha3-02 MD-19..MD-35. Query data, not new
// current-engine tool eligibility gates or promises that future fixes shipped.
import type { OperationType, ToolType } from '../types'
interface OperationMetadata {
  featureTypes: readonly string[]
  toolTypes: readonly ToolType[]
  role: string
  restLeft: string
}
const planar = ['flat_end_mill', 'bull_nose'] as const
const finish = ['ball_end_mill', 'bull_nose', 'flat_end_mill'] as const
export const operationMetadata = {
  face: {
    featureTypes: ['face', 'planar-top', 'stock-top'], toolTypes: ['face_mill', ...planar],
    role: 'facing (roughing and finishing)', restLeft: 'boundary radial allowance and selected islands',
  },
  pocket_2d: {
    featureTypes: ['closed-pocket', 'open-pocket', 'slot', 'planar-floor'], toolTypes: planar,
    role: 'roughing; wall and floor finishing when enabled', restLeft: 'corners below tool radius, radial/axial allowance and regions without entry',
  },
  contour_2d: {
    featureTypes: ['outer-profile', 'inner-wall', 'open-edge', 'trochoidal-slot', 'tabbed-cutout'], toolTypes: planar,
    role: 'roughing and wall finishing', restLeft: 'corners below tool radius, reserved tabs and radial/axial allowance',
  },
  adaptive_clearing_2d: {
    featureTypes: ['pocket', 'open-pocket', 'slot', 'region', 'stock-footprint'], toolTypes: planar,
    role: 'constant-engagement roughing', restLeft: 'radial/axial allowance, corners below tool radius and regions without entry',
  },
  adaptive_3d: {
    featureTypes: ['freeform-surface', 'cavity', 'boss', '3d-pocket', 'whole-part'], toolTypes: [...planar, 'ball_end_mill'],
    role: 'roughing', restLeft: 'radial/axial allowance, terrace steps unless intermediate levels are on, regions without entry',
  },
  drill: {
    featureTypes: ['through-hole', 'blind-hole', 'spot', 'counterbore-minor'], toolTypes: ['drill', 'spot_drill', 'center_drill'],
    role: 'drilling', restLeft: 'counterbore/countersink diameters, breakthrough allowance and hole wall finish',
  },
  bore: {
    featureTypes: ['milled-hole', 'bore', 'counterbore-step'], toolTypes: planar,
    role: 'hole roughing and finishing', restLeft: 'floor allowance and floor corner radius equal to tool corner radius',
  },
  thread_mill: {
    featureTypes: ['threaded-hole', 'threaded-boss'], toolTypes: ['thread_mill'],
    role: 'thread finishing', restLeft: 'none in thread band; requires a prior hole or boss at the right diameter',
  },
  chamfer: {
    featureTypes: ['chamfer-edge', 'deburr-edge'], toolTypes: ['chamfer_mill', 'v_bit', 'countersink'],
    role: 'chamfering', restLeft: 'edges without proven clear entry',
  },
  engrave: {
    featureTypes: ['text', 'marking-line', 'open-curve'], toolTypes: ['v_bit', 'flat_end_mill', 'ball_end_mill'],
    role: 'marking (finishing)', restLeft: 'none',
  },
  vcarve: {
    featureTypes: ['text', 'closed-outline', 'inlay'], toolTypes: ['v_bit', 'flat_end_mill'],
    role: 'carve finishing and flat-clearing roughing', restLeft: 'flat floors deeper than V reach go to flat-clearing role',
  },
  pattern: {
    featureTypes: ['decorative-surface', 'region', 'stock-top'], toolTypes: ['ball_end_mill', 'v_bit', 'flat_end_mill', 'bull_nose'],
    role: 'decorative finishing', restLeft: 'none',
  },
  parallel_3d: {
    featureTypes: ['shallow-freeform-surface', 'shallow-fillet'], toolTypes: finish,
    role: 'finishing and semi-finishing', restLeft: 'walls above slope limit, cusp height and concave corners below tool radius',
  },
  waterline_3d: {
    featureTypes: ['steep-wall', 'steep-freeform-surface'], toolTypes: finish,
    role: 'finishing and semi-finishing', restLeft: 'shallow areas between levels and wall cusp',
  },
  scallop_3d: {
    featureTypes: ['mixed-slope-freeform-surface', 'fillet'], toolTypes: ['ball_end_mill', 'bull_nose'],
    role: 'finishing', restLeft: 'target cusp and concave corners below tool radius',
  },
  steep_shallow_3d: {
    featureTypes: ['mixed-freeform-surface'], toolTypes: ['ball_end_mill', 'bull_nose'],
    role: 'finishing', restLeft: 'threshold overlap band and concave corners below tool radius',
  },
  pencil_3d: {
    featureTypes: ['concave-corner', 'fillet-below-previous-tool-radius'], toolTypes: ['ball_end_mill'],
    role: 'rest finishing', restLeft: 'corners below this tool radius',
  },
} satisfies Record<OperationType, OperationMetadata>

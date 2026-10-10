// WO-045: the shipped CAD-semantic icon set - the "workshop" pack Operator
// approved from the WO-043 prototype (card Q-ICON-PACK, choice "Set 2"),
// ported from uix/WO-043 @ cafd077 with the review-only pack-switch
// machinery deleted. These ARE the icons; there is no flag.
//
// Style: 2.25-unit strokes + subtle action cues (small arrows on
// direction/motion tools, dashed removed-corner ghosts on fillet/chamfer).
//
// Shared glyph language (WO-043 audit set-wide findings 1-3):
//   - defining points are ALWAYS filled dots, r=2 on the 24 grid -
//     center-defined tools show a center dot, 3-point tools show their
//     three defining points;
//   - minimum feature size >= 2 units; no glyph over ~5 distinct strokes;
//   - stroke caps/joins round, matching the remaining lucide glyphs
//     (the audited-FINE tools keep their lucide picks unchanged).

import { forwardRef } from 'react'
import type { ReactNode, SVGProps } from 'react'
import type { LucideIcon } from 'lucide-react'

const STROKE = 2.25
const DOT_R = 2

/** A filled defining-point dot - the one dot language, everywhere. */
function dot(cx: number, cy: number, r: number, key: string): ReactNode {
  return <circle key={key} cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
}

export type CadIconName =
  | 'circle-center' | 'circle-3pt' | 'ellipse' | 'ellipse-arc' | 'arc-3pt'
  | 'spline' | 'spline-control' | 'bezier' | 'conic' | 'slot' | 'slot-arc' | 'point' | 'construction'
  | 'fillet' | 'chamfer' | 'offset' | 'pattern-circular' | 'measure'
  | 'parallel' | 'perpendicular' | 'collinear' | 'midpoint' | 'symmetric'
  | 'sweep' | 'loft' | 'offset-plane' | 'midplane' | 'angle-plane' | 'axis-datum' | 'plane-through' | 'tangent-plane' | 'point-datum'
  | 'shell' | 'export-step' | 'export-stl'

const DEFS: Record<CadIconName, ReactNode[]> = {
  // ---------------------------------------------------------------- sketch --
  // Center-then-rim tool (toolSteps.ts 'circle-center'): circle + center dot
  // + radius cue.
  'circle-center': [
    <circle key="c" cx={12} cy={12} r={8} />,
    <path key="r" d="M12 12 L17.7 6.3" strokeWidth={1.5} />,
    dot(12, 12, DOT_R, 'p'),
  ],
  // Three rim points define it (toolSteps.ts 'circle-3pt'): NO center dot.
  'circle-3pt': [
    <circle key="c" cx={12} cy={12} r={8} />,
    dot(12, 4, DOT_R, 'p1'),
    dot(5.1, 16, DOT_R, 'p2'),
    dot(18.9, 16, DOT_R, 'p3'),
  ],
  // An actual ellipse, SOLID stroke (dashed = construction-geometry language);
  // center dot because the tool is center-defined.
  ellipse: [
    <ellipse key="e" cx={12} cy={12} rx={9} ry={5.5} />,
    dot(12, 12, DOT_R, 'p'),
  ],
  // Center-defined elliptical arc: upper half-ellipse + center dot.
  'ellipse-arc': [
    <path key="a" d="M3.5 16 A8.5 5.5 0 0 1 20.5 16" />,
    dot(12, 16, DOT_R, 'c'),
    dot(3.5, 16, DOT_R, 'p1'),
    dot(20.5, 16, DOT_R, 'p2'),
  ],
  // Arc THROUGH its three defining dots (start / through / end).
  'arc-3pt': [
    <path key="a" d="M4 17 A10 10 0 0 1 20 17" />,
    dot(4, 17, DOT_R, 'p1'),
    dot(12, 13, DOT_R, 'p2'),
    dot(20, 17, DOT_R, 'p3'),
  ],
  // Curve + dashed control polygon with its control dot.
  spline: [
    <path key="c" d="M4 18 Q10 3 20 12" />,
    <path key="cp" d="M4 18 L10 3 L20 12" strokeWidth={1.1} strokeDasharray="2.4 2" />,
    dot(4, 18, DOT_R, 'p1'),
    dot(10, 3, DOT_R, 'cpd'),
    dot(20, 12, DOT_R, 'p2'),
  ],
  // Control-point spline (WO-1861): a cubic pulled toward a dashed four-point
  // control polygon -- it touches only the two end dots.
  'spline-control': [
    <path key="c" d="M3 20 C7 4 17 4 21 20" />,
    <path key="cp" d="M3 20 L7 4 L17 4 L21 20" strokeWidth={1.1} strokeDasharray="2.4 2" />,
    dot(3, 20, DOT_R, 'p0'),
    dot(7, 4, DOT_R, 'p1'),
    dot(17, 4, DOT_R, 'p2'),
    dot(21, 20, DOT_R, 'p3'),
  ],
  // Bezier (WO-1862): one S-curve between two anchors, each with its handle
  // leg pulled out -- the pen-tool picture.
  bezier: [
    <path key="c" d="M3 19 C9 3 15 21 21 5" />,
    <path key="h0" d="M3 19 L9 3" strokeWidth={1.1} />,
    <path key="h1" d="M15 21 L21 5" strokeWidth={1.1} />,
    dot(3, 19, DOT_R, 'a0'),
    dot(21, 5, DOT_R, 'a1'),
    dot(9, 3, DOT_R * 0.8, 'h0t'),
    dot(15, 21, DOT_R * 0.8, 'h1t'),
  ],
  // Conic arc (WO-1863): the arc between two end dots, tangent to the two
  // dashed legs that meet at the apex dot above it.
  conic: [
    <path key="c" d="M3 20 C5 9 19 9 21 20" />,
    <path key="legs" d="M3 20 L12 3 L21 20" strokeWidth={1.1} strokeDasharray="2.4 2" />,
    dot(3, 20, DOT_R, 'p0'),
    dot(12, 3, DOT_R * 0.8, 'apex'),
    dot(21, 20, DOT_R, 'p2'),
  ],
  // Stadium shape + the two centerline-end dots that define it.
  slot: [
    <path key="s" d="M7 8 H17 A4 4 0 0 1 17 16 H7 A4 4 0 0 1 7 8 Z" />,
    dot(7, 12, DOT_R, 'p1'),
    dot(17, 12, DOT_R, 'p2'),
  ],
  // Curved stadium: two concentric arcs (shared center) closed by round caps.
  'slot-arc': [
    <path key="s" d="M4 17 A8 8 0 0 1 20 17 A2 2 0 0 1 16 17 A4 4 0 0 0 8 17 A2 2 0 0 1 4 17 Z" />,
  ],
  // A point you can actually see at 15px: big filled dot + crosshair ticks.
  point: [
    <path key="t" d="M12 4.5 V8 M12 16 V19.5 M4.5 12 H8 M16 12 H19.5" />,
    dot(12, 12, 2.5, 'p'),
  ],
  // Construction geometry IS the dashed line - one dash language app-wide.
  construction: [
    <path key="l" d="M4 20 L20 4" strokeDasharray="3.4 2.8" />,
  ],
  // Two lines joined by a rounded corner arc, dashed removed-corner ghost.
  fillet: [
    <path key="f" d="M4 6 H10 A8 8 0 0 1 18 14 V20" />,
    <path key="ghost" d="M13.5 6 H18 V10.5" strokeWidth={1.2} strokeDasharray="2 2" />,
  ],
  // Corner with a 45-degree flat cut (not a knife), dashed removed-corner ghost.
  chamfer: [
    <path key="c" d="M4 6 H11 L18 13 V20" />,
    <path key="ghost" d="M12.5 6 H18 V11.5" strokeWidth={1.2} strokeDasharray="2 2" />,
  ],
  // Concentric contours at a uniform offset (not copy-to-clipboard).
  offset: [
    <rect key="o" x={5} y={5} width={14} height={14} rx={3} />,
    <rect key="i" x={9.5} y={9.5} width={5} height={5} rx={1} />,
    <path key="arrow" d="M15 15 L18 18 M18 18 H15.8 M18 18 V15.8" strokeWidth={1.5} />,
  ],
  // Instances (dots) arrayed around a center on a dashed pitch circle.
  'pattern-circular': [
    <circle key="ring" cx={12} cy={12} r={7.5} strokeWidth={1.1} strokeDasharray="2 2.6" />,
    dot(12, 12, 1.6, 'c'),
    dot(19.5, 12, 1.9, 'i0'),
    dot(15.75, 18.5, 1.9, 'i1'),
    dot(8.25, 18.5, 1.9, 'i2'),
    dot(4.5, 12, 1.9, 'i3'),
    dot(8.25, 5.5, 1.9, 'i4'),
    dot(15.75, 5.5, 1.9, 'i5'),
  ],
  // A drafting dimension: extension lines + dimension line with arrowhead
  // terminators. Distinct from Smart Dim's ruler.
  measure: [
    <path key="ext" d="M5 5 V19 M19 5 V19" />,
    <path key="dim" d="M5 12 H19" strokeWidth={STROKE * 0.8} />,
    <path key="ah" d="M5 12 L8.2 10.4 M5 12 L8.2 13.6 M19 12 L15.8 10.4 M19 12 L15.8 13.6" strokeWidth={1.5} />,
  ],
  // ----------------------------------------------------------- constraints --
  // Drafting convention: two slanted parallel lines.
  parallel: [
    <path key="l" d="M6.5 20 L13.5 4 M10.5 20 L17.5 4" />,
  ],
  // Drafting convention: upside-down T + right-angle mark.
  perpendicular: [
    <path key="t" d="M4 19 H20 M12 19 V5" />,
    <path key="sq" d="M8.5 19 V15.5 H12" strokeWidth={1.2} />,
  ],
  // Dots lying on one line.
  collinear: [
    <path key="l" d="M3 12 H21" />,
    dot(7, 12, DOT_R, 'p1'),
    dot(17, 12, DOT_R, 'p2'),
  ],
  // A segment with its midpoint marked.
  midpoint: [
    <path key="l" d="M4 12 H20" />,
    dot(12, 12, 2.2, 'm'),
  ],
  // Mirrored dots about a dashed symmetry centerline.
  symmetric: [
    <path key="cl" d="M12 4 V20" strokeDasharray="3 2.5" />,
    dot(6, 12, DOT_R, 'p1'),
    dot(18, 12, DOT_R, 'p2'),
  ],
  // ----------------------------------------------------------------- model --
  // Profile circle swept along a path curve, arrowhead on the path end.
  sweep: [
    <circle key="pr" cx={5.5} cy={17.5} r={3} />,
    <path key="path" d="M7.6 15.4 C11.5 12.5 10.5 6.5 19 6.5" />,
    <path key="ah" d="M19 6.5 L16.4 5.3 M19 6.5 L17 8.9" strokeWidth={1.5} />,
  ],
  // Two profiles + the connecting silhouette (distinct from Offset plane).
  loft: [
    <ellipse key="top" cx={12} cy={5.5} rx={4.5} ry={2} />,
    <ellipse key="bot" cx={12} cy={18.5} rx={7.5} ry={2.8} />,
    <path key="sides" d="M7.5 5.5 L4.5 18.5 M16.5 5.5 L19.5 18.5" />,
  ],
  // Two parallel planes with the offset arrow between them.
  'offset-plane': [
    <path key="top" d="M4.5 9 L9 4.5 H19.5 L15 9 Z" />,
    <path key="bot" d="M4.5 19.5 L9 15 H19.5 L15 19.5 Z" />,
    <path key="conn" d="M12 14 V10.5 M12 10.5 L10.4 12.1 M12 10.5 L13.6 12.1" strokeWidth={1.5} />,
  ],
  // Two planes with a dashed plane halfway between them.
  midplane: [
    <path key="top" d="M4.5 7.5 L8 4 H19.5 L16 7.5 Z" />,
    <path key="mid" d="M4.5 13.75 L8 10.25 H19.5 L16 13.75 Z" strokeDasharray="2 1.6" strokeWidth={1.3} />,
    <path key="bot" d="M4.5 20 L8 16.5 H19.5 L16 20 Z" />,
  ],
  // A flat plane and a second one hinged up from its edge, with the angle arc.
  'angle-plane': [
    <path key="flat" d="M3.5 19.5 L7.5 15.5 H20.5 L16.5 19.5 Z" />,
    <path key="tilt" d="M7.5 15.5 L11.5 4.5 H20.5 L20.5 15.5" />,
    <path key="arc" d="M14.5 15.5 A4 4 0 0 0 13.2 11.6" strokeWidth={1.4} />,
  ],
  // A cylinder with its dash-dot centre line running through and out both ends.
  'axis-datum': [
    <path key="body" d="M8 7.5 V16.5 M16 7.5 V16.5" />,
    <ellipse key="top" cx={12} cy={7.5} rx={4} ry={1.6} />,
    <path key="bot" d="M8 16.5 A4 1.6 0 0 0 16 16.5" />,
    <path key="axis" d="M12 2.5 V21.5" strokeDasharray="4 1.5 1 1.5" strokeWidth={1.4} />,
  ],
  // WO-2223: a plane sheet held by three dots on it.
  'plane-through': [
    <path key="sheet" d="M3.5 17.5 L8.5 6.5 H20.5 L15.5 17.5 Z" />,
    dot(8, 14.5, 1.6, 'a'),
    dot(16.5, 14.5, 1.6, 'b'),
    dot(12.5, 9, 1.6, 'c'),
  ],
  // WO-2223: a round shaft end-on with a plane touching it along one side.
  'tangent-plane': [
    <circle key="shaft" cx={10} cy={13} r={6} />,
    <path key="plane" d="M16 3 V21" strokeWidth={1.8} />,
    dot(16, 13, 1.6, 'touch'),
  ],
  // WO-2223: a point in space: a dot with three short arms.
  'point-datum': [
    <path key="arms" d="M12 5 V19 M5 12 H19 M7.5 16.5 L16.5 7.5" strokeWidth={1.3} />,
    dot(12, 12, 2.4, 'p'),
  ],
  // An open hollow box: outer shell + inner wall, open top.
  shell: [
    <path key="o" d="M5 4.5 V19.5 H19 V4.5" />,
    <path key="i" d="M9 4.5 V15.5 H15 V4.5" />,
  ],
  // Export STEP: a solid model (iso cube) - distinct from STL's mesh triangle.
  'export-step': [
    <path key="c" d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z" />,
    <path key="e" d="M4 7.5 L12 12 L20 7.5 M12 12 V21" />,
  ],
  // Export STL: a facet mesh (triangle split into two facets). The internal
  // edge runs vertex-to-edge-midpoint, NOT apex-vertical (which reads as a
  // warning triangle's "!").
  'export-stl': [
    <path key="t" d="M4 19 L12 5 L20 19 Z" />,
    <path key="m" d="M4 19 L16 12" />,
  ],
}

type CadIconProps = SVGProps<SVGSVGElement> & { size?: string | number }

function buildIcon(name: CadIconName): LucideIcon {
  const children = DEFS[name]
  const Icon = forwardRef<SVGSVGElement, CadIconProps>(function CadIcon(
    { size = 24, ...rest },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...rest}
      >
        {children}
      </svg>
    )
  })
  // Same call shape as a lucide glyph so the icon tables stay one type.
  return Icon as unknown as LucideIcon
}

const ICONS = Object.fromEntries(
  (Object.keys(DEFS) as CadIconName[]).map((name) => [name, buildIcon(name)]),
) as Record<CadIconName, LucideIcon>

/** Rail-table entry point: `cadIcon('fillet')` is the shipped Fillet glyph.
 *  Pure lookup - safe to call during module evaluation of the icon tables. */
export function cadIcon(name: CadIconName): LucideIcon {
  return ICONS[name]
}

import { useText } from '../../i18n'
import type { Tool, ToolType, ToolCoating, Units } from '../../types'
import { fmtDim, unitLabel } from '../../lib/ui/unitFormat'
import { toolTypeMeta } from '../../lib/tool/toolMeta'
import { buildToolProfile, radiusAtZ, type ToolProfile } from '../../lib/tool/toolProfile'

export interface ToolDiagramProps {
  type: ToolType
  diameter: number
  shankDiameter: number
  overallLength: number
  fluteLength: number
  shoulderLength?: number
  cornerRadius?: number
  angleFromAxisDeg?: number
  tipDiameter?: number
  neckDiameter?: number
  threadFormAngleDeg?: number
  threadTeethCount?: number
  threadPitch?: number
  neckTransitionAngleDeg?: number
  coating: ToolCoating
  lengthBelowHolder?: number
  units?: Units
}

// Material fills retain their physical colors; theme-aware outlines separate them from either ground.
const COATING_COLOR: Record<ToolCoating, string> = {
  none:   '#9ab4c8',
  tin:    '#c8a800',
  ticn:   '#c87830',
  tialn:  '#8060c0',
  dlc:    '#505860',
  zrn:    '#d8cc40',
}

// Explicit references keep the static token census aware of every coating ink.
const COATING_INK: Record<ToolCoating, string> = {
  none: 'var(--diagram-coating-none-outline)',
  tin: 'var(--diagram-coating-tin-outline)',
  ticn: 'var(--diagram-coating-ticn-outline)',
  tialn: 'var(--diagram-coating-tialn-outline)',
  dlc: 'var(--diagram-coating-dlc-outline)',
  zrn: 'var(--diagram-coating-zrn-outline)',
}

// ── ViewBox layout ────────────────────────────────────────────────────────────
// The drawing keeps WO-1170's standard and wide profile scales. The SVG
// viewBox then grows only where drafting dimensions need room: axial dimensions
// in distinct columns to the right, cutter diameter below, and a differing
// shank diameter above. Every annotation therefore remains attached to the
// feature it measures.
//
// The tool is now drawn DIRECTLY from buildToolProfile (the single source of
// truth): tip at the BOTTOM, +z upward. The profile gives radius(z) from the tip
// (z=0) up to the top of the shank; we map z -> vertical px (tip at TIP_BOT, top
// at DRAW_TOP) and r -> horizontal px (centered on CX). The cutting region
// (z <= profile.cuttingMaxZ) is filled with the flutes/coating color; the
// non-cutting neck/shoulder/shank above it use the metal gradients.
// Keeping the viewBox wide relative to its height lets a responsive diagram
// column preserve large, readable annotation text without distorting the tool.
const BASE_VW = 250
const STANDARD_VH = 352
const STANDARD_DRAW_LEFT = 8
const STANDARD_DRAW_RIGHT = 112
const STANDARD_DRAW_TOP = 32
const STANDARD_TIP_BOT = 332

const ANNOT_FONT = 14
const ANNOT_SUB = 11
const DIM_COLUMN_GAP = 34
const DIM_BODY_GAP = 12
const DIM_EXTENSION_GAP = 3
const AXIAL_LABEL_OFFSET = 18
const HORIZONTAL_DIM_GAP = 40
const SMALL_DIMENSION_LABEL_WIDTH = 140

// Find the first height where the profile reaches a declared radius without
// deriving that radius from profile vertices. Sampling brackets the closest
// point, then ternary refinement resolves a cone top or curved-profile tangent.
function radiusAnchorZ(profile: ToolProfile, targetR: number, maxZ: number): number {
  const errorAt = (z: number) => Math.abs(radiusAtZ(profile, z) - targetR)
  if (!(targetR > 0) || !(maxZ > 0) || errorAt(0) <= 1e-9) return 0

  const samples = 4096
  const step = maxZ / samples
  let bestIndex = 0
  let bestError = errorAt(0)
  for (let index = 1; index <= samples; index += 1) {
    const error = errorAt(index * step)
    if (error < bestError - 1e-12) {
      bestError = error
      bestIndex = index
    }
  }

  let low = Math.max(0, (bestIndex - 1) * step)
  let high = Math.min(maxZ, (bestIndex + 1) * step)
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const left = low + (high - low) / 3
    const right = high - (high - low) / 3
    if (errorAt(left) <= errorAt(right)) high = right
    else low = left
  }

  const candidates = [low, (low + high) / 2, high, bestIndex * step]
  return candidates.reduce((best, z) => {
    const error = errorAt(z)
    const prior = errorAt(best)
    return error < prior - 1e-12 || (Math.abs(error - prior) <= 1e-12 && z < best) ? z : best
  }, candidates[0])
}

export function ToolDiagram({
  type,
  diameter,
  shankDiameter,
  overallLength,
  fluteLength,
  shoulderLength = 0,
  cornerRadius = 0,
  angleFromAxisDeg = 59,
  tipDiameter,
  neckDiameter,
  threadFormAngleDeg,
  threadTeethCount,
  threadPitch,
  neckTransitionAngleDeg,
  coating,
  lengthBelowHolder,
  units = 'mm',
}: ToolDiagramProps) {
  const words = useText('setup-stock-tools-machine-post')
  const meta    = toolTypeMeta(type)
  // Annotation values honor displayUnits; lengths in the diagram are short so
  // inch uses 3 decimals (rather than the DIM_DECIMALS 4) to stay legible.
  const dimDecimals = units === 'inch' ? 3 : 1
  const uLabel = unitLabel(units)
  const fluteColor = COATING_COLOR[coating]
  const hasTipAngle = meta.hasAngle
  const angleLabel = words("ToolDiagram.angle", { angle: angleFromAxisDeg })
  const angleLeftBudget = hasTipAngle ? angleLabel.length * ANNOT_FONT * 0.62 + 28 : 0

  // ── Profile: the single source of truth ─────────────────────────────────────
  // Build a Tool-shaped object from the props this component receives and ask
  // buildToolProfile for the radius(z) silhouette (tip at z=0, +z up). Every
  // shape (flat / ball / bull / cone / frustum / drill / dovetail / disc /
  // lollipop) comes from here so the 2D diagram can never drift from the 3D mesh
  // or the simulation.
  const toolLike: Tool = {
    id: 'diagram',
    name: '',
    type,
    diameter,
    fluteLength,
    shankDiameter,
    overallLength,
    shoulderLength,
    lengthBelowHolder,
    numberOfFlutes: 0,
    cornerRadius,
    angleFromAxisDeg,
    tipDiameter,
    neckDiameter,
    threadFormAngleDeg,
    threadTeethCount,
    threadPitch,
    neckTransitionAngleDeg,
    material: 'carbide',
    coating,
    notes: '',
    feedsAndSpeeds: {},
  }
  const profile = buildToolProfile(toolLike)
  const verts = profile.vertices

  // Profile extents in tool units.
  let maxR = 0
  let maxZ = 0
  for (const v of verts) { if (v.r > maxR) maxR = v.r; if (v.z > maxZ) maxZ = v.z }
  maxR = Math.max(maxR, 0.001)
  maxZ = Math.max(maxZ, 1)

  // First try the long/thin layout. It deliberately gives labels a right
  // column, but a profile that would occupy less than 85% of the actual SVG in
  // both directions switches to the wide layout below. The decision is made
  // from the raw profile extents, not from a declared inner measurement box.
  const Rsh = (shankDiameter || diameter) / 2
  const shankDiffers = Math.abs(Rsh - diameter / 2) > Math.max(0.05, diameter * 0.02)
  const standardHW = (STANDARD_DRAW_RIGHT - STANDARD_DRAW_LEFT) / 2
  const standardH = STANDARD_TIP_BOT - STANDARD_DRAW_TOP
  const standardS = Math.min(standardHW / maxR, standardH / maxZ)
  const standardFillW = (2 * maxR * standardS) / BASE_VW
  const standardFillH = (maxZ * standardS) / STANDARD_VH
  const wideLayout = Math.max(standardFillW, standardFillH) < 0.85

  const drawLeft = (wideLayout ? 8 : STANDARD_DRAW_LEFT) + angleLeftBudget
  const drawRight = (wideLayout ? BASE_VW - 8 : STANDARD_DRAW_RIGHT) + angleLeftBudget
  const drawTop = wideLayout ? 36 : STANDARD_DRAW_TOP
  const cx = (drawLeft + drawRight) / 2
  const drawHW = (drawRight - drawLeft) / 2
  // A wide silhouette retains WO-1170's full-width scale. Drafting dimensions
  // grow the viewBox around it instead of stealing profile area.
  const s = wideLayout ? (BASE_VW * 0.92) / (2 * maxR) : standardS
  const tipBot = wideLayout ? drawTop + maxZ * s : STANDARD_TIP_BOT

  // px mappers: r (radius) -> x offset from center; z (axial, tip=0) -> y (up).
  const X = (r: number) => cx + r * s
  const Y = (z: number) => tipBot - z * s

  // ── Build the closed silhouette path for a z-band [zLo, zHi] ─────────────────
  // Walk the (already tip->up) vertices clipping to the band, then close: up the
  // RIGHT edge (x = CX + r*s) then back down the mirrored LEFT edge. Identical
  // approach to the reference HTML renderTool().
  function silhouette(zLo: number, zHi: number): string {
    const right: { z: number; r: number }[] = []
    const pushU = (q: { z: number; r: number }) => {
      const last = right[right.length - 1]
      if (last && Math.abs(last.z - q.z) < 1e-7 && Math.abs(last.r - q.r) < 1e-7) return
      right.push(q)
    }
    const lerpAt = (a: { z: number; r: number }, b: { z: number; r: number }, z: number) => {
      if (Math.abs(b.z - a.z) < 1e-12) return { z, r: a.r }
      const t = (z - a.z) / (b.z - a.z)
      return { z, r: a.r + (b.r - a.r) * t }
    }
    for (let i = 0; i < verts.length - 1; i++) {
      const a = verts[i]
      const b = verts[i + 1]
      const inA = a.z >= zLo - 1e-9 && a.z <= zHi + 1e-9
      const inB = b.z >= zLo - 1e-9 && b.z <= zHi + 1e-9
      if (inA) pushU(a)
      if ((a.z < zLo) !== (b.z < zLo)) pushU(lerpAt(a, b, zLo))
      if ((a.z < zHi) !== (b.z < zHi)) pushU(lerpAt(a, b, zHi))
      if (inB) pushU(b)
    }
    if (!right.length) return ''
    let d = 'M '
    right.forEach((q, i) => { d += (i ? 'L ' : '') + X(q.r).toFixed(1) + ' ' + Y(q.z).toFixed(1) + ' ' })
    for (let i = right.length - 1; i >= 0; i--) {
      const q = right[i]
      d += 'L ' + X(-q.r).toFixed(1) + ' ' + Y(q.z).toFixed(1) + ' '
    }
    d += 'Z'
    return d
  }

  const cutTopZ = Math.min(profile.cuttingMaxZ, maxZ)
  const dCut    = silhouette(0, cutTopZ)
  const dNonCut = silhouette(cutTopZ, maxZ)

  // ── Geometry anchors (px) for the annotation rails ──────────────────────────
  const cutTopY  = Y(cutTopZ)          // top of the cutting region (= flute top)
  const flBotY   = Y(0)                // tip (z=0)
  const topY     = Y(maxZ)             // top of drawn tool (shank top)
  // Half-width of the shank at its top vertex (for the collet flanges).
  const shankHW  = Rsh * s
  // Half-width at the cutting top (for helix-line decoration positioning).
  const cutHW    = radiusAtZ(profile, Math.max(0, cutTopZ - 1e-4)) * s

  // ── Length below holder ───────────────────────────────────────────────────────
  // lbhEffective: how far the tool protrudes below the collet face (measured from
  // the tip, in tool units). Clamp to the drawn tool height.
  const lbhEffective = Math.max(0, Math.min(
    lengthBelowHolder ?? Math.max(fluteLength, shoulderLength),
    maxZ
  ))
  const showLbh      = lbhEffective > 0
  // The collet face is the stated stickout measured from the tip. Keeping this
  // profile-derived endpoint exact is what makes the below-holder dimension a
  // measurement rather than a merely illustrative holder position.
  const colletFaceY  = showLbh ? Y(lbhEffective) : 0
  // colletHW: half-width of the collet body (slightly wider than shank)
  const colletHW     = Math.min(drawHW - 4, shankHW + 9)

  // ── Annotation rows (right column) ────────────────────────────────────────────
  // Each axial span gets a distinct fixed-gap column. Horizontal dimensions
  // are built below after their profile-derived widths are known.
  type AxialDimension = {
    key: 'flute' | 'lbh' | 'oal'
    y1: number
    y2: number
    sourceX1: number
    sourceX2: number
    label: string
    color: string
    extensionColor: string
  }
  const flH = flBotY - cutTopY
  const axialDimensions: AxialDimension[] = [
    {
      key: 'oal' as const, y1: topY, y2: flBotY,
      sourceX1: X(radiusAtZ(profile, maxZ)), sourceX2: X(radiusAtZ(profile, 0)),
      label: words("ToolDiagram.oal_overall", { value1: fmtDim(overallLength, units, dimDecimals), value2: uLabel }),
      color: 'var(--diagram-overall-dimension)', extensionColor: 'var(--diagram-axis)',
    },
    ...cutTopZ > 0 ? [{
      key: 'flute' as const, y1: cutTopY, y2: flBotY,
      sourceX1: X(radiusAtZ(profile, cutTopZ)), sourceX2: X(radiusAtZ(profile, 0)),
      label: words("ToolDiagram.symbol", { value1: fmtDim(fluteLength, units, dimDecimals), value2: uLabel, value3: meta.profileKind === 'probe' ? words('ToolDiagram.stylus') : words('ToolDiagram.flute') }),
      color: 'var(--diagram-flute-dimension)', extensionColor: 'var(--diagram-flute-extension)',
    }] : [],
    ...showLbh ? [{
      key: 'lbh' as const, y1: colletFaceY, y2: flBotY,
      sourceX1: cx + colletHW, sourceX2: X(radiusAtZ(profile, 0)),
      label: words("ToolDiagram.below_holder", { value1: fmtDim(lbhEffective, units, dimDecimals), value2: uLabel }),
      color: 'var(--diagram-stickout-dimension)', extensionColor: 'var(--diagram-stickout-extension)',
    }] : [],
  ].sort((a, b) => Math.abs(a.y2 - a.y1) - Math.abs(b.y2 - b.y1))
  const profileRight = X(maxR)
  const axialWithColumns = axialDimensions.map((dimension, index) => ({
    ...dimension,
    x: profileRight + DIM_BODY_GAP + index * DIM_COLUMN_GAP,
  }))

  // Diameter is the declared widest cutting extent. Locate the profile height
  // that reaches it with radiusAtZ: z=0 for a straight cutter, the cone top for
  // an angled cutter, and the widest tangent for a rounded cutter.
  const cutterR = Math.max(0, diameter / 2)
  const cutterAnchorZ = radiusAnchorZ(profile, cutterR, maxZ)
  const cutterLeft = X(-cutterR)
  const cutterRight = X(cutterR)
  const cutterLineY = tipBot + HORIZONTAL_DIM_GAP
  const cutterLabel = words('ToolDiagram.cutterDiameter', { diameter: fmtDim(diameter, units, units === 'inch' ? 3 : 2), unit: uLabel, kind: meta.profileKind === 'probe' ? words('ToolDiagram.ball') : words('ToolDiagram.cutter') })
  const smallCutterDimension = cutterRight - cutterLeft < SMALL_DIMENSION_LABEL_WIDTH
  const cutterLabelRight = smallCutterDimension
    ? cutterRight + 5 + cutterLabel.length * ANNOT_FONT * 0.62
    : cutterRight

  const shankLeft = cx - shankHW
  const shankRight = cx + shankHW
  const shankLineY = topY - 7
  const shankLabel = words('ToolDiagram.shankDiameter', { diameter: fmtDim(shankDiameter, units, units === 'inch' ? 3 : 2), unit: uLabel })
  // Anchor angular notes halfway along the lowest sloped cutting-profile
  // segment. For drills this is the point cone, not the cylindrical flute wall.
  const angleFlank = verts.slice(0, -1).map((a, index) => ({ a, b: verts[index + 1] })).find(({ a, b }) => (
    b.z > a.z + 1e-7
    && a.z < cutTopZ - 1e-7
    && Math.abs(b.r - a.r) > 1e-7
  ))
  const angleFlankTopZ = angleFlank ? Math.min(cutTopZ, angleFlank.b.z) : cutTopZ
  const angleAnchorZ = angleFlank
    ? angleFlank.a.z + (angleFlankTopZ - angleFlank.a.z) / 2
    : Math.min(cutTopZ, Math.max(cutTopZ * 0.18, 0.001))
  const angleAnchorR = angleFlank
    ? angleFlank.a.r + (angleFlank.b.r - angleFlank.a.r) * ((angleAnchorZ - angleFlank.a.z) / (angleFlank.b.z - angleFlank.a.z))
    : radiusAtZ(profile, angleAnchorZ)
  const angleStartX = X(-angleAnchorR)
  const angleStartY = Y(angleAnchorZ)
  const angleEndX = angleStartX - 14
  const angleEndY = angleStartY - 12

  const lastColumnX = axialWithColumns.at(-1)?.x ?? profileRight
  const vw = Math.max(BASE_VW, lastColumnX + 27, cutterLabelRight + 6)
  const vh = Math.max(STANDARD_VH, cutterLineY + 32)

  return (
    <svg
      viewBox={`0 0 ${vw} ${vh}`}
      data-layout={wideLayout ? 'wide' : 'standard'}
      data-drawing-left={drawLeft}
      data-drawing-right={drawRight}
      data-drawing-top={drawTop}
      data-drawing-bottom={tipBot}
      data-center-x={cx}
      data-profile-scale={s}
      data-anchor-top-y={topY}
      data-anchor-tip-y={flBotY}
      data-anchor-flute-y={cutTopY}
      data-anchor-collet-y={colletFaceY}
      data-anchor-cutter-left={cutterLeft}
      data-anchor-cutter-right={cutterRight}
      data-anchor-shank-left={shankLeft}
      data-anchor-shank-right={shankRight}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id="tdSkGrad" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%"   stopColor="#2a333c" />
          <stop offset="30%"  stopColor="#6a7a88" />
          <stop offset="70%"  stopColor="#6a7a88" />
          <stop offset="100%" stopColor="#2a333c" />
        </linearGradient>
        <linearGradient id="tdFlGrad" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%"   stopColor="#0006" />
          <stop offset="28%"  stopColor={fluteColor} />
          <stop offset="72%"  stopColor={fluteColor} />
          <stop offset="100%" stopColor="#0006" />
        </linearGradient>
      </defs>

      {/* Background */}
      <rect width={vw} height={vh} fill="var(--diagram-ground)" rx={6} />

      {/* ── Dashed centerline axis ── */}
      <line x1={cx} y1={topY - 6} x2={cx} y2={flBotY + 10} stroke="var(--diagram-axis)" strokeWidth="0.75" strokeDasharray="3,3" />

      {/* ── Non-cutting region (neck / shoulder / shank), metal gradient ── */}
      {dNonCut && (
        <path className="tool-diagram-silhouette" d={dNonCut} fill="url(#tdSkGrad)" stroke="var(--diagram-shank-outline)" strokeWidth="0.5" />
      )}

      {/* ── Cutting region (tip is PART of this silhouette), flute/coating color ── */}
      {dCut && (
        <path className="tool-diagram-silhouette" d={dCut} fill="url(#tdFlGrad)" stroke={COATING_INK[coating]} strokeWidth="0.6" />
      )}

      {/* Helix lines on the cutting region (decorative, straight-walled kinds) */}
      {flH > 24 && (meta.profileKind === 'flat' || meta.profileKind === 'ball' || meta.profileKind === 'bull') && (
        [0.2, 0.5, 0.78].map((t, i) => {
          const y0 = cutTopY + flH * t
          const y1 = cutTopY + flH * Math.min(1, t + 0.18)
          return (
            <path
              key={i}
              d={`M ${cx - cutHW + 3} ${y0} Q ${cx + 4} ${(y0 + y1) / 2} ${cx + cutHW - 3} ${y1}`}
              stroke="var(--diagram-material-helix)" strokeWidth="1" fill="none"
            />
          )
        })
      )}

      {/* Dividing line between cutting region and the non-cutting body */}
      {dNonCut && cutTopZ < maxZ - 1e-6 && (
        <line
          x1={cx - cutHW} y1={cutTopY}
          x2={cx + cutHW} y2={cutTopY}
          stroke="var(--diagram-material-seam)" strokeWidth="0.75"
        />
      )}

      {/* ── Collet body flanges (sits above collet face line, grips the shank) ── */}
      {showLbh && colletFaceY > drawTop + 2 && (
        <>
          <rect
            x={cx - colletHW} y={colletFaceY - 12}
            width={Math.max(0, colletHW - shankHW)} height={12}
            fill="var(--diagram-collet-fill)" stroke="var(--diagram-collet-outline)" strokeWidth="0.75" rx="1"
          />
          <rect
            x={cx + shankHW} y={colletFaceY - 12}
            width={Math.max(0, colletHW - shankHW)} height={12}
            fill="var(--diagram-collet-fill)" stroke="var(--diagram-collet-outline)" strokeWidth="0.75" rx="1"
          />
        </>
      )}

      {/* ── Collet face reference line (orange) ── */}
      {showLbh && (
        <line
          x1={cx - colletHW} y1={colletFaceY}
          x2={cx + colletHW} y2={colletFaceY}
          stroke="var(--diagram-collet-face)" strokeWidth="1.5"
        />
      )}

      {/* Axial drafting dimensions: shortest innermost, longest outermost. */}
      {axialWithColumns.map((dimension) => {
        const labelY = (dimension.y1 + dimension.y2) / 2
        return (
          <g className="tool-diagram-dimension" data-dimension-key={dimension.key} key={dimension.key}>
            <line
              className="tool-diagram-dimension-line"
              data-dimension-key={dimension.key}
              data-dimension-kind="vertical"
              x1={dimension.x} y1={dimension.y1}
              x2={dimension.x} y2={dimension.y2}
              stroke={dimension.color} strokeWidth="1"
            />
            <line x1={dimension.x - 4} y1={dimension.y1} x2={dimension.x + 4} y2={dimension.y1} stroke={dimension.color} strokeWidth="1" />
            <line x1={dimension.x - 4} y1={dimension.y2} x2={dimension.x + 4} y2={dimension.y2} stroke={dimension.color} strokeWidth="1" />
            <line
              className="tool-diagram-extension-line"
              x1={dimension.sourceX1 + DIM_EXTENSION_GAP} y1={dimension.y1}
              x2={dimension.x - 2} y2={dimension.y1}
              stroke={dimension.extensionColor} strokeWidth="0.6"
            />
            <line
              className="tool-diagram-extension-line"
              x1={dimension.sourceX2 + DIM_EXTENSION_GAP} y1={dimension.y2}
              x2={dimension.x - 2} y2={dimension.y2}
              stroke={dimension.extensionColor} strokeWidth="0.6"
            />
            <text
              className="tool-diagram-dimension-label"
              data-dimension-label-for={dimension.key}
              x={dimension.x + AXIAL_LABEL_OFFSET} y={labelY}
              textAnchor="middle"
              transform={`rotate(-90 ${dimension.x + AXIAL_LABEL_OFFSET} ${labelY})`}
              fontSize={ANNOT_FONT} fontWeight="600" fill={dimension.color} fontFamily="monospace"
              stroke="var(--diagram-ground)" strokeWidth="3" paintOrder="stroke" strokeLinejoin="round"
            >
              {dimension.label}
            </text>
          </g>
        )
      })}

      {/* Cutter diameter below the tip, spanning the computed cutting width. */}
      <g className="tool-diagram-dimension" data-dimension-key="cutter-diameter">
        <line
          className="tool-diagram-extension-line"
          x1={cutterLeft} y1={Y(cutterAnchorZ) + DIM_EXTENSION_GAP}
          x2={cutterLeft} y2={cutterLineY - 2}
          stroke="var(--diagram-diameter-extension)" strokeWidth="0.6"
        />
        <line
          className="tool-diagram-extension-line"
          x1={cutterRight} y1={Y(cutterAnchorZ) + DIM_EXTENSION_GAP}
          x2={cutterRight} y2={cutterLineY - 2}
          stroke="var(--diagram-diameter-extension)" strokeWidth="0.6"
        />
        <line
          className="tool-diagram-dimension-line"
          data-dimension-key="cutter-diameter"
          data-dimension-kind="horizontal"
          x1={cutterLeft} y1={cutterLineY}
          x2={cutterRight} y2={cutterLineY}
          stroke="var(--diagram-diameter-line)" strokeWidth="1"
        />
        {smallCutterDimension ? (
          <>
            <path d={`M ${cutterLeft - 7} ${cutterLineY - 4} L ${cutterLeft} ${cutterLineY} L ${cutterLeft - 7} ${cutterLineY + 4}`} fill="none" stroke="var(--diagram-diameter-line)" strokeWidth="1" />
            <path d={`M ${cutterRight + 7} ${cutterLineY - 4} L ${cutterRight} ${cutterLineY} L ${cutterRight + 7} ${cutterLineY + 4}`} fill="none" stroke="var(--diagram-diameter-line)" strokeWidth="1" />
          </>
        ) : (
          <>
            <line x1={cutterLeft} y1={cutterLineY - 4} x2={cutterLeft} y2={cutterLineY + 4} stroke="var(--diagram-diameter-line)" strokeWidth="1" />
            <line x1={cutterRight} y1={cutterLineY - 4} x2={cutterRight} y2={cutterLineY + 4} stroke="var(--diagram-diameter-line)" strokeWidth="1" />
          </>
        )}
        <text
          className="tool-diagram-dimension-label"
          data-dimension-label-for="cutter-diameter"
          x={smallCutterDimension ? cutterRight + 5 : cx}
          y={cutterLineY + ANNOT_FONT + (smallCutterDimension ? 1 : 2)}
          textAnchor={smallCutterDimension ? 'start' : 'middle'}
          fontSize={ANNOT_FONT} fontWeight="600" fill="var(--diagram-diameter-label)" fontFamily="monospace"
          stroke="var(--diagram-ground)" strokeWidth="3" paintOrder="stroke" strokeLinejoin="round"
        >
          {cutterLabel}
        </text>
      </g>

      {/* A differing shank gets the same horizontal drafting convention. */}
      {shankDiffers && (
        <g className="tool-diagram-dimension" data-dimension-key="shank-diameter">
          <line className="tool-diagram-extension-line" x1={shankLeft} y1={topY - DIM_EXTENSION_GAP} x2={shankLeft} y2={shankLineY + 2} stroke="var(--diagram-shank-extension)" strokeWidth="0.6" />
          <line className="tool-diagram-extension-line" x1={shankRight} y1={topY - DIM_EXTENSION_GAP} x2={shankRight} y2={shankLineY + 2} stroke="var(--diagram-shank-extension)" strokeWidth="0.6" />
          <line
            className="tool-diagram-dimension-line"
            data-dimension-key="shank-diameter"
            data-dimension-kind="horizontal"
            x1={shankLeft} y1={shankLineY}
            x2={shankRight} y2={shankLineY}
            stroke="var(--diagram-shank-dimension)" strokeWidth="1"
          />
          <line x1={shankLeft} y1={shankLineY - 4} x2={shankLeft} y2={shankLineY + 4} stroke="var(--diagram-shank-dimension)" strokeWidth="1" />
          <line x1={shankRight} y1={shankLineY - 4} x2={shankRight} y2={shankLineY + 4} stroke="var(--diagram-shank-dimension)" strokeWidth="1" />
          <text
            className="tool-diagram-dimension-label"
            data-dimension-label-for="shank-diameter"
            x={cx} y={shankLineY - 6} textAnchor="middle"
            fontSize={ANNOT_FONT} fontWeight="600" fill="var(--diagram-shank-label)" fontFamily="monospace"
            stroke="var(--diagram-ground)" strokeWidth="3" paintOrder="stroke" strokeLinejoin="round"
          >
            {shankLabel}
          </text>
        </g>
      )}

      {/* Angle notes attach directly to a profile flank near the apex. */}
      {hasTipAngle && (
        <g className="tool-diagram-dimension" data-dimension-key="tip-angle">
          <line
            className="tool-diagram-dimension-line"
            data-dimension-key="tip-angle"
            data-dimension-kind="angular"
            x1={angleStartX} y1={angleStartY}
            x2={angleEndX} y2={angleEndY}
            stroke="var(--diagram-angle-leader)" strokeWidth="0.9"
          />
          <circle cx={angleStartX} cy={angleStartY} r="1.5" fill="var(--diagram-angle-label)" />
          <text
            className="tool-diagram-dimension-label"
            data-dimension-label-for="tip-angle"
            x={angleEndX - 4} y={angleEndY + 4} textAnchor="end"
            fontSize={ANNOT_FONT} fontWeight="600" fill="var(--diagram-angle-label)" fontFamily="monospace"
            stroke="var(--diagram-ground)" strokeWidth="3" paintOrder="stroke" strokeLinejoin="round"
          >
            {angleLabel}
          </text>
        </g>
      )}

      {/* ── Tool type + coating, UPPER-RIGHT corner (clear of the Ø callouts) ── */}
      <text x={hasTipAngle ? 6 : vw - 6} y={20} textAnchor={hasTipAngle ? 'start' : 'end'} fontSize={ANNOT_FONT} fontWeight="600" fill="var(--diagram-type-label)">
        {words(`ToolDiagram.toolTypes.${type}`)}
      </text>
      {coating !== 'none' && (
        <text x={hasTipAngle ? 6 : vw - 6} y={34} textAnchor={hasTipAngle ? 'start' : 'end'} fontSize={ANNOT_SUB} fontWeight="600" fill={COATING_INK[coating]}>{words("ToolDiagram.coating", { value1: coating.toUpperCase() })}</text>
      )}
    </svg>
  )
}

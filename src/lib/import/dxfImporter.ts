import type { Vec2, Layer2D, Loop2D, BoundingBox } from '../../types'
import { joinSegments, computeBBox2D, centerLoops } from '../geometry/path2d'
import type { JoinReport } from '../geometry/path2d'
import type { Import2DResult } from './svgImporter'
import { CHORD_LEN_MM, sampleEllipse, sampleFitPoints, sampleNurbs } from './dxfCurves'
import { parseBlocks, insertName, isModelSpaceInsert, insertPlacements } from './dxfInsert'
import type { DxfPair as Pair, DxfBlock } from './dxfInsert'

// DXF indexed color → CSS hex (colors 1-7 only; rest → steel blue)
const ACI: Record<number, string> = {
  1: '#ff4c4c', 2: '#ffd740', 3: '#4cff88', 4: '#40e0d0',
  5: '#4ac3ff', 6: '#ff80ab', 7: '#cccccc',
}
const defaultLayerColor = '#4ac3ff'

// Layers that are drawing sheet annotations, not part geometry.
// These are hidden by default so the actual part is immediately visible.
const ANNOTATION_PATTERNS = [
  /^page[_\-]?border/i, /^title[_\-]?block/i, /^format$/i,
  /^frame$/i, /^defpoints$/i, /^tb_/i, /^sheet/i,
  /^border$/i, /^revision/i, /^notes?$/i, /^dims?$/i,
  /centermark/i, /center[_\-]?line/i,
]

function isAnnotationLayer(name: string): boolean {
  return ANNOTATION_PATTERNS.some(rx => rx.test(name))
}

function aciToHex(n: number): string { return ACI[n] ?? defaultLayerColor }

// ── DXF tokeniser ─────────────────────────────────────────────────────────────

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r?\n/)
  const pairs: Pair[] = []
  let i = 0
  while (i + 1 < lines.length) {
    const code = parseInt(lines[i].trim(), 10)
    const value = lines[i + 1].trim()
    if (!isNaN(code)) pairs.push({ code, value })
    i += 2
  }
  return pairs
}

function parseNum(s: string): number { return parseFloat(s) || 0 }

// ── Drawing units (HEADER $INSUNITS) ──────────────────────────────────────────
//
// ADR-0022: read the drawing's own units and convert to millimetres; never
// refuse an inch file. $INSUNITS is a HEADER variable: group code 9 names it,
// the immediately following group-70 value is the unit code. 0/unset means
// "unitless" and stays millimetres, exactly as before this fix.
const INSUNITS_MM: Record<number, number> = {
  1: 25.4,   // inches
  2: 304.8,  // feet
  4: 1,      // millimetres
  5: 10,     // centimetres
  6: 1000,   // metres
}
const INSUNITS_LABEL: Record<number, string> = {
  1: 'inches', 2: 'feet', 4: 'millimetres', 5: 'centimetres', 6: 'metres',
}

function parseInsUnits(pairs: Pair[]): number {
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i].code === 9 && pairs[i].value === '$INSUNITS') {
      const next = pairs[i + 1]
      if (next.code === 70) return parseInt(next.value, 10) || 0
    }
  }
  return 0
}

// ── Arc sampling ──────────────────────────────────────────────────────────────

const DEG = Math.PI / 180

function sampleArc(
  cx: number, cy: number, r: number,
  startDeg: number, endDeg: number,
  segLenMM = CHORD_LEN_MM
): Vec2[] {
  const startRad = startDeg * DEG
  let   endRad   = endDeg   * DEG
  if (endRad <= startRad) endRad += 2 * Math.PI
  const span = endRad - startRad
  const nSeg = Math.max(4, Math.ceil((r * span) / segLenMM))
  const pts: Vec2[] = []

  // Use exact analytical endpoints so they match adjacent LINE endpoints
  pts.push({ x: cx + r * Math.cos(startRad), y: cy + r * Math.sin(startRad) })
  for (let i = 1; i < nSeg; i++) {
    const a = startRad + span * i / nSeg
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  pts.push({ x: cx + r * Math.cos(endRad), y: cy + r * Math.sin(endRad) })
  return pts
}

/**
 * The arc an LWPOLYLINE bulge (group 42) describes from `p1` to `p2`.
 * bulge = tan(sweep/4); positive sweeps counter-clockwise, negative clockwise,
 * zero is a straight segment. Sampled with `sampleArc` (the ARC entity's
 * chord length) in two halves so the arc's apex is always a sample - the
 * apex of an obround end is its extreme point. The ends are the vertices
 * themselves so the polyline stays joined exactly.
 */
function sampleBulge(p1: Vec2, p2: Vec2, bulge: number): Vec2[] {
  const dx = p2.x - p1.x, dy = p2.y - p1.y
  const c = Math.hypot(dx, dy)
  if (c < 1e-12 || Math.abs(bulge) < 1e-12) return [p1, p2]
  const ux = dx / c, uy = dy / c
  // Signed distance from the chord midpoint to the centre, along the left normal.
  const d = c * (1 - bulge * bulge) / (4 * bulge)
  const cx = (p1.x + p2.x) / 2 - uy * d
  const cy = (p1.y + p2.y) / 2 + ux * d
  const r = c * (1 + bulge * bulge) / (4 * Math.abs(bulge))
  const sweepDeg = 4 * Math.atan(bulge) / DEG
  const a1 = Math.atan2(p1.y - cy, p1.x - cx) / DEG
  // sampleArc runs counter-clockwise, so a clockwise arc is sampled from its
  // far end and reversed.
  const lo = bulge > 0 ? a1 : a1 + sweepDeg
  const half = Math.abs(sweepDeg) / 2
  const pts = [
    ...sampleArc(cx, cy, r, lo, lo + half),
    ...sampleArc(cx, cy, r, lo + half, lo + 2 * half).slice(1),
  ]
  if (bulge < 0) pts.reverse()
  pts[0] = p1
  pts[pts.length - 1] = p2
  return pts
}

// ── Layer table parser ────────────────────────────────────────────────────────

function parseLayers(pairs: Pair[]): Map<string, Layer2D> {
  const map = new Map<string, Layer2D>()
  let inTables = false, inLayerEntry = false
  let curName = '', curColor = 7

  const commitLayer = () => {
    if (!curName) return
    map.set(curName, {
      id: curName, name: curName,
      color: aciToHex(curColor),
      visible: !isAnnotationLayer(curName),
    })
  }

  for (const { code, value } of pairs) {
    if (code === 2 && value === 'TABLES') { inTables = true; continue }
    if (code === 0 && value === 'ENDSEC') { inTables = false; continue }
    if (!inTables) continue

    // ANY code=0 ends the current LAYER record. The TABLES section holds
    // more tables after LAYER (STYLE, APPID, DIMSTYLE, BLOCK_RECORD...);
    // without this, the last LAYER entry stayed "open" and every later
    // code-2 value overwrote its name, committing a junk pseudo-layer named
    // after the final BLOCK_RECORD (a generated `SW_CENTERMARKSYMBOL_6` block)
    // while the real last layer ('Pocket') lost its table color (B14).
    if (code === 0) {
      if (inLayerEntry) commitLayer()
      inLayerEntry = value === 'LAYER'
      curName = ''; curColor = 7
      continue
    }
    if (inLayerEntry) {
      if (code === 2) curName = value
      if (code === 62) curColor = Math.abs(parseInt(value, 10))
    }
  }
  if (inLayerEntry) commitLayer()

  if (!map.has('0')) {
    map.set('0', { id: '0', name: '0', color: defaultLayerColor, visible: true })
  }
  return map
}

// ── Entity parser ─────────────────────────────────────────────────────────────

/**
 * A CIRCLE keeps its analytic fact until we can prove that the joined loop is
 * still exactly that entity.  This is deliberately not a circle fit: a DXF
 * polygon or a partial arc closed by a chord can sample onto the same circle.
 */
interface AnalyticCircle { center: Vec2; diameter: number }
interface RawSeg { points: Vec2[]; layerName: string; analyticCircle?: AnalyticCircle }

// Loop2D predates DXF analytic provenance. Keep this narrow optional fact on
// the loop rather than abusing Layer2D.holes: those are physical 3D features
// whose depth facts affect drill dispatch. assignStableLoopIds and persistence
// preserve unknown loop fields, so the fact stays bound when the import host
// namespaces loop ids.
type LoopWithImportedCircle = Loop2D & { importedCircleDiameter?: number }

function dist2(a: Vec2, b: Vec2): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function sameClosedSamples(loop: Loop2D, samples: Vec2[]): boolean {
  if (!loop.closed || samples.length < 4) return false
  const boundary = [...samples]
  // CIRCLE is sampled to 359.9999 degrees; joining closes that tiny gap and
  // drops the duplicate end point. Match the boundary it actually handed on.
  if (dist2(boundary[0], boundary.at(-1)!) < 0.05 ** 2) boundary.pop()
  if (boundary.length !== loop.points.length) return false
  const tol2 = 1e-12
  for (let start = 0; start < boundary.length; start++) {
    if (dist2(loop.points[0], boundary[start]) > tol2) continue
    const forward = boundary.every((_, index) =>
      dist2(loop.points[index], boundary[(start + index) % boundary.length]) <= tol2)
    if (forward) return true
    const backward = boundary.every((_, index) =>
      dist2(loop.points[index], boundary[(start - index + boundary.length) % boundary.length]) <= tol2)
    if (backward) return true
  }
  return false
}

// WO-3185: each loop only meets the circles on its layer with its sample count
// and a centroid in a neighbouring grid cell. Matching samples lie within
// 1e-6 mm of each other, so their centroids can never be a whole cell apart;
// sameClosedSamples still decides. Linear instead of loops x circles.
const CIRCLE_CELL_MM = 0.01

function closedSampleKey(points: readonly Vec2[], layerName: string): { key: string; cx: number; cy: number } {
  let sx = 0, sy = 0
  for (const point of points) { sx += point.x; sy += point.y }
  const cx = Math.floor(sx / points.length / CIRCLE_CELL_MM)
  const cy = Math.floor(sy / points.length / CIRCLE_CELL_MM)
  return { key: `${layerName}\u0000${points.length}`, cx, cy }
}

export function linkAnalyticCircles(loops: Loop2D[], segments: readonly RawSeg[]): LoopWithImportedCircle[] {
  const index = new Map<string, Array<{ order: number; segment: RawSeg }>>()
  segments.forEach((segment, order) => {
    if (segment.analyticCircle === undefined || segment.points.length < 4) return
    // The same tiny closing gap sameClosedSamples drops.
    const boundary = dist2(segment.points[0], segment.points.at(-1)!) < 0.05 ** 2
      ? segment.points.slice(0, -1)
      : segment.points
    const { key, cx, cy } = closedSampleKey(boundary, segment.layerName)
    const cell = `${key}\u0000${cx}\u0000${cy}`
    const list = index.get(cell)
    if (list) list.push({ order, segment })
    else index.set(cell, [{ order, segment }])
  })
  return loops.map(loop => {
    if (!loop.closed || loop.points.length === 0) return loop
    const { key, cx, cy } = closedSampleKey(loop.points, loop.layerId)
    // The earliest matching segment wins, as the old segments.find did.
    let best: { order: number; segment: RawSeg } | undefined
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const entry of index.get(`${key}\u0000${cx + dx}\u0000${cy + dy}`) ?? []) {
          if (best && entry.order > best.order) break
          if (sameClosedSamples(loop, entry.segment.points)) { best = entry; break }
        }
      }
    }
    const source = best?.segment
    return source?.analyticCircle
      ? { ...loop, importedCircleDiameter: source.analyticCircle.diameter }
      : loop
  })
}

function transformedAnalyticCircle(
  circle: AnalyticCircle | undefined,
  points: readonly Vec2[],
  transform: (point: Vec2) => Vec2,
): AnalyticCircle | undefined {
  if (!circle) return undefined
  const center = transform(circle.center)
  const radii = points.map(point => Math.hypot(transform(point).x - center.x, transform(point).y - center.y))
  const radius = radii[0]
  // INSERT rotation, translation, mirroring and UNIFORM scale preserve a
  // circle. Unequal X/Y scaling makes an ellipse, so keep it unknown.
  if (!(radius > 0) || radii.some(value => Math.abs(value - radius) > Math.max(1e-9, radius * 1e-10))) return undefined
  return { center, diameter: radius * 2 }
}

// Geometry entity types we actively parse.
// WO-1841 added SPLINE, ELLIPSE and the legacy heavyweight POLYLINE: rule 11 -
// we can evaluate a NURBS curve and an ellipse, so we do, instead of letting a
// Fusion/SolidWorks/Inkscape drawing lose its curved boundary on import.
const GEO_TYPES = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'SPLINE', 'ELLIPSE', 'POLYLINE', 'INSERT'])

interface ParsedEntities { segs: RawSeg[]; skipped: Map<string, number> }

function parseEntities(pairs: Pair[], unitScale: number, blocks: Map<string, DxfBlock>, depth = 0): ParsedEntities {
  const segs: RawSeg[] = []
  const skipped = new Map<string, number>()
  let inEntities = false
  let entityType = ''
  let layerName  = '0'
  let insertPairs: Pair[] = []

  // Every coordinate/radius/length is reported in the drawing's own units;
  // multiply once here to hand the rest of the pipeline millimetres.
  const s = (v: number) => v * unitScale

  let x0 = 0, y0 = 0, x1 = 0, y1 = 0
  let cx = 0, cy = 0, r = 0, startAngle = 0, endAngle = 360
  let lwVerts: Vec2[] = [], lwClosed = false, lwX = NaN, lwY = NaN
  // lwBulges[i] is the bulge of the segment from vertex i to the next one.
  let lwBulges: number[] = []

  // SPLINE (WO-1841). Control points and fit points are stored already scaled;
  // knots, weights and flags are dimensionless.
  let spDeg = 3, spFlags = 0
  let spKnots: number[] = [], spWeights: number[] = []
  let spCtrl: Vec2[] = [], spFit: Vec2[] = []
  let spX = NaN, spFitX = NaN

  // ELLIPSE (WO-1841). 11/21 is the major-axis endpoint RELATIVE to the centre;
  // 41/42 are parameters in radians, so neither the ratio nor they are scaled.
  let elCx = 0, elCy = 0, elMx = 0, elMy = 0
  let elRatio = 1, elStart = 0, elEnd = 2 * Math.PI

  // Legacy heavyweight POLYLINE (WO-1841). Its geometry arrives as separate
  // VERTEX entity records terminated by SEQEND, so unlike every other entity
  // this state must survive the code-0 boundaries between those children.
  let polyActive = false, polyMesh = false, polyClosed = false, polyLayer = '0'
  let polyVerts: Vec2[] = [], polyBulges: number[] = []
  let vX = NaN, vY = NaN, vBulge = 0

  // An entity we tried to turn into points and could not (an empty SPLINE
  // record, a zero-length ellipse axis, a polyface mesh) is named in the import
  // report exactly like an entity type we never parse - never silence (WO-1840).
  const noteSkipped = (type: string) => { skipped.set(type, (skipped.get(type) ?? 0) + 1) }

  const resetPoly = () => {
    polyActive = false; polyMesh = false; polyClosed = false; polyLayer = '0'
    polyVerts = []; polyBulges = []
  }

  const emitPolyline = () => {
    if (!polyMesh && polyVerts.length >= 2) {
      // Same bulge walk as LWPOLYLINE: a closed polyline's last bulge belongs
      // to the closing segment.
      const nSeg = polyClosed ? polyVerts.length : polyVerts.length - 1
      const pts: Vec2[] = [polyVerts[0]]
      for (let i = 0; i < nSeg; i++) {
        const a = polyVerts[i], b = polyVerts[(i + 1) % polyVerts.length]
        pts.push(...sampleBulge(a, b, polyBulges[i] ?? 0).slice(1))
      }
      segs.push({ points: pts, layerName: polyLayer })
    } else {
      // A polygon/polyface mesh or a vertex-less record: not a 2D outline.
      noteSkipped('POLYLINE')
    }
    resetPoly()
  }

  const flush = () => {
    if (!inEntities) return
    switch (entityType) {
      case 'INSERT': {
        if (!isModelSpaceInsert(insertPairs)) break
        const name = insertName(insertPairs)
        // These reserved blocks hold layout contents, not reusable parts.
        if (/^[*$](model_space|paper_space\d*)$/i.test(name)) break
        const block = blocks.get(name.toUpperCase())
        if (!block || depth >= 12) {
          noteSkipped(`INSERT ${name || '(unnamed)'}`)
          break
        }
        const children = parseEntities([
          { code: 0, value: 'SECTION' }, { code: 2, value: 'ENTITIES' },
          ...block.entities, { code: 0, value: 'ENDSEC' },
        ], unitScale, blocks, depth + 1)
        for (const transform of insertPlacements(insertPairs, block, unitScale)) {
          for (const child of children.segs) {
            const points = child.points.map(transform)
            segs.push({ points,
              layerName: child.layerName === '0' ? layerName : child.layerName,
              analyticCircle: transformedAnalyticCircle(child.analyticCircle, child.points, transform),
            })
          }
          for (const [type, count] of children.skipped) {
            skipped.set(type, (skipped.get(type) ?? 0) + count)
          }
        }
        break
      }
      case 'LINE':
        if (Math.hypot(x1 - x0, y1 - y0) > 1e-9)
          segs.push({ points: [{ x: s(x0), y: s(y0) }, { x: s(x1), y: s(y1) }], layerName })
        break
      case 'ARC':
        if (r > 0) segs.push({ points: sampleArc(s(cx), s(cy), s(r), startAngle, endAngle), layerName })
        break
      case 'CIRCLE':
        if (r > 0) {
          const center = { x: s(cx), y: s(cy) }
          segs.push({
            points: sampleArc(center.x, center.y, s(r), 0, 359.9999),
            layerName,
            analyticCircle: { center, diameter: s(r) * 2 },
          })
        }
        break
      case 'LWPOLYLINE': {
        // Flush any pending incomplete vertex
        if (!isNaN(lwX) && !isNaN(lwY)) lwVerts.push({ x: s(lwX), y: s(lwY) })
        if (lwVerts.length >= 2) {
          // A closed polyline's last bulge belongs to the closing segment.
          const nSeg = lwClosed ? lwVerts.length : lwVerts.length - 1
          const pts: Vec2[] = [lwVerts[0]]
          for (let i = 0; i < nSeg; i++) {
            const a = lwVerts[i], b = lwVerts[(i + 1) % lwVerts.length]
            pts.push(...sampleBulge(a, b, lwBulges[i] ?? 0).slice(1))
          }
          segs.push({ points: pts, layerName })
        }
        break
      }
      case 'SPLINE': {
        // Control points are the real curve; fit points are the fallback for
        // the records that carry nothing else (see sampleFitPoints).
        const pts = spCtrl.length >= 2
          ? sampleNurbs(spCtrl, spDeg, spKnots, spWeights.length === spCtrl.length ? spWeights : undefined)
          : sampleFitPoints(spFit, (spFlags & 1) === 1)
        if (pts.length >= 2) segs.push({ points: pts, layerName })
        else noteSkipped('SPLINE')
        break
      }
      case 'ELLIPSE': {
        const pts = sampleEllipse(
          { x: s(elCx), y: s(elCy) }, { x: s(elMx), y: s(elMy) },
          elRatio, elStart, elEnd
        )
        if (pts.length >= 2) segs.push({ points: pts, layerName })
        else noteSkipped('ELLIPSE')
        break
      }
      case 'POLYLINE':
        // The POLYLINE record itself draws nothing - it only opens the run of
        // VERTEX children. Its layer is read here, once its group 8 has arrived.
        polyLayer = layerName
        break
      case 'VERTEX':
        if (polyActive && !polyMesh && !isNaN(vX) && !isNaN(vY)) {
          polyVerts.push({ x: s(vX), y: s(vY) })
          polyBulges[polyVerts.length - 1] = vBulge
        }
        break
    }
    // Reset all entity state
    x0 = y0 = x1 = y1 = cx = cy = r = startAngle = 0; endAngle = 360
    lwVerts = []; lwBulges = []; lwClosed = false; lwX = NaN; lwY = NaN
    spDeg = 3; spFlags = 0; spKnots = []; spWeights = []; spCtrl = []; spFit = []
    spX = NaN; spFitX = NaN
    elCx = elCy = elMx = elMy = 0; elRatio = 1; elStart = 0; elEnd = 2 * Math.PI
    vX = NaN; vY = NaN; vBulge = 0
    entityType = ''; layerName = '0'
    insertPairs = []
  }

  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i]
    // A block named ENTITIES is not the ENTITIES section (WO-2288).
    if (code === 2 && value === 'ENTITIES' && pairs[i - 1]?.code === 0 && pairs[i - 1].value === 'SECTION') {
      inEntities = true; continue
    }
    if (code === 0 && value === 'ENDSEC') {
      flush()
      if (polyActive) emitPolyline()
      inEntities = false
      continue
    }
    if (!inEntities) continue

    // ANY code=0 in the entities section marks an entity boundary.
    // This prevents unknown entity types (MTEXT, DIMENSION, HATCH, etc.)
    // from leaking their group-code-10/20 values into adjacent geometry.
    if (code === 0) {
      flush()
      // A legacy POLYLINE stays open across its VERTEX children and closes on
      // the first record that is not one (SEQEND in a well-formed file, but any
      // other entity ends it too - a truncated file must not swallow the run).
      if (polyActive && value !== 'VERTEX') emitPolyline()

      if (value === 'VERTEX' && polyActive) {
        entityType = 'VERTEX'
      } else if (value === 'SEQEND') {
        // A structural terminator, never geometry: not reportable as skipped.
        entityType = ''
      } else if (GEO_TYPES.has(value)) {
        entityType = value
        if (value === 'POLYLINE') { resetPoly(); polyActive = true }
      } else {
        entityType = ''
        // Every non-geometry entity record (TEXT, MTEXT, DIMENSION, HATCH,
        // ...) that starts here, named for the import report.
        skipped.set(value, (skipped.get(value) ?? 0) + 1)
      }
      continue
    }

    if (entityType === 'INSERT') insertPairs.push({ code, value })
    if (code === 8) { layerName = value; continue }  // layer name

    switch (entityType) {
      case 'LINE':
        if (code === 10) x0 = parseNum(value)
        else if (code === 20) y0 = parseNum(value)
        else if (code === 11) x1 = parseNum(value)
        else if (code === 21) y1 = parseNum(value)
        break
      case 'ARC':
      case 'CIRCLE':
        if (code === 10) cx = parseNum(value)
        else if (code === 20) cy = parseNum(value)
        else if (code === 40) r  = parseNum(value)
        else if (code === 50) startAngle = parseNum(value)
        else if (code === 51) endAngle   = parseNum(value)
        break
      case 'LWPOLYLINE':
        if (code === 70) { lwClosed = (parseInt(value, 10) & 1) === 1; break }
        if (code === 10) {
          // New X arrives: flush previous complete vertex if present
          if (!isNaN(lwX) && !isNaN(lwY)) { lwVerts.push({ x: s(lwX), y: s(lwY) }); lwY = NaN }
          lwX = parseNum(value)
        } else if (code === 20) {
          lwY = parseNum(value)
          if (!isNaN(lwX)) { lwVerts.push({ x: s(lwX), y: s(lwY) }); lwX = NaN; lwY = NaN }
        } else if (code === 42) {
          // Bulge follows its vertex's 10/20 pair; it curves that vertex's
          // outgoing segment. Dimensionless, so no unit scale.
          if (lwVerts.length > 0) lwBulges[lwVerts.length - 1] = parseNum(value)
        }
        // Elevation (38), width (40/41), etc. do not change the 2D shape.
        break
      case 'SPLINE':
        if (code === 70) spFlags = parseInt(value, 10) || 0
        else if (code === 71) spDeg = parseInt(value, 10) || 0
        else if (code === 40) spKnots.push(parseNum(value))
        else if (code === 41) spWeights.push(parseNum(value))
        else if (code === 10) spX = parseNum(value)
        else if (code === 20) {
          if (!isNaN(spX)) { spCtrl.push({ x: s(spX), y: s(parseNum(value)) }); spX = NaN }
        } else if (code === 11) spFitX = parseNum(value)
        else if (code === 21) {
          if (!isNaN(spFitX)) { spFit.push({ x: s(spFitX), y: s(parseNum(value)) }); spFitX = NaN }
        }
        // Counts (72/73/74) and tolerances (42/43/44) are redundant with the
        // values themselves; tangents (12/13) only matter to the fit-point solve.
        break
      case 'ELLIPSE':
        if (code === 10) elCx = parseNum(value)
        else if (code === 20) elCy = parseNum(value)
        else if (code === 11) elMx = parseNum(value)
        else if (code === 21) elMy = parseNum(value)
        else if (code === 40) elRatio = parseNum(value)
        else if (code === 41) elStart = parseNum(value)
        else if (code === 42) elEnd = parseNum(value)
        break
      case 'POLYLINE':
        if (code === 70) {
          const f = parseInt(value, 10) || 0
          polyClosed = (f & 1) === 1
          // Bits 16/64 make this a polygon or polyface MESH, not an outline.
          polyMesh = (f & (16 | 64)) !== 0
        }
        break
      case 'VERTEX':
        // The vertex's own group 70 is vertex flags, not the polyline's closed
        // flag, so it is deliberately not read here.
        if (code === 10) vX = parseNum(value)
        else if (code === 20) vY = parseNum(value)
        else if (code === 42) vBulge = parseNum(value)
        break
    }
  }

  flush()
  if (polyActive) emitPolyline()
  return { segs, skipped }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * `importDXF`'s result, richer than the shared `Import2DResult`: it names the
 * drawing unit that was read from `$INSUNITS` and the millimetres-per-unit
 * factor applied, so a caller can tell the operator what happened (ADR-0022)
 * without a second dialog.
 */
export interface DxfImport2DResult extends Import2DResult {
  /** Millimetres per drawing unit actually applied (1 when none/unset). */
  unitScale: number
  /** Human label of the unit read from the file (e.g. "inches"). */
  unitLabel: string
  /** WO-1840: what the import joined and what it left out. */
  report: DxfImportReport
}

// WO-1840: says what the import did without changing what it does (rule 11 -
// we still join at JOIN_TOL; we only report it) and what it dropped silently
// before (unknown entity types).
export interface DxfImportReport {
  gapsClosed: number
  largestGapMM: number
  openChains: number
  // WO-1890: doubled/overlapping segments merged before joining, and points
  // where the join had to choose between branches (see joinSegments). Always
  // set by importDXF; optional only so older report literals still type-check.
  overlapsMerged?: number
  branchPoints?: number
  // WO-1900: which origin the returned loops carry - the drawing's own file
  // coordinates ('drawing') or re-centred on their bounding box ('centred').
  // Always set by importDXF; optional only so older report literals still
  // type-check.
  origin?: 'drawing' | 'centred'
  skipped: Array<{ type: string; count: number }>
}

// WO-1900: how the imported loops sit in LienCAM's coordinate space. Default
// (false) is exactly today's behaviour - the loops are re-centred on their
// bounding box by centerLoops, discarding the drawing's own datum. With
// `keepOrigin` true the file's coordinates survive, so several DXFs drawn
// against one datum (or a part dimensioned from a corner) stay registered.
export interface DxfImportOptions {
  keepOrigin?: boolean
}

export function importDXF(dxfText: string, options: DxfImportOptions = {}): DxfImport2DResult {
  const keepOrigin = options.keepOrigin === true
  const pairs    = tokenize(dxfText)
  const insUnits = parseInsUnits(pairs)
  const unitScale = INSUNITS_MM[insUnits] ?? 1
  const unitLabel = INSUNITS_LABEL[insUnits] ?? 'millimetres'
  const layerMap = parseLayers(pairs)
  const { segs: rawSegs, skipped } = parseEntities(pairs, unitScale, parseBlocks(pairs))
  const skippedList = Array.from(skipped, ([type, count]) => ({ type, count }))

  if (rawSegs.length === 0) {
    // No usable entities at all: no layer owns geometry, so no Layer2D survives
    // (same zero-loop rule as below). Still report anything skipped.
    const report: DxfImportReport = {
      gapsClosed: 0, largestGapMM: 0, openChains: 0, overlapsMerged: 0, branchPoints: 0,
      origin: keepOrigin ? 'drawing' : 'centred', skipped: skippedList,
    }
    return { loops: [], layers: [], boundingBox: emptyBBox(), unitScale, unitLabel, report }
  }

  // Group segments by layer; create layer entry if encountered in entities but not in table
  const byLayer = new Map<string, Vec2[][]>()
  for (const { points, layerName } of rawSegs) {
    const arr = byLayer.get(layerName) ?? []
    arr.push(points)
    byLayer.set(layerName, arr)
    if (!layerMap.has(layerName)) {
      layerMap.set(layerName, {
        id: layerName, name: layerName,
        color: defaultLayerColor,
        visible: !isAnnotationLayer(layerName),
      })
    }
  }

  // One join report summed across every layer's own joinSegments call - a
  // gap or open chain on any layer belongs to the file, not the layer.
  const joinReport: JoinReport = { gapsClosed: 0, largestGapMM: 0, openChains: 0, overlapsMerged: 0, branchPoints: 0 }
  let allLoops: Loop2D[] = []
  for (const [layerName, segs] of byLayer) {
    allLoops = allLoops.concat(joinSegments(segs, layerName, joinReport))
  }

  // Provenance only survives when the joined boundary is byte-for-byte the
  // sampled CIRCLE boundary. A branch, overlap rewrite or extra segment makes
  // the result unknown instead of attaching a size to altered geometry.
  allLoops = linkAnalyticCircles(allLoops, rawSegs)

  // WO-1900: the drawing's own origin is kept only when asked for. Default
  // re-centres exactly as before, so the default output is byte-identical.
  if (!keepOrigin) allLoops = centerLoops(allLoops)

  // Drop layers that ended up owning no loops (LAYER table entries whose
  // entities are all unparsed annotation types - TEXT/DIMENSION - or
  // sheet-format junk like '0'/'FORMAT'). A layer with zero loops contributes
  // nothing drawable but clutters the tree. Same rule as the SVG importer (B14,
  // DXF twin of the B5 defs fix).
  const usedLayerIds = new Set(allLoops.map(l => l.layerId))
  const layersWithGeometry = Array.from(layerMap.values()).filter(l => usedLayerIds.has(l.id))

  const bb2 = computeBBox2D(allLoops)
  const bbox: BoundingBox = {
    min: { x: bb2.min.x, y: bb2.min.y, z: 0 },
    max: { x: bb2.max.x, y: bb2.max.y, z: 0 },
    size: { x: bb2.size.x, y: bb2.size.y, z: 0 },
    center: { x: bb2.center.x, y: bb2.center.y, z: 0 },
  }

  const report: DxfImportReport = { ...joinReport, origin: keepOrigin ? 'drawing' : 'centred', skipped: skippedList }
  return { loops: allLoops, layers: layersWithGeometry, boundingBox: bbox, unitScale, unitLabel, report }
}

function emptyBBox(): BoundingBox {
  return {
    min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
    size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
  }
}

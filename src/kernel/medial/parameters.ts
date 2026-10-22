// WO-3038 (alpha.3 A3-07): every parameter and filter threshold today's V-carve medial axis
// uses, at its current value, each citing the line it comes from. The service reads its
// numbers from this one table; the parity test proves the table reproduces today's axis.
// Line numbers are those of the read-only originals at the WO-3038 starter (c4deecb5).

export interface MedialParameter {
  readonly value: number
  /** What the number decides. */
  readonly meaning: string
  /** Today's source, file:line. */
  readonly source: string
}

const row = (value: number, meaning: string, source: string): MedialParameter => Object.freeze({ value, meaning, source })

export const MEDIAL_PARAMETERS = Object.freeze({
  // Construction.
  minSpacing: row(1e-3, 'smallest boundary sample spacing (mm); a smaller request is raised to it', 'src/lib/cam/vcarve2d/medialAxis.ts:443'),
  normalizeEps: row(1e-9, 'consecutive contour vertices closer than this (per axis, mm) are one vertex; the closing duplicate is dropped', 'src/lib/cam/vcarve2d/medialAxis.ts:94'),
  minContourVertices: row(3, 'a contour needs at least this many vertices to bound area', 'src/lib/cam/vcarve2d/medialAxis.ts:107,112,442'),
  convexCrossEps: row(1e-12, 'a vertex turns left (convex for the region) when the cross product exceeds this', 'src/lib/cam/vcarve2d/medialAxis.ts:135'),
  circumcircleDegenerate: row(1e-14, 'a triangle whose circumcircle determinant is below this has no centre', 'src/lib/cam/vcarve2d/medialAxis.ts:242'),
  gridCellPerSpacing: row(8, 'point-in-region segment grid cell, in sample spacings', 'src/lib/cam/vcarve2d/medialAxis.ts:458'),
  gridCellMin: row(0.5, 'smallest point-in-region grid cell (mm)', 'src/lib/cam/vcarve2d/medialAxis.ts:458'),
  onBoundaryPerSpacing: row(1e-3, 'a circumcentre within this many sample spacings of the boundary counts as outside', 'src/lib/cam/vcarve2d/medialAxis.ts:459'),
  // Filters.
  cornerAngleDeg: row(40, 'a contour vertex turning by at least this (deg) is a corner the axis runs into with r = 0; also the separation below which a leaf is peeled', 'src/lib/cam/vcarve2d/medialAxis.ts:446'),
  pruneLengthPerSpacing: row(3, 'leaf branches shorter than this many sample spacings are pruned unless they end in a convex corner', 'src/lib/cam/vcarve2d/medialAxis.ts:444'),
  peelGuard: row(100_000, 'iteration cap of the separation peel', 'src/lib/cam/vcarve2d/medialAxis.ts:304'),
  pruneGuard: row(10_000, 'iteration cap of the length prune', 'src/lib/cam/vcarve2d/medialAxis.ts:316'),
  // Output.
  simplifyPerSpacing: row(0.25, 'chain simplification tolerance (position and radius), in sample spacings; zero disables', 'src/lib/cam/vcarve2d/medialAxis.ts:445'),
  dedupeEps: row(1e-9, 'consecutive chain nodes closer than this (per axis, mm) are one node; the smaller radius is kept', 'src/lib/cam/vcarve2d/medialAxis.ts:346'),
  // The V-carve consumer's spacing law (index.ts sampleSpacing and the floor-ring core).
  carveSpacingMin: row(0.05, 'smallest carve sample spacing (mm)', 'src/lib/cam/vcarve2d/index.ts:697'),
  carveSpacingMax: row(0.5, 'largest carve sample spacing from the tolerance (mm)', 'src/lib/cam/vcarve2d/index.ts:697'),
  carveSpacingPerTolerance: row(8, 'carve sample spacing in arc tolerances', 'src/lib/cam/vcarve2d/index.ts:697'),
  sampleBudget: row(60_000, 'perimeter / this is the spacing floor that keeps a long outline inside the sample budget', 'src/lib/cam/vcarve2d/index.ts:698,745'),
  floorCoreSpacingPerStepover: row(0.25, 'floor-ring core axis spacing in stepovers, clamped to [0.05, 0.5] mm', 'src/lib/cam/vcarve2d/index.ts:745'),
})

export type MedialParameterName = keyof typeof MEDIAL_PARAMETERS

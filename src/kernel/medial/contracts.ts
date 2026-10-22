// WO-3038 (alpha.3 A3-07): the medial-axis service's data shapes. Structurally the same as
// today's V-carve axis types (src/lib/cam/vcarve2d/medialAxis.ts), so a consumer can switch
// over without a conversion.

import type { Point } from '../geometry'

export type Pt = Point

/** A region: one outer contour (counter-clockwise) and its holes (clockwise).
 *  No contour repeats its first point at the end. */
export interface Region {
  outer: Pt[]
  holes: Pt[][]
}

/** A point on the medial axis with its inscribed (clearance) radius. */
export interface AxisNode extends Pt {
  r: number
}

/** A maximal chain of the axis between junctions or leaves; `closed` when the chain is a
 *  cycle with no junction (an annulus has exactly one). */
export interface AxisPath {
  points: AxisNode[]
  closed: boolean
}

export interface MedialAxisOptions {
  /** Boundary sample spacing (mm). */
  spacing: number
  /** Leaf branches shorter than this (mm) are pruned unless they end in a convex corner. */
  pruneLength?: number
  /** Chain simplification tolerance (mm); zero disables. */
  simplifyTolerance?: number
  /** A contour vertex turning by at least this many degrees is a corner. */
  cornerAngleDeg?: number
}

/** One boundary sample. */
export interface Site {
  x: number
  y: number
  ring: number
  /** Position along its ring's sample list. */
  index: number
  /** An original contour vertex (not a resample). */
  vertex: boolean
  /** Original vertex where the region's interior angle is below 180 deg by the corner angle. */
  convex: boolean
}

/** A medial-axis vertex: the centre of an empty inscribed circle. */
export interface GraphNode extends AxisNode {
  /** Circumradius before the radius is refined against the true boundary segments. */
  circumradius: number
  adj: number[]
  /** Convex original vertex among the defining sites, if any: a corner branch ends there. */
  corner: Pt | null
  /** Separation angle (radians): the widest angle two of the touching samples subtend. */
  sep: number
  alive: boolean
}

/** A dual (Voronoi) edge between two inscribed-circle centres. `secondary` when the shared
 *  Delaunay edge joins consecutive samples of one contour: the edge crosses the boundary. */
export interface CandidateEdge {
  a: number
  b: number
  secondary: boolean
}

/** Construction plus filters, kept for inspection: the raw candidate edges, and the nodes
 *  with their adjacency and liveness after the filters ran. */
export interface MedialGraph {
  sites: Site[]
  nodes: GraphNode[]
  edges: CandidateEdge[]
}

/** A component whose filtered axis is a single point: a disc, a dot. */
export type PointSite = AxisNode

export interface MedialResult {
  paths: AxisPath[]
  /** Read from `paths` (single-point chains); no motion is attached to them at parity. */
  pointSites: PointSite[]
}

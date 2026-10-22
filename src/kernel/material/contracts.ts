// WO-3017 (alpha.3 A3-10a, parity slice): the kernel material service's records.
// Pure data. The kernel may import only its own files and the pure modules the
// WO-2904 boundary lists; the tool profile (ADR-0030, src/lib/tool/toolProfile.ts)
// and the per-type profile family (toolMeta.ts) are supplied by the caller, as
// the WO-2932 tool model takes them, so nothing here duplicates that generator.
import type { Tool } from '../../types'

/** One vertex of the revolved profile: radius r at height z above the tip. */
export interface ProfileVertex {
  readonly z: number
  readonly r: number
}

/** Structural mirror of src/lib/tool/toolProfile.ts ToolProfile (pinned by a type test). */
export interface RevolvedProfile {
  readonly vertices: readonly ProfileVertex[]
  readonly cuttingMaxZ: number
  readonly fluteTopZ: number
}

/** The one tool-shape source: the record, its profile family and its revolved profile. */
export interface ToolShapeSource {
  readonly tool: Tool
  /** toolTypeMeta(tool.type).profileKind, supplied by the caller. */
  readonly profileKind: string
  /** buildToolProfile(tool), supplied by the caller. */
  readonly profile: RevolvedProfile
}

/** Structural mirror of src/cam3d/kernel/types.ts CutterSpec (pinned by a type test). */
export type DropCutterSpec =
  | { kind: 'flat'; diameter: number }
  | { kind: 'ball'; diameter: number }
  | { kind: 'bull'; diameter: number; cornerRadius: number }
  | { kind: 'vbit'; diameter: number; angleFromAxisDeg: number; tipDiameter?: number }

/** A generated form, or today's refusal line for a tool that form cannot use. */
export type Generated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

/**
 * The sweep profile: height(r) of the cutter's lowest surface above the tip.
 * flat, ball, bull and cone are the analytic families; `inscribed` is the
 * largest upward-open shape inside the tool body, used for any shape whose
 * body narrows above its widest point (it removes no more than the tool).
 */
export type SweepShape =
  | { readonly kind: 'flat'; readonly radius: number }
  | { readonly kind: 'ball'; readonly radius: number }
  | { readonly kind: 'bull'; readonly radius: number; readonly cornerRadius: number }
  | { readonly kind: 'cone'; readonly radius: number; readonly tipRadius: number; readonly coneHeight: number }
  | {
      readonly kind: 'inscribed'
      readonly radius: number
      /** Upward-open boundary, tip up: radius never decreases as z rises. */
      readonly zs: readonly number[]
      readonly rs: readonly number[]
      /** The one line saying the tool sweeps as its inscribed shape. */
      readonly note: string
    }

/** One reach-trim band of the cutting head, tip up (today's holderClearance HeadBand). */
export interface ReachBand {
  readonly bottom: number
  readonly top: number
  readonly radius: number
}

/** Linear tool-tip move, mm world coordinates (today's cam3d LinearMove). */
export interface LinearMove {
  readonly x0: number
  readonly y0: number
  readonly z0: number
  readonly x1: number
  readonly y1: number
  readonly z1: number
}

export interface SweepResult {
  /** Material removed by this sweep, mm^3 (f64 sum of stored f32 deltas x cell^2). */
  removedVolumeMm3: number
  /** Column-top updates applied. */
  columnsChanged: number
}

/**
 * MD-50 candidates for "what counts as removed".
 * - `centre`: a column lowers to the envelope at its centre (today). Queries
 *   widen the cutter by one declared pad to cover what the centre misses.
 * - `whole-cell`: a column lowers only to the highest envelope over its whole
 *   cell, and only when the whole cell lies under the cutter. Never claims
 *   material the tool did not remove anywhere in the cell; no pad needed.
 */
export type RemovedDefinition = 'centre' | 'whole-cell'

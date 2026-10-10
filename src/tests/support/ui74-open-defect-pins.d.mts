// Types for ui74-open-defect-pins.mjs. The harnesses are plain .mjs (they run
// under node with no build step), but src/tests/viewport/openDefectPinBands.ui74
// .test.ts imports the pin rule so the bands are pinned by the same suite as
// everything else -- and `npm run build` typechecks the tests, so the module
// needs a shape. (This file exists because it was missing: vitest strips types
// and the 20-row table ran green, while `npm run build` refused the import with
// TS7016. Charter 11, exactly as written.)

/** A pinned surface's two corners, each with its OWN two-sided band. The whole
 *  point of the pair: one outer envelope can only catch a defect getting worse,
 *  and an improvement that is still a defect must make a human re-read the pin. */
export interface CornerBands {
  /** [lo, hi] for the NEAR corner (the surface's minDepth). */
  min: [number, number]
  /** [lo, hi] for the FAR corner (the surface's maxDepth). */
  max: [number, number]
}

export interface OpenDefectPin {
  id: string
  /** The camera disposition this pin is scoped to. */
  camera: string
  identity: string
  /** The visible board row that owns the defect. Never a knownGap. */
  board: string
  /** The exact genesis node ids this pin claims, and nothing else. */
  ids: string[]
  identify: (root: { genesisNodeId?: string | undefined }) => boolean
  bands: Record<string, CornerBands>
  tolerance: string
  measuredBy: string
  found: string
  whyNotFixedHere: string
}

export interface PinBandVerdict {
  /** The bands judged against, or null when the pin declares none for this id. */
  band: CornerBands | null
  /** True only when BOTH corners sit inside their own intervals. */
  inBand: boolean
  /** One entry per corner that drifted: which corner, which way, by how much. */
  drift: string[]
}

export declare const OPEN_DEFECT_PINS: OpenDefectPin[]
export declare function renderBands(band: CornerBands | null | undefined): string
export declare function evalPinBands(
  pin: OpenDefectPin,
  genesisNodeId: string,
  minDepth: number,
  maxDepth: number,
): PinBandVerdict

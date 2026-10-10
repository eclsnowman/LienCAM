// The ONE authoritative copy of the Face advanced-field bounds (WO-020,
// sliced from the WO-015 audit: the panel accepted values the modal refused).
// Both editing surfaces - NewOperationModalBody's Face "Advanced" disclosure
// and the PropertiesPanel Face section - import these, so validation parity
// holds by construction: a bound changed here changes both, and the parity
// tests read THESE values instead of re-deriving their own. Values are
// canonical (degrees for passAngle, mm otherwise); NumericInput clamps after
// display-unit conversion (ADR-0022), so they never need inch variants.
export const FACE_PASS_ANGLE_BOUNDS = { min: 0, max: 180 } as const
export const FACE_PASS_EXTENSION_BOUNDS = { min: 0, max: 100 } as const
export const FACE_STOCK_OFFSET_BOUNDS = { min: -100, max: 100 } as const

// Face PASS-field bounds (WO-027, sliced from the WO-020 audit: the panel kept
// generic floors - 0.01, no max - on the rows the modal bounds tighter).
// Stepover and radial Stock to Leave cap at the SELECTED TOOL's diameter, so
// their max is not a constant: both surfaces resolve the tool identically
// (toolLibrary.find on the op's toolId) and must derive the cap through
// faceToolDiameterCap, never re-derive it inline. No resolvable tool means
// uncapped (undefined max) - on the modal exactly as on the panel.
export const FACE_STEPOVER_BOUNDS = { min: 0.1 } as const
export const FACE_STEPDOWN_BOUNDS = { min: 0.1, max: 50 } as const
export const FACE_RADIAL_STOCK_BOUNDS = { min: 0 } as const
export function faceToolDiameterCap(
  tool: { diameter: number } | undefined,
): number | undefined {
  return tool?.diameter
}

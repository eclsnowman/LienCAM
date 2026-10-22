// The words a parameter refusal shows the operator (WO-2978, WO-2951 finding G3).
//
// Moved verbatim out of src/components/model3d/params/ParametersTable.tsx so
// the Parameters table and a later modeling command (WO-2951 Order B,
// `model.parameter.set`) build the SAME text from the same ParamDiag:
// ADR-0055 decision 5 says the agent is refused in the app's own words.
// Pure and React-free on purpose.

/** `CODE` alone, or `CODE: key=value, key=value` in the diagnostic's own
 *  param order; undefined in, undefined out. */
export function formatParamDiag(diag: { code: string; params: Record<string, string> } | undefined): string | undefined {
  if (diag === undefined) return undefined
  const detail = Object.entries(diag.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  return detail === '' ? diag.code : `${diag.code}: ${detail}`
}

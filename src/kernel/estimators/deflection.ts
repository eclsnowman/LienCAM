// WO-3034 (alpha.3 A3-21): tool-deflection proxy, interface and status only.
//
// REQ-EST-6 / draft step 6: the proxy's form is [UNKNOWN] (MD-96) until an
// accepted external source (a cutting-tool maker's model, checked against the
// WO-A3-04 cuts) supplies it. Until then every call is `unavailable` with that
// reason; the input and value shapes stay so a sourced model drops in here.
import type { Tool } from '../../types'
import { unavailable, type DeflectionProxyValue, type Estimate } from './contracts'

export const DEFLECTION_FORM_UNSOURCED =
  'no accepted external source supplies the deflection form yet (REQ-EST-6, MD-96)'

export interface DeflectionInput {
  readonly tool: Pick<Tool, 'diameter' | 'lengthBelowHolder' | 'numberOfFlutes'>
  /** Radial engagement, fraction of the diameter (the engagement estimate's peak). */
  readonly radialFraction?: number
  /** Axial depth of that cut, mm. */
  readonly axialDepthMm?: number
  /** Programmed cutting feed, mm/min, and spindle speed, rpm. */
  readonly feedMmMin?: number
  readonly rpm?: number
}

/** Declared, not computed: unavailable on every input until the form is sourced. */
export function estimateDeflectionProxy(_input: DeflectionInput): Estimate<DeflectionProxyValue> {
  return unavailable(DEFLECTION_FORM_UNSOURCED)
}

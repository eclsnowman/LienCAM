// WO-2154: the probe facts a Probe-type tool carries, read with their defaults.
// Every field is optional on the record (ADR-0040: no migration), so readers go
// through here rather than the raw properties.
import type { ProbeContact, ProbeInput, Tool } from '../../types'

export const DEFAULT_PROBE_INPUT: ProbeInput = 1
export const DEFAULT_PROBE_CONTACT: ProbeContact = 'normally_open'

export function probeInputOf(tool: Pick<Tool, 'probeInput'>): ProbeInput {
  return tool.probeInput === 2 ? 2 : DEFAULT_PROBE_INPUT
}

export function probeContactOf(tool: Pick<Tool, 'probeContact'>): ProbeContact {
  return tool.probeContact === 'normally_closed' ? 'normally_closed' : DEFAULT_PROBE_CONTACT
}

/** WO-2156: the calibrated effective radius on one axis, or null when that
 *  axis was left blank (or the tool is not a Probe). */
export function probeCalibratedRadius(
  tool: Pick<Tool, 'type' | 'probeEffectiveRadiusX' | 'probeEffectiveRadiusY'>,
  axis: 'x' | 'y',
): number | null {
  if (tool.type !== 'probe') return null
  const calibrated = axis === 'x' ? tool.probeEffectiveRadiusX : tool.probeEffectiveRadiusY
  return typeof calibrated === 'number' && Number.isFinite(calibrated) && calibrated > 0 ? calibrated : null
}

/** The radius a probing move should use on one axis: the calibrated effective
 *  radius when one is set, otherwise the ball radius (diameter / 2). */
export function probeEffectiveRadius(
  tool: Pick<Tool, 'diameter' | 'probeEffectiveRadiusX' | 'probeEffectiveRadiusY'>,
  axis: 'x' | 'y',
): number {
  return probeCalibratedRadius({ ...tool, type: 'probe' }, axis) ?? tool.diameter / 2
}

import { GRBL_CONFIG } from './grbl'
import type { PostConfig } from '../types'

/**
 * WO-1068 slice (a): grblHAL is identity-only for now. Its emitted motion is
 * deliberately inherited from GRBL; later slices own dialect differences.
 * The extra first line is the sole byte-level identity difference.
 */
export const GRBLHAL_CONFIG: PostConfig = {
  ...GRBL_CONFIG,
  id: 'grblhal',
  label: 'grblHAL',
  capabilities: { ...GRBL_CONFIG.capabilities },
  format: { ...GRBL_CONFIG.format },
  framing: {
    ...GRBL_CONFIG.framing,
    programStart: ['( grblHAL )', ...GRBL_CONFIG.framing.programStart],
  },
  options: { ...GRBL_CONFIG.options },
}

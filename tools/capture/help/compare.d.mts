import type { Buffer } from 'node:buffer'

export const CHANNEL_THRESHOLD: 24
export const AREA_THRESHOLD: 0.001

export function measurePixels(before: Uint8Array, after: Uint8Array, channels?: number): {
  changedPixels: number
  changedFraction: number
  meanAbsoluteDifference: number
  mask: Buffer
}

export function compareAll(): Promise<void>

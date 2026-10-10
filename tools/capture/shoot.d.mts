import type { CaptureScreenshotResult } from './lib/provenance.mjs'

export interface PersistCaptureProvenanceOptions {
  provenancePath: string
  shots: Record<string, CaptureScreenshotResult>
}

export function persistCaptureProvenance(
  options: PersistCaptureProvenanceOptions,
): string

export function dismissMachineModal(page: {
  locator(selector: string): unknown
}): Promise<{
  dismissed: boolean
  hadModal: boolean
  viaButton: boolean
}>

export interface ShootOptions<Page = unknown> {
  port: number
  outDir?: string
  repoRoot?: string
  sourcePaths?: string[]
  sourceExcludePaths?: string[]
  provenance: (page: Page, context: {
    outputPath: string
    shotName: string
  }) => Promise<boolean> | boolean
}

export function shoot(options: ShootOptions): Promise<{
  full: CaptureScreenshotResult
  viewport: CaptureScreenshotResult
  provenancePath: string
}>

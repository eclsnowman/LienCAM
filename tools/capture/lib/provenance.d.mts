export interface CaptureServerOptions {
  port: number
  repoRoot?: string
  host?: string
  timeoutMs?: number
}

export interface CaptureServerContext {
  baseUrl: string
  server: import('node:child_process').ChildProcess
}

export function withViteCaptureServer<T>(
  options: CaptureServerOptions,
  run: (context: CaptureServerContext) => Promise<T> | T,
): Promise<T>

export interface ScreenshotTarget {
  screenshot(options: Record<string, unknown> & { path: string }): Promise<unknown>
}

export interface CapturePredicateContext {
  outputPath: string
  shotName: string
}

export interface CaptureScreenshotOptions<Page = unknown> {
  page: Page
  target?: ScreenshotTarget
  outputPath: string
  provenance: (
    page: Page,
    context: CapturePredicateContext,
  ) => Promise<boolean> | boolean
  repoRoot?: string
  sourcePaths?: string[]
  sourceExcludePaths?: string[]
  screenshotOptions?: Record<string, unknown>
  minimumBytes?: number
}

export interface CaptureSourceProvenanceOptions {
  repoRoot?: string
  sourcePaths?: string[]
  sourceExcludePaths?: string[]
}

export interface CaptureSourceProvenance {
  commit: string
  workingTreeDirty: boolean
  workingTreeScope: string[]
  sourceExcludes: string[]
  sourceHash: string
  sourceHashAlgorithm: 'sha256-path-and-content-v1'
  sourceFileCount: number
}

export function captureSourceProvenance(
  options?: CaptureSourceProvenanceOptions,
): CaptureSourceProvenance

export interface CaptureScreenshotResult {
  bytes: number
  hash: string
  outputPath: string
  sourceProvenance: CaptureSourceProvenance
}

export function captureProvenancedScreenshot<Page = unknown>(
  options: CaptureScreenshotOptions<Page>,
): Promise<CaptureScreenshotResult>

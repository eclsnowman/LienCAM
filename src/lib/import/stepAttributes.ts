/* STEP attributes use the shared geom reader. WO-3093 keeps a combined file
 * row while preserving each part's appearance on the merged CAM mesh. */

import type { GeomClient } from '../../geom'
import type { Diag } from '../../geom/geom-service'
import type { BrepModelPayload } from '../cam/geometry/occt/model/types'
import { readStepFaceColors } from './stepPartColors'
import { readStepPresentationColors } from './stepPresentationColors'

/** One part's raw embedded attributes as the geom reader returns them. */
export interface RawPartAttributes {
  /** XCAF/PRODUCT name, or the synthetic `${importId}:step:body#k` fallback. */
  name?: string
  /** XCAF color in [0,1] per channel, or undefined when none was read. */
  color?: [number, number, number]
}

/** The single display name/color chosen for one CAM geometry tree row. */
export interface StepDisplayAttributes {
  /** Embedded name to show, or undefined to keep the caller's default (filename). */
  name?: string
  /** Embedded color as '#rrggbb', or undefined to keep the caller's default swatch. */
  color?: string
  /** Parts the reader found (0 when the read failed). */
  partCount: number
  /** Persisted face-index colours for the combined CAM mesh. */
  faceColors?: string[]
  /** User-facing reason when the attribute read failed/degraded (defaults used). */
  warning?: string
}

type ServiceFactory = () => GeomClient | Promise<GeomClient>

/** Bound so a hung/oversized geom read never blocks the geometry import. This
 *  ONE deadline covers the entire lifecycle -- factory(), init(), importStep()
 *  and the per-body dispose() calls -- not just importStep() (CAM-13-R1 MAJOR
 *  6: a hang in factory()/init() must not be able to block CAM import forever
 *  either). */
const READ_TIMEOUT_MS = 20_000

/** Teardown (terminate()) gets its OWN short bound, separate from the read
 *  deadline above: once the main attempt has already timed out (or thrown),
 *  we still try to release a partially-created service, but that best-effort
 *  cleanup must never itself be able to hang the caller indefinitely -- there
 *  is no cancellation signal a stuck kernel call can honor, so "bounded" is
 *  the strongest guarantee available. */
const TEARDOWN_GRACE_MS = 5_000

/** Race `p` against a `ms`-bound timer; rejects with `message` on expiry.
 *  Clears its timer either way so a resolved race never leaves a dangling
 *  timeout keeping the event loop alive. */
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** rgb in [0,1] per channel -> '#rrggbb' (the format the color picker writes). */
export function rgb01ToHex([r, g, b]: [number, number, number]): string {
  const ch = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
  return `#${ch(r)}${ch(g)}${ch(b)}`
}

/** A finite rgb triple with every channel in [0,1] (NaN/Inf/wrong-length/out-of-range
 *  are rejected, not shown/clamped -- CAM-13-R2 MAJOR 2: a channel outside [0,1] is
 *  malformed data, not a value to silently clamp into range). */
function isValidColor(c: unknown): c is [number, number, number] {
  return (
    Array.isArray(c) &&
    c.length === 3 &&
    c.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)
  )
}

/** One part's color field, classified against the reader's contract (CAM-13-R2
 *  MAJOR 2): genuine absence (no color attribute at all) must stay silent, but a
 *  PRESENT, malformed/out-of-range triple is a distinct, named degradation - never
 *  silently reclassified as absence before collapse sees it. */
type ColorCheck =
  | { kind: 'absent' }
  | { kind: 'valid'; hex: string }
  | { kind: 'invalid' }

function checkColor(c: unknown): ColorCheck {
  if (c === undefined) return { kind: 'absent' }
  if (isValidColor(c)) return { kind: 'valid', hex: rgb01ToHex(c) }
  return { kind: 'invalid' }
}

/**
 * True when importStep handed back its deterministic fallback name (no XCAF /
 * PRODUCT name was present), so the CAM row should keep the filename rather
 * than display an internal body id. A genuine embedded name - including a
 * generic one - is shown as-is (matching the 3D modeling workspace; Operator Q-33: the user can
 * rename it afterward).
 */
function isSyntheticName(name: string | undefined, importId: string): name is undefined {
  return name === undefined || name.length === 0 || name.startsWith(`${importId}:step:body#`)
}

/** A combined row uses a shared name only when every part agrees. Different
 * names are normal assembly metadata. Its swatch represents the first part;
 * per-face colours below retain the rest instead of collapsing them away. */
export function pickDisplayAttributes(
  parts: RawPartAttributes[],
  importId: string,
): { name?: string; color?: string; warning?: string } {
  const names = parts.map(p => isSyntheticName(p.name, importId) ? undefined : p.name)
  const checks = parts.map(p => checkColor(p.color))
  const invalid = checks.filter(c => c.kind === 'invalid').length
  const first = checks[0]
  return {
    name: names.length > 0 && names.every(n => n === names[0]) ? names[0] : undefined,
    color: first?.kind === 'valid' ? first.hex : undefined,
    warning: invalid > 0
      ? `${invalid}/${parts.length} part(s) carry a malformed or out-of-[0,1]-range embedded color - using default for those parts`
      : undefined,
  }
}

/** The canonical, workspace-independent answer to "did this workspace actually
 *  find an embedded color, or is it just showing its own no-color default?"
 *  (CAM-13-R2 MAJOR 1.) The 3D modeling workspace and CAM disagree on BOTH when and what they
 *  default to: CAM's store bakes BREP_DEFAULT_COLOR ('#8ab4cc', store/index.ts)
 *  in at import time, so its display field is never undefined, while Part
 *  Studio keeps the raw kernel value (undefined = nothing read) and only paints
 *  its OWN default ('#cccccc', BodyListPanel.tsx/AppearancePanel.tsx) at render
 *  time. Comparing the two raw display values directly (undefined !== '#8ab4cc')
 *  proves nothing about the embedded color; comparing them THROUGH this map -
 *  each against its own workspace's no-color default - answers the real
 *  question on equal footing. The two workspaces are at color parity exactly
 *  when their mapped outcomes are equal (both used today: {hasEmbeddedColor:
 *  false}). The instant a workspace's raw value carries a real embedded color,
 *  this same map turns it into {hasEmbeddedColor:true, color:'#rrggbb'} with no
 *  change to this function - see src/tests/store/importBrepAttributesReal.test.ts. */
export interface EmbeddedColorOutcome {
  /** True only when the mapped display color reflects a genuinely embedded color, not the workspace's own no-color default. */
  hasEmbeddedColor: boolean
  /** The embedded color's hex - set only when hasEmbeddedColor is true. */
  color?: string
}

export function resolveEmbeddedColorOutcome(
  displayColor: string | undefined,
  workspaceNoColorDefault: string | undefined,
): EmbeddedColorOutcome {
  if (displayColor === undefined || displayColor === workspaceNoColorDefault) return { hasEmbeddedColor: false }
  return { hasEmbeddedColor: true, color: displayColor }
}

/** A diagnostic naming a genuine XCAF read/parse problem (not the benign "file
 *  has no PRODUCT/XCAF structure at all" gap, which stays severity 'info' and
 *  needs no warning - see geom-engine.ts importStep). Severity is the
 *  STRUCTURED signal (per the GeomService contract's "diagnostics are
 *  structured codes" rule); `params.xcafGap` supplies the human-readable text
 *  when present. CAM-13-R2 MAJOR 2: a structured import error (e.g.
 *  KERNEL_OP_FAILED) that carries no xcafGap text must still surface - it was
 *  previously dropped on the floor (silently reclassified as "nothing to
 *  report"), which is exactly the failure the module's contract forbids. */
function readFailureMessage(diagnostics: Diag[]): string | undefined {
  const nonInfo = diagnostics.find((d) => d.severity !== 'info')
  if (!nonInfo) return undefined
  if (typeof nonInfo.params?.xcafGap === 'string') return String(nonInfo.params.xcafGap)
  const detail = nonInfo.params
    ? Object.entries(nonInfo.params).map(([k, v]) => `${k}=${String(v)}`).join(', ')
    : undefined
  return `${nonInfo.severity} import diagnostic ${nonInfo.code}${detail ? ` (${detail})` : ''}`
}

/**
 * Read a STEP file's embedded part names/colors through the shared geom reader
 * and pick the single display name/color for the CAM tree. Best-effort: any
 * failure (kernel init, read error, timeout) degrades to defaults with a named
 * warning - attributes are cosmetic and must never block the geometry import
 * (whose own fail-loud paths are untouched).
 *
 * `makeService` is injectable for tests (Node uses createLocalGeomService, the
 * real occt-wasm kernel on the calling thread); the app default lazily spawns
 * the geom Web Worker only on the first CAM STEP import, so nothing about the
 * geom kernel is loaded until a STEP is actually imported.
 */
export async function readStepDisplayAttributes(
  bytes: ArrayBuffer,
  importId: string,
  makeService?: ServiceFactory,
  mesh?: BrepModelPayload['mesh'],
): Promise<StepDisplayAttributes> {
  let service: GeomClient | undefined

  const attempt = async (): Promise<StepDisplayAttributes> => {
    const factory: ServiceFactory =
      makeService ?? (async () => (await import('../../geom')).createGeomService())
    service = await factory()
    const svc = service
    await svc.init()
    // WO-3046 fast path: the names-only shared read mints no bodies. Only a
    // mixed palette needs the surface matching pass below (WO-3093).
    const read = await svc.readStepAttributes(bytes, importId)
    const embedded = readStepPresentationColors(bytes)
    const parts = read.parts.map(p => ({ ...p, color: p.color ?? embedded.get(p.name ?? '') }))
    const diagnostics = read.diagnostics
    const picked = pickDisplayAttributes(parts, importId)
    const failure = readFailureMessage(diagnostics)
    const warning = failure
      ? (picked.warning ? `${failure}; ${picked.warning}` : failure)
      : picked.warning
    // CAM-13-R3 MAJOR 2: a non-info diagnostic means the read itself is
    // suspect, so any name/color it "picked" is not trustworthy enough to
    // show - degrade to the caller's defaults (name/color omitted) rather
    // than surfacing picked values alongside the failure warning.
    return {
      name: failure ? undefined : picked.name,
      color: failure ? undefined : picked.color,
      partCount: parts.length,
      ...(mesh && !failure && parts.length > 1 && new Set(parts.map(p =>
        isValidColor(p.color) ? rgb01ToHex(p.color) : '#8ab4cc')).size > 1
        ? { faceColors: await readStepFaceColors(svc, bytes, importId, mesh) } : {}),
      warning,
    }
  }

  try {
    // CAM-13-R1 MAJOR 6: ONE deadline covers factory()/init()/importStep()/
    // dispose() - not just importStep() - so a hang anywhere in that lifecycle
    // (e.g. kernel init that never resolves) can't block CAM import forever.
    return await withTimeout(attempt(), READ_TIMEOUT_MS, `attribute read exceeded ${READ_TIMEOUT_MS} ms`)
  } catch (err) {
    return { partCount: 0, warning: err instanceof Error ? err.message : String(err) }
  } finally {
    if (service) {
      // Best-effort teardown, separately bounded (TEARDOWN_GRACE_MS): a
      // service that hung mid-init/import may also hang on terminate(), and
      // there is no cancellation signal to abort an in-flight kernel call, so
      // "never unbounded" is the achievable guarantee, not "always succeeds".
      try { await withTimeout(service.terminate(), TEARDOWN_GRACE_MS, 'teardown exceeded grace period') }
      catch { /* best-effort teardown */ }
    }
  }
}

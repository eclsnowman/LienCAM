/* CAM-13 - CAM import reads embedded STEP part names/colors (Operator Q-33).
 *
 * The CAM workspace imports STEP through its own occt-model worker
 * (src/lib/cam/geometry/occt/model), whose vendored OCCT build carries only
 * STEPControl_Reader - NO XCAF bindings (verified: occt-model.yml lists no
 * STEPCAFControl/XCAFDoc symbol). It therefore physically cannot read embedded
 * PRODUCT names or colors. The ONE reader in the app that can is the geom
 * worker's importStep (src/geom, occt-wasm), which the 3D modeling workspace already uses.
 *
 * Per WORKER-CHARTER + this WO ("one shared reader - no parallel STEP-attribute
 * truth path"), this module reads NOTHING itself: it asks that same geom reader
 * for the file's per-part {name,color} and collapses them into the single
 * name/color the CAM geometry tree row can show. The values land in the exact
 * fields the user's rename/color picker edit (ImportedGeometry.name / .color),
 * so "the user can change them after" (Operator's Q-33 reason) works with zero
 * extra UI, and re-import is additive (new geometry id) so a user's later edits
 * are never clobbered.
 *
 * MEASURED READER GAP (CAM-13 report, 2026-07-15; RE-VERIFIED CAM-13-R1,
 * 2026-07-15): the geom reader surfaces embedded NAMES but not COLORS -
 * occt-wasm's compiled xcafImportSTEP binding drops XCAF color even for ITS
 * OWN self-authored export (doc.exportSTEP() -> kernel.importXCAFFromSTEP()
 * round trip on an in-memory doc with a freshly-set color loses hasColor,
 * with no vendor-file ambiguity involved at all - see
 * src/tests/geom/occtWasmColorGap.test.ts, a committed pin of that exact
 * probe). This is a read-side defect in the vendored occt-wasm .wasm binary
 * itself (vendor/occt-wasm/*.tgz, NOTICE-GEO9.md), not a TS-level bug: there
 * is no colorMode toggle or lower-level API exposed by the package
 * (raw-types.d.ts has exactly one xcafImportSTEP/xcafGetLabelInfo pair, no
 * parameters), and rebuilding it requires the Docker+emsdk+cargo toolchain
 * NOTICE-GEO9.md documents - unavailable in this work order's environment
 * (verified: no docker/cargo/emcc on PATH). It affects the 3D modeling workspace
 * identically, since both workspaces call this exact function. The color
 * path below is therefore correct but dormant: the instant a patched
 * occt-wasm build returns a color, the CAM tree shows it with no further
 * change here (unit-proven via an injected colored body).
 */

import type { GeomClient } from '../../geom'
import type { Diag } from '../../geom/geom-service'

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

/** Collapse an assembly's per-part color checks. Any INVALID (present-but-malformed)
 *  triple forces a degrade-to-default with a named warning, distinct from and
 *  combinable with collapseField's ordinary "parts disagree" warning - an assembly
 *  where every part is simply uncolored still gets no warning at all. */
function collapseColorField(checks: ColorCheck[]): { value?: string; warning?: string } {
  const invalidCount = checks.filter((c) => c.kind === 'invalid').length
  const base = collapseField(checks.map((c) => (c.kind === 'valid' ? c.hex : undefined)), 'color')
  if (invalidCount === 0) return base
  const invalidWarning =
    `${invalidCount}/${checks.length} part(s) carry a malformed or out-of-[0,1]-range embedded color - using default`
  return { warning: base.warning ? `${invalidWarning}; ${base.warning}` : invalidWarning }
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

/**
 * Collapse one field (name or color, already normalized to `string |
 * undefined` per part) across an assembly's parts, per the WO's "every part
 * agrees" rule (CAM-13-R1 MAJOR 5 fix):
 *  - NO part carries the field: a plain, legitimate absence (most STEP files;
 *    the common single-body case with a value counts as "every part agrees"
 *    trivially) - value stays undefined, no warning.
 *  - EVERY part carries the field and they all agree: that shared value wins.
 *  - Otherwise (some parts have it and others don't, or they disagree): one
 *    merged CAM tree row cannot honestly show a single label for a partial or
 *    inconsistent assembly, so it degrades to the caller's default AND names
 *    why via a warning - never silently adopts the one value it happened to
 *    see (the bug: filtering missing/invalid values out before comparing,
 *    which let one named part win over an unnamed one).
 */
function collapseField(values: Array<string | undefined>, label: string): { value?: string; warning?: string } {
  const defined = values.filter((v): v is string => v !== undefined)
  if (defined.length === 0) return {}
  const unique = new Set(defined)
  if (defined.length === values.length && unique.size === 1) return { value: defined[0] }
  if (defined.length === values.length) {
    return {
      warning: `parts disagree on embedded ${label} (${unique.size} distinct values across ${values.length} parts) - using default`,
    }
  }
  return {
    warning: `parts disagree on embedded ${label} (${defined.length}/${values.length} carry one) - using default`,
  }
}

/**
 * Pure: collapse the reader's per-part attributes into the one name+color the
 * CAM tree row (one row per imported file - CAM's current, unchanged
 * part-splitting behavior) can display, plus a warning when an assembly's
 * parts disagreed or only partially carried a value (MAJOR 5).
 */
export function pickDisplayAttributes(
  parts: RawPartAttributes[],
  importId: string,
): { name?: string; color?: string; warning?: string } {
  const nameResult = collapseField(
    parts.map((p) => (isSyntheticName(p.name, importId) ? undefined : p.name)),
    'name',
  )
  const colorResult = collapseColorField(parts.map((p) => checkColor(p.color)))
  const warnings = [nameResult.warning, colorResult.warning].filter((w): w is string => w !== undefined)
  return {
    name: nameResult.value,
    color: colorResult.value,
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
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
): Promise<StepDisplayAttributes> {
  let service: GeomClient | undefined

  const attempt = async (): Promise<StepDisplayAttributes> => {
    const factory: ServiceFactory =
      makeService ?? (async () => (await import('../../geom')).createGeomService())
    service = await factory()
    const svc = service
    await svc.init()
    // WO-3046: the names-only read - the same XCAF read importStep makes, with
    // no bodies minted, so the attribute read costs one parse and nothing more.
    const { parts, diagnostics } = await svc.readStepAttributes(bytes, importId)
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

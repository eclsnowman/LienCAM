/* WO-1824 - .igs/.iges import, on the same OCCT kernel as STEP.
 *
 * WHY THIS EXISTS: IGES still ships from the older CAD seats and the
 * legacy-parts sites hobby users buy from. Until this order those users got
 * nothing at all - the extension was not in any dispatch, and the only 'iges'
 * strings in the tree were tests asserting it was unsupported.
 *
 * HOW IT WORKS: the geometry kernel gained a real IGES entry point in this
 * order (patches/occt-wasm-3.6.1-iges-import.patch binds IGESControl_Reader;
 * see docs/decisions/0052 for why the kernel is rebuildable at all). This
 * module drives that reader through the SAME geom-service client the 3D
 * modelling workspace uses, then hands the result to the existing B-rep import
 * pipeline as STEP bytes produced by the same kernel. There is deliberately no
 * second reader, no second tessellator and no second cache path: an IGES part
 * lands as the identical kind of part a STEP file lands as, which is what makes
 * every downstream feature (CAM, edit-as-model, offline recovery) work on it
 * for free.
 *
 * WHAT IT REFUSES: only a file the kernel cannot read at all, and only by name
 * (LIENCAM.md rule 11). IGES is NOT a solid format - a real file may hold an
 * MSBO solid, a sewn shell, a pile of trimmed surfaces, or bare wireframe
 * curves. Surfaces and wireframe are imported, not refused; what they are is
 * reported in `label` so the operator is told plainly what he got instead of
 * being shown surfaces dressed up as a solid. There is no silent retry as
 * STEP and no "re-export your file from your CAD" remedy.
 */

import type { GeomClient } from '../../geom'
import type { Diag, IgesContent } from '../../geom/geom-service'

type ServiceFactory = () => GeomClient | Promise<GeomClient>

/** One bound covering the WHOLE lifecycle - factory(), init(), importIges(),
 *  exportStep() and teardown - so a hung kernel cannot block import forever.
 *  Same shape and same reasoning as stepAttributes.ts's READ_TIMEOUT_MS; IGES
 *  files of the size this is for read in well under a second. */
const READ_TIMEOUT_MS = 30_000

/** Teardown gets its own short bound: once the main attempt has already timed
 *  out, releasing a half-built service must not itself hang the caller. */
const TEARDOWN_GRACE_MS = 5_000

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

export interface IgesImportResult {
  /** What the kernel read, re-emitted as STEP by that same kernel, ready for
   *  the shared B-rep import path. Not a conversion to a different program's
   *  idea of the geometry - it is the OCCT shape the IGES reader produced. */
  stepBytes: ArrayBuffer
  /** What the file actually held, counted on the shape the reader returned. */
  content: IgesContent
  /** Plain words for the operator: "1 solid", "surfaces only -- 37 faces, no
   *  solid", "wireframe only -- 12 curves, no surfaces". */
  label: string
}

/** Plain-words summary of what an IGES file turned out to hold. Solids win when
 *  present; otherwise the part is named for what it IS, never implied to be a
 *  solid. */
export function describeIgesContent(content: IgesContent): string {
  const { solids, shells, faces, edges } = content
  if (solids > 0) return `${solids} solid${solids === 1 ? '' : 's'}`
  if (shells > 0) {
    return `surfaces only -- ${shells} shell${shells === 1 ? '' : 's'}` +
      `, ${faces} face${faces === 1 ? '' : 's'}, no solid`
  }
  if (faces > 0) return `surfaces only -- ${faces} face${faces === 1 ? '' : 's'}, no solid`
  if (edges > 0) return `wireframe only -- ${edges} curve${edges === 1 ? '' : 's'}, no surfaces`
  return 'no geometry'
}

/** The first error/warning diagnostic's message, or undefined when the read was
 *  clean. Diagnostics are structured codes; this formats one for the operator. */
function failureMessage(diagnostics: Diag[]): string | undefined {
  const bad = diagnostics.find((d) => d.severity !== 'info')
  if (!bad) return undefined
  const detail = bad.params
    ? Object.entries(bad.params).map(([k, v]) => `${k}=${v}`).join(', ')
    : ''
  return `${bad.code}${detail ? ` (${detail})` : ''}`
}

/**
 * Read an IGES file on the geometry kernel and return it as STEP bytes plus an
 * honest description of what was in it.
 *
 * Throws (with a named, operator-readable reason) only when the kernel cannot
 * produce geometry from the file at all. Every other outcome - surfaces,
 * wireframe, a multi-solid assembly - returns successfully and is described in
 * `label`.
 *
 * `makeService` is injectable for tests (Node uses createLocalGeomService, the
 * real occt-wasm kernel on the calling thread). The app default lazily spawns
 * the geom Web Worker on the first IGES import, so nothing about the geometry
 * kernel loads until an IGES file is actually opened.
 */
export async function importIGES(
  bytes: ArrayBuffer,
  importId: string,
  makeService?: ServiceFactory,
): Promise<IgesImportResult> {
  let service: GeomClient | undefined

  const attempt = async (): Promise<IgesImportResult> => {
    const factory: ServiceFactory =
      makeService ?? (async () => (await import('../../geom')).createGeomService())
    service = await factory()
    const svc = service
    await svc.init()

    const { bodies, diagnostics, content } = await svc.importIges(bytes, importId)
    const failure = failureMessage(diagnostics)
    if (bodies.length === 0) {
      // The one genuine refusal: the reader produced nothing usable. Name the
      // kernel's own reason rather than blaming the operator's file or telling
      // him to re-post it.
      throw new Error(failure ?? 'the geometry kernel read no shapes from this IGES file')
    }

    try {
      const stepBytes = await svc.exportStep(bodies.map((b) => b.handle))
      return { stepBytes, content, label: describeIgesContent(content) }
    } finally {
      for (const b of bodies) {
        try { await svc.dispose(b.handle) } catch { /* already released */ }
      }
    }
  }

  try {
    return await withTimeout(attempt(), READ_TIMEOUT_MS, `IGES read exceeded ${READ_TIMEOUT_MS} ms`)
  } finally {
    if (service) {
      try { await withTimeout(service.terminate(), TEARDOWN_GRACE_MS, 'teardown exceeded grace period') }
      catch { /* best-effort teardown */ }
    }
  }
}

/* Shared geometry-import path (ADR 0010 inline import). Extracted from the
 * DesignTree `handleImportGeometry` closure (P4.1) so the New Nest modal can add
 * a part inline WITHOUT reimplementing the STEP / STL / SVG / DXF branches. The
 * behaviour is byte-identical to the original DesignTree handler; it is now a
 * single function both call sites share.
 *
 * Side effects (unchanged from the original): pushes the geometry to the
 * viewport via the global __cncViewport handle, caches the payload, and calls
 * the store's addGeometry / importBrepGeometry. Not pure — UI-side glue.
 */

import type { ImportedGeometry } from '../../types'
import { importSVG } from './svgImporter'
import { importDXF } from './dxfImporter'
import { importIGES } from './igesImporter'
import { objToBinaryStl } from './objImporter'
import type { DxfImport2DResult, DxfImportReport } from './dxfImporter'
import type { JoinReport } from '../geometry/path2d'
import { assignStableLoopIds } from '../geometry/loopId'
import { cacheSTL } from '../stlCache'
import { cache2DGeometry } from '../geometry2dCache'
import { originalFileFromBytes } from './originalFile'
// WO UI-11B IMPORT lane: this module has no store deps injected (only the two
// narrow ones below), and BOTH call sites (DesignTree, NestModal) already sit
// behind the store, so importing it directly here (no store->this cycle
// exists — verified) is the minimal way to land import success/failure +
// cache-path warning events at every caller without widening ImportGeometryDeps.
import { useCamStore } from '../../store'

/** Store actions the import path needs (subset of the Zustand store). */
export interface ImportGeometryDeps {
  importBrepGeometry: (file: File) => void | Promise<void>
  addGeometry: (geo: ImportedGeometry) => void
}

/** WO-1904: import choices the caller may pass through. Today only the DXF
 *  drawing-origin choice; STEP/STL/SVG ignore it. Absent/false is the default
 *  re-centring, byte-identical to main. */
export interface ImportGeometryOptions {
  keepOrigin?: boolean
}

type VpAdd = {
  addSTL?: (
    b: ArrayBuffer, id: string, n: string,
  ) => Promise<
    { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | void
  >
  add2DGeometry?: (
    id: string,
    loops: ImportedGeometry['loops'],
    layers: ImportedGeometry['layers2d'],
    pos: { x: number; y: number; z: number },
    rot: { x: number; y: number; z: number },
  ) => void
}

/**
 * WO-1840: one line for the import console event naming what joinSegments
 * closed/left open and which entity types the DXF parser dropped - never
 * silent, even on a clean file. Kept here (not in dxfImporter.ts) so this
 * console-message concern stays with the console writer, not the parser.
 */
export function formatDxfImportReport(report: DxfImportReport): string {
  const parts: string[] = []
  if (report.gapsClosed > 0) {
    const largest = Number(report.largestGapMM.toFixed(3))
    parts.push(`${report.gapsClosed} gap${report.gapsClosed === 1 ? '' : 's'} closed (largest ${largest}mm)`)
  }
  if (report.openChains > 0) {
    parts.push(`${report.openChains} chain${report.openChains === 1 ? '' : 's'} left open`)
  }
  if (report.skipped.length > 0) {
    parts.push(`${report.skipped.map(s => `${s.type} x${s.count}`).join(', ')} not imported`)
  }
  // WO-1900: only the non-default origin is news - a re-centred import is
  // today's silence, so its console line stays byte-identical.
  if (report.origin === 'drawing') {
    parts.push('drawing origin kept')
  }
  return parts.length > 0 ? parts.join(', ') : 'no gaps closed, nothing skipped'
}

/**
 * WO-3276: the SVG counterpart. An SVG import was silent about joining; now it
 * says what it closed, and stays silent on a file where nothing needed joining
 * (that console line is unchanged). Returns '' when there is nothing to say.
 */
export function formatSvgImportReport(report: JoinReport | undefined): string {
  if (!report) return ''
  const parts: string[] = []
  if (report.gapsClosed > 0) {
    const largest = Number(report.largestGapMM.toFixed(3))
    parts.push(`${report.gapsClosed} gap${report.gapsClosed === 1 ? '' : 's'} closed (largest ${largest}mm)`)
  }
  const tJunctions = report.tJunctionsSplit ?? 0
  if (tJunctions > 0) {
    parts.push(`${tJunctions} place${tJunctions === 1 ? '' : 's'} where a line ends on another line joined`)
  }
  const faces = report.facesClosed ?? 0
  if (faces > 0) {
    parts.push(`${faces} closed shape${faces === 1 ? '' : 's'} found`)
  }
  if (parts.length > 0 && report.openChains > 0) {
    parts.push(`${report.openChains} chain${report.openChains === 1 ? '' : 's'} left open`)
  }
  return parts.join(', ')
}

/**
 * Import a single geometry file (STEP/STP, IGS/IGES, STL, SVG, DXF) into the project.
 * STEP routes through the model worker pipeline (importBrepGeometry); STL/SVG/DXF
 * read the file, build an ImportedGeometry, push it to the viewport, cache it, and
 * call addGeometry. Mirrors the original DesignTree.handleImportGeometry exactly.
 */
export async function importGeometryFile(
  file: File,
  deps: ImportGeometryDeps,
  options: ImportGeometryOptions = {},
): Promise<void> {
  const ext = file.name.split('.').pop()?.toLowerCase()

  // STEP -> model worker pipeline (ADR 0018). Its own error surfacing
  // (setBrepImportError) is a separate, already-wired path — untouched here.
  if (ext === 'step' || ext === 'stp') {
    await deps.importBrepGeometry(file)
    return
  }

  // WO-1824: IGES -> the SAME B-rep pipeline, one step further back. The kernel
  // reads the .igs/.iges (patches/occt-wasm-3.6.1-iges-import.patch binds
  // IGESControl_Reader) and re-emits what it read as STEP, which then goes
  // through importBrepGeometry unchanged. That is deliberate and is NOT a
  // "silent STEP retry guess": nothing re-parses the original bytes as STEP, and
  // a file the IGES reader cannot read is refused by name below rather than
  // being handed to the STEP reader to fail differently. Routing it through the
  // one B-rep path is what gives an IGES part the same tessellation, offline
  // cache, naming, seating and downstream CAM behaviour a STEP part has.
  if (ext === 'igs' || ext === 'iges') {
    const importId = crypto.randomUUID()
    const sourceBytes = await file.arrayBuffer()
    // The kernel may transfer the buffer; preserve the picked source first.
    const originalFile = originalFileFromBytes(file, sourceBytes)
    let result: Awaited<ReturnType<typeof importIGES>>
    try {
      result = await importIGES(sourceBytes, importId)
    } catch (err) {
      useCamStore.getState().addConsoleEvent({
        severity: 'error', source: 'import',
        message: `Import failed for "${file.name}": ${err instanceof Error ? err.message : String(err)}`,
      })
      throw err
    }
    // The File keeps its own name (the operator's file is what it is); only its
    // BYTES are the kernel's STEP re-emission, which is what readStep consumes.
    const existingIds = new Set(useCamStore.getState().project.geometry.map(geo => geo.id))
    await deps.importBrepGeometry(
      new File([result.stepBytes], file.name, { type: 'application/octet-stream' }),
    )
    // importBrepGeometry owns row creation and returns no id. Attach the source
    // only to this import's new rows, keeping the STEP cache for display/CAM.
    useCamStore.setState(state => ({
      project: { ...state.project, geometry: state.project.geometry.map(geo =>
        !existingIds.has(geo.id) && geo.filename === file.name && geo.format === 'step'
          ? { ...geo, originalFile } : geo,
      ) },
    }))
    // Say what the file actually held. A surface-only or wireframe IGES is
    // imported, never refused (LIENCAM.md rule 11) -- but it is LABELLED, so the
    // operator is never shown surfaces presented as a solid.
    useCamStore.getState().addConsoleEvent({
      severity: result.content.solids > 0 ? 'success' : 'warning', source: 'import',
      message: `Imported "${file.name.replace(/\.[^.]+$/, '')}" (IGES -- ${result.label})`,
    })
    return
  }

  // WO UI-11B IMPORT lane: success/failure events for the STL/SVG/DXF path
  // below. Behavior is unchanged for every existing caller — this only adds
  // console events around the same steps that ran before.
  try {
    const text = ext === 'stl'
      ? await file.arrayBuffer()
      : await file.text()

    const vp = (window as unknown as Record<string, unknown>).__cncViewport as VpAdd | undefined
    let unitNote = ''

    const geo: ImportedGeometry = {
      id: crypto.randomUUID(),
      name: file.name.replace(/\.[^.]+$/, ''),
      filename: file.name,
      type: ext === 'stl' || ext === 'obj' ? 'mesh' : 'curves_2d',
      format: ext as ImportedGeometry['format'],
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
        size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
      },
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      loaded: false,
    }

    // DXF/SVG parsing discards spelling, comments, units and source formatting;
    // OBJ cache bytes are converted STL. Keep the actual picked file as well.
    if (ext === 'svg' || ext === 'dxf' || ext === 'obj') {
      geo.originalFile = originalFileFromBytes(file, await file.arrayBuffer())
    }

    if (ext === 'stl' && text instanceof ArrayBuffer && vp?.addSTL) {
      const bb = await vp.addSTL(text, geo.id, geo.name)
      if (bb) {
        geo.boundingBox = {
          min: bb.min, max: bb.max,
          size: { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z },
          center: {
            x: (bb.min.x + bb.max.x) / 2,
            y: (bb.min.y + bb.max.y) / 2,
            z: (bb.min.z + bb.max.z) / 2,
          },
        }
      }
      geo.loaded = true
      // The named silent catch (cache write): now a warning event instead of
      // a swallowed rejection. The import itself already succeeded (the part
      // is in the scene) — only the offline-reload cache write failed.
      cacheSTL(geo.id, text).catch((err) => {
        useCamStore.getState().addConsoleEvent({
          severity: 'warning', source: 'import',
          message: `"${geo.name}" imported, but its offline cache copy could not be written` +
            `${err instanceof Error ? ` (${err.message})` : ''} — it will need re-import after a full reload.`,
          entityRef: { kind: 'geometry', id: geo.id },
        })
      })
    } else if (ext === 'obj' && typeof text === 'string' && vp?.addSTL) {
      // WO-1927: an OBJ is parsed to the same binary mesh buffer an STL is and
      // then takes the identical addSTL / cacheSTL path. The parser already
      // fan-triangulated polygonal faces; a malformed OBJ is refused by name +
      // 1-based line and lands in this try's catch, never a partial/garbled
      // mesh accepted silently.
      const parsed = objToBinaryStl(text, file.name)
      geo.faceCount = parsed.triangleCount
      const bb = await vp.addSTL(parsed.bytes, geo.id, geo.name)
      if (bb) {
        geo.boundingBox = {
          min: bb.min, max: bb.max,
          size: { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z },
          center: {
            x: (bb.min.x + bb.max.x) / 2,
            y: (bb.min.y + bb.max.y) / 2,
            z: (bb.min.z + bb.max.z) / 2,
          },
        }
      }
      geo.loaded = true
      cacheSTL(geo.id, parsed.bytes).catch((err) => {
        useCamStore.getState().addConsoleEvent({
          severity: 'warning', source: 'import',
          message: `"${geo.name}" imported, but its offline cache copy could not be written` +
            `${err instanceof Error ? ` (${err.message})` : ''} — it will need re-import after a full reload.`,
          entityRef: { kind: 'geometry', id: geo.id },
        })
      })
    } else if ((ext === 'svg' || ext === 'dxf') && typeof text === 'string') {
      // WO-1904: the DXF drawing-origin choice (absent on every SVG import and
      // on the unset default) reaches the importer here.
      const result = ext === 'svg' ? importSVG(text) : importDXF(text, { keepOrigin: options.keepOrigin })
      geo.loops = assignStableLoopIds(result.loops, geo.id)
      geo.layers2d = result.layers
      geo.boundingBox = result.boundingBox
      geo.loaded = true

      // ADR-0022: the DXF importer converts a non-mm drawing to millimetres and
      // reports the unit it read. Say it in the existing success event -- no
      // second dialog, no prompt.
      // WO-1840: same event also says what joinSegments closed/left open and
      // which entity types it dropped -- never silent, even on a clean file.
      if (ext === 'svg') {
        const svgNote = formatSvgImportReport(result.report)
        if (svgNote) unitNote = ` -- ${svgNote}`
      }
      if (ext === 'dxf') {
        const dxfResult = result as DxfImport2DResult
        const noteParts: string[] = []
        if (dxfResult.unitScale !== 1) {
          noteParts.push(`${dxfResult.unitLabel} converted to mm (x${dxfResult.unitScale})`)
        }
        noteParts.push(formatDxfImportReport(dxfResult.report))
        unitNote = ` -- ${noteParts.join('; ')}`
      }

      vp?.add2DGeometry?.(geo.id, geo.loops, geo.layers2d, geo.position, geo.rotation)
      // The named silent catch (cache write) — same warning treatment as STL.
      cache2DGeometry(geo.id, geo.loops, result.layers).catch((err) => {
        useCamStore.getState().addConsoleEvent({
          severity: 'warning', source: 'import',
          message: `"${geo.name}" imported, but its offline cache copy could not be written` +
            `${err instanceof Error ? ` (${err.message})` : ''} — it will need re-import after a full reload.`,
          entityRef: { kind: 'geometry', id: geo.id },
        })
      })
    }

    deps.addGeometry(geo)
    useCamStore.getState().addConsoleEvent({
      severity: 'success', source: 'import',
      message: `Imported "${geo.name}" (${(ext ?? '').toUpperCase()}${unitNote})`,
      entityRef: { kind: 'geometry', id: geo.id },
    })

    // IMPORT-STOCK-PROMPT: ask which stock this new part joins. A no-op (returns
    // immediately, no modal) when the ONLY stock is the lone catch-all auto
    // stock (no explicit stocks AND no named derived stocks) -- that catch-all
    // is the one obvious destination and the historical auto-assign-by-
    // containment behavior is preserved unchanged. Opens whenever at least one
    // assignable named stock exists. The prompt persists the user's pick through
    // the existing stock-binding source of truth (setStockMembership /
    // setGeometryNoStock); a stale stock id is refused by name, never a silent
    // fallback.
    await useCamStore.getState().promptAndApplyImportStockChoice(geo.id, geo.name)
  } catch (err) {
    useCamStore.getState().addConsoleEvent({
      severity: 'error', source: 'import',
      message: `Import failed for "${file.name}": ${err instanceof Error ? err.message : String(err)}`,
    })
    throw err
  }
}

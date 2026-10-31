// ============================================================
// Setup sheet builder (WO-1842) — PostResult -> plain-text setup sheet
// ============================================================
// Pure presentation, built from the SAME data the post itself emits from:
// buildPostInput for tool/feed/spindle/Z-range, and PostResult.operationSpans
// (the emitter's own ledger of where each operation landed) for NC line
// ranges. It states exactly what was posted and claims nothing about machine
// readiness (WO-1842 outcome) - no new validation, no change to posted
// G-code, dialects, or the program builder.
//
// Call ONLY after a successful post (PostResult.ok === true) for the SAME
// project/setups/config that produced it - the builder re-derives its rows
// from those same pure inputs (buildPostInput/resolveSetupWorkOffset are
// deterministic), so a mismatched result would desync silently. The caller
// (PostProcessModal) always passes the exact objects it just posted.
//
// Multi-file posting (WO-1842 fence: "say which"): ONE SHEET PER DOWNLOADED
// FILE. A combined program gets one sheet listing every setup in run order;
// 'separate' mode calls this once per file with that file's one setup, so
// each downloaded .nc/.gcode/.ngc has its own matching .txt (mirrors how the
// operator handles the files at the machine, one at a time).

import type { Operation, PhysicalStock, Project, Setup, Vec3 } from '../../types'
import type { PostConfig, PostResult } from './types'
import { buildPostInput } from './buildPostInput'
import { resolveSetupWorkOffset } from './workOffsets'
import { fmtNum, unitScale } from './format'
import { toWork } from '../program/coords'
import { DEFAULT_CONTOUR_TABS, type ContourParams } from '../cam/types'
import { holdingMethodLabel } from '../workholding/holdingMethods'
import { setupScopeIncludes, workholdingComponentGeometryIds } from '../workholding/resolveWorkholding'

/** World-space AABB of a stock, injected by the caller (PostProcessModal,
 *  via store/stockAssignment's stockWorldBounds) so this lib/post module
 *  never imports store itself (architecture boundary: lib/post may not
 *  import store, components, or cam except cam/types). */
export type StockBounds = (stock: PhysicalStock) => { min: Vec3; max: Vec3 }

/**
 * Quote a name so an embedded newline (or a literal quote/backslash) cannot
 * fake an extra line in the sheet - a hand-typed tool or operation name is
 * operator input, not trusted text (Next's quoting rule, offlineSetupSheet.ts
 * `quoted`). JSON's string grammar already escapes exactly what this needs
 * (\n, \r, ", \\) and wraps in double quotes, so it doubles as the quoting
 * rule with no bespoke escaper to keep in sync.
 */
export function quoted(name: string): string {
  return JSON.stringify(name)
}

/** Derive the setup sheet's own filename from the G-code filename it
 *  describes: same base name, `.setup.txt` in place of the program's
 *  extension (`part-G54.nc` -> `part-G54.setup.txt`). */
export function setupSheetFilenameFor(gcodeFilename: string): string {
  const dot = gcodeFilename.lastIndexOf('.')
  const base = dot > 0 ? gcodeFilename.slice(0, dot) : gcodeFilename
  return `${base}.setup.txt`
}

/** UTF-8 byte length of the exact string the G-code Blob download writes
 *  (a Blob built from a JS string encodes it as UTF-8). */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** SHA-256 of the exact posted bytes, lowercase hex. Web Crypto is standard
 *  in every browser this app targets and in the Node test runner; a missing
 *  `crypto.subtle` is refused loud rather than silently omitted, so the sheet
 *  never claims a hash it did not actually compute (ADR-0003). */
async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('Web Crypto (crypto.subtle) is unavailable; cannot compute the setup sheet SHA-256.')
  }
  const bytes = new TextEncoder().encode(text)
  const digest = await subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Same selection semantics as postProject's internal filterOps: an entry for
 *  `setup.id` keeps only the named op ids (order preserved); no entry keeps
 *  everything. Kept local so this reader never needs postProject to export
 *  its private filter. */
function keptOperations<T extends { op: { id: string } }>(
  ops: T[],
  keepIds: string[] | undefined,
): T[] {
  if (keepIds === undefined) return ops
  const keep = new Set(keepIds)
  return ops.filter((o) => keep.has(o.op.id))
}

function dim(valueMm: number, decimals: number, units: 'mm' | 'inch'): string {
  return fmtNum(valueMm / unitScale(units), decimals)
}

function unitSuffix(units: 'mm' | 'inch'): string {
  return units === 'inch' ? 'in' : 'mm'
}

const HOLDING_KIND_LABEL = { vise: 'Vise', clamp: 'Clamp', fixture: 'Fixture' } as const

/**
 * WO-2439: how the author says this setup's stock is held - the WO-2438 method
 * and note, the vises/clamps placed in this setup's scope (the resolver's own
 * scope rule), and the tab count and size of every posted contour with tabs.
 * Text from the author's plan only: no computed checks, no warnings. Empty
 * when the setup has none of these, so no empty heading is printed.
 * `numbered` is the posted operations of this setup with their sheet numbers.
 */
function workholdingLines(
  project: Project,
  setup: Setup,
  numbered: ReadonlyArray<{ op: Operation; n: number }>,
  decimals: number,
  units: 'mm' | 'inch',
): string[] {
  const rows: string[] = []
  const method = holdingMethodLabel(setup.holdingMethod)
  if (method) rows.push(`    Method: ${method}`)
  const note = (setup.notes ?? '').trim()
  if (note) {
    for (const text of note.split(/\r?\n/)) {
      if (text.trim()) rows.push(`    Note: ${quoted(text.trim())}`)
    }
  }

  const definitions = new Map((project.workholding?.definitions ?? []).map((d) => [d.id, d]))
  const counts = new Map<string, number>()
  for (const instance of project.workholding?.instances ?? []) {
    if (!setupScopeIncludes(instance.setupScope, setup.id)) continue
    if (!definitions.has(instance.definitionId)) continue
    counts.set(instance.definitionId, (counts.get(instance.definitionId) ?? 0) + 1)
  }
  for (const [id, count] of counts) {
    const definition = definitions.get(id)!
    rows.push(
      `    ${HOLDING_KIND_LABEL[definition.kind] ?? 'Holder'}: ${quoted(definition.name || definition.id)}` +
      (count > 1 ? ` x ${count}` : ''),
    )
  }
  // A geometry row marked as workholding is a holder in every setup (the
  // resolver's rule); a row used as a definition's shape is not its own holder.
  const componentRows = workholdingComponentGeometryIds(project.workholding)
  for (const row of project.geometry ?? []) {
    if (row.workholding !== true || componentRows.has(row.id)) continue
    rows.push(`    Holder: ${quoted(row.name || row.id)}`)
  }

  const suffix = unitSuffix(units)
  const seen = new Set<string>()
  for (const { op, n } of numbered) {
    if (op.type !== 'contour_2d' || seen.has(op.id)) continue
    seen.add(op.id)
    const params = op.params as Partial<ContourParams>
    if (params.tabs !== true) continue
    const width = params.tabWidth ?? DEFAULT_CONTOUR_TABS.width
    const height = params.tabHeight ?? DEFAULT_CONTOUR_TABS.height
    const count = params.tabCount ?? DEFAULT_CONTOUR_TABS.count
    // Only the loops this operation cuts read their saved locations (the
    // planner's own targetLoops rule). With loops selected, the plan names
    // them, so the hand-placed tabs on them are counted. With none selected
    // the cut loops are resolved at compute time and are not in the saved
    // plan (the tab preview is dropped on save), so locations saved on some
    // loop may belong to one the cut ignores: say how they are set, not a total.
    // WO-3220: 'none' is a loop an applied suggestion left without tabs.
    const loopIds = Array.isArray(params.loopIds) ? params.loopIds : []
    const cutLocations = Object.entries(params.tabLocations ?? {})
      .filter(([loopId]) => loopIds.length === 0 || loopIds.includes(loopId))
    const placed = cutLocations
      .map(([, at]) => at)
      .filter((at): at is number[] => Array.isArray(at) && at.length > 0)
    const none = cutLocations.filter(([, at]) => at === 'none').length
    const contours = (n: number) => `${n} ${n === 1 ? 'contour' : 'contours'}`
    const howMany = placed.length === 0 && none === 0
      ? `${count} tabs per contour`
      : loopIds.length === 0
        ? `${count} tabs per contour unless placed by hand` + (none > 0 ? ' or set to none' : '')
        : [
          placed.length > 0 ? `${placed.reduce((sum, at) => sum + at.length, 0)} tabs placed by hand on ${contours(placed.length)}` : '',
          none > 0 ? `no tabs on ${contours(none)}` : '',
          placed.length + none < new Set(loopIds).size ? `${count} per other contour` : '',
        ].filter((part) => part !== '').join(', ')
    rows.push(
      `    Tabs, operation ${n} ${quoted(op.name)}: ${howMany}, ` +
      `${dim(width, decimals, units)}${suffix} wide x ${dim(height, decimals, units)}${suffix} high, ` +
      `${params.tabShape === 'triangular' ? 'triangular' : 'box'}`,
    )
  }
  // WO-3221: a posted tab removal contour names the tabbed contour it cuts the
  // tabs from, how many, and how the setup says the part is held once they go.
  for (const { op, n } of numbered) {
    if (op.type !== 'contour_2d') continue
    const binding = (op.params as Partial<ContourParams>).tabRemovalSource
    if (!binding || !Array.isArray(binding.targets) || !Array.isArray(binding.loopIds)) continue
    const posted = numbered.find(({ op: candidate }) => candidate.id === binding.sourceOperationId)
    const source = setup.operations.find((candidate) => candidate.id === binding.sourceOperationId)
    const sourceText = posted
      ? `operation ${posted.n} ${quoted(posted.op.name)}`
      : source ? quoted(source.name) : quoted(String(binding.sourceOperationId))
    const contours = binding.loopIds.length === 1 ? 'contour' : 'contours'
    rows.push(
      `    Tab removal, operation ${n} ${quoted(op.name)}: removes all ${binding.targets.length} tabs of ` +
      `${sourceText} on ${binding.loopIds.length} ${contours}, tabs off; ` +
      (method ? `holding method ${method}` : 'no holding method chosen'),
    )
  }
  return rows.length > 0 ? ['  Workholding:', ...rows] : []
}

/** Row locations and the emitter's exact ranges, shared by both renderers. */
export interface SetupSheetOperation {
  rowStart: number
  rowEnd: number
  spans: NonNullable<PostResult['operationSpans']>
}

export interface SetupSheetData {
  lines: string[]
  operations: SetupSheetOperation[]
}

/**
 * Build the plain-text setup sheet for ONE posted file: units, per-setup work
 * offset + stock, then every operation in run order with tool/spindle/feed/
 * Z-range/NC-line-range, closed by the file's byte length and SHA-256.
 *
 * `setups` is the file's setup list in run order (one setup for a 'separate'
 * file; every included setup, in emission order, for a 'combined' program).
 * `stockBounds` computes a physical stock's world-space AABB (the caller
 * passes store/stockAssignment's stockWorldBounds, the same function every
 * other stock consumer uses) - injected so this module never imports store.
 *
 * `selectedOpIds` mirrors PostProjectOptions.selectedOpIds - the same map the
 * caller passed to postProject, so a partial operation selection produces a
 * sheet describing exactly the operations that were actually posted. A setup
 * left with zero kept operations is omitted, matching postProject's own
 * drop-empty behavior for that setup.
 */
export async function buildSetupSheetData(
  project: Project,
  setups: readonly Setup[],
  config: PostConfig,
  result: PostResult,
  filename: string,
  stockBounds: StockBounds,
  selectedOpIds?: Record<string, string[]>,
): Promise<SetupSheetData> {
  const units = config.format.units
  const xyz = config.format.xyzDecimals
  const feedDec = config.format.feedDecimals
  const suffix = unitSuffix(units)
  const spans = result.operationSpans ?? []

  const lines: string[] = []
  lines.push('LienCAM Setup Sheet')
  lines.push(`Program: ${quoted(filename)}`)
  lines.push(`Units: ${suffix}`)

  const operations: SetupSheetOperation[] = []
  let opNumber = 0
  for (const setup of setups) {
    const input = buildPostInput(project, setup)
    const ops = keptOperations(input.setup.operations, selectedOpIds?.[setup.id])
    if (ops.length === 0) continue

    const resolved = resolveSetupWorkOffset(project, setup)
    const wcs = input.setup.wcs
    lines.push('')
    lines.push(`Setup: ${quoted(setup.name)} (${wcs.label})`)
    lines.push(
      `  Work offset origin: X${dim(wcs.origin.x, xyz, units)} ` +
      `Y${dim(wcs.origin.y, xyz, units)} Z${dim(wcs.origin.z, xyz, units)} ${suffix}`,
    )

    const stock = resolved.stockId === undefined
      ? undefined
      : project.stocks?.find((candidate) => candidate.id === resolved.stockId)
    if (stock) {
      const box = stockBounds(stock)
      const size = {
        x: box.max.x - box.min.x,
        y: box.max.y - box.min.y,
        z: box.max.z - box.min.z,
      }
      lines.push(
        `  Stock: ${quoted(stock.name)} size ${dim(size.x, xyz, units)} x ` +
        `${dim(size.y, xyz, units)} x ${dim(size.z, xyz, units)} ${suffix}`,
      )
      lines.push(
        `  Origin offset from stock min corner: X${dim(wcs.origin.x - box.min.x, xyz, units)} ` +
        `Y${dim(wcs.origin.y - box.min.y, xyz, units)} Z${dim(wcs.origin.z - box.min.z, xyz, units)} ${suffix}`,
      )
    } else {
      lines.push('  Stock: not bound to a physical stock')
    }

    // WO-2439: how the part is held, before this setup's operation list.
    lines.push(...workholdingLines(
      project, setup, ops.map(({ op }, i) => ({ op, n: opNumber + i + 1 })), xyz, units,
    ))

    for (const { op, tool, feeds, spindle, moves } of ops) {
      opNumber += 1
      const matching = spans.filter((s) => s.opId === op.id && s.setupId === input.setupId)
      const startLine = matching.length > 0 ? Math.min(...matching.map((s) => s.startLine)) : undefined
      const endLine = matching.length > 0 ? Math.max(...matching.map((s) => s.endLine)) : undefined

      let zMin = Infinity
      let zMax = -Infinity
      for (const move of moves) {
        const wz = toWork(move, wcs).z
        if (wz < zMin) zMin = wz
        if (wz > zMax) zMax = wz
      }
      const hasZ = moves.length > 0

      lines.push('')
      const rowStart = lines.length
      lines.push(`${opNumber}. ${quoted(op.name)}`)
      lines.push(
        `   Tool: T${tool.toolNumber ?? 0} ${quoted(tool.name)} ` +
        `dia ${dim(tool.diameter, xyz, units)}${suffix} flute length ${dim(tool.fluteLength, xyz, units)}${suffix}`,
      )
      lines.push(`   Spindle: ${Math.round(spindle.rpm)} RPM`)
      lines.push(
        `   Feed: cutting ${dim(feeds.feedRate, feedDec, units)}${suffix}/min, ` +
        `plunge ${dim(feeds.plungeRate, feedDec, units)}${suffix}/min`,
      )
      lines.push(
        hasZ
          ? `   Z range: ${dim(zMin, xyz, units)} to ${dim(zMax, xyz, units)} ${suffix}`
          : '   Z range: (no moves)',
      )
      lines.push(
        startLine !== undefined && endLine !== undefined
          ? `   NC lines: ${startLine}-${endLine}`
          : '   NC lines: (not emitted)',
      )
      operations.push({ rowStart, rowEnd: lines.length, spans: matching })
    }
  }

  const bytes = utf8ByteLength(result.gcode)
  const hash = await sha256Hex(result.gcode)
  lines.push('')
  lines.push(`File: ${quoted(filename)}`)
  lines.push(`Bytes: ${bytes}`)
  lines.push(`SHA-256: ${hash}`)
  lines.push('')

  return { lines, operations }
}

/** Existing text renderer remains byte-for-byte compatible. */
export async function buildSetupSheet(...args: Parameters<typeof buildSetupSheetData>): Promise<string> {
  return renderSetupSheetText(await buildSetupSheetData(...args))
}

export function renderSetupSheetText(sheet: SetupSheetData): string {
  return sheet.lines.join('\n')
}


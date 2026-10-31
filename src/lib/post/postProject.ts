// ============================================================
// Multi-setup export orchestrator (Phase E2) — PURE
// ============================================================
// Turns a Project + a list of Setups into post output, in one of two modes:
//   - 'combined': ONE program with a section per setup (one preamble/postamble,
//     shared modal), via postCombined -> emitCombinedProgram.
//   - 'separate': N independent programs (one postProgram run each), with a
//     deterministic per-setup filename.
//
// It is pure (reads the project/setups, mutates nothing) and lives at the post
// boundary: it consumes the same buildPostInput bundle the single-setup path
// uses and never reaches into operation internals (ADR-0001).
//
// Fail-loud backstop (ADR-0003): before any output it resolves each setup from
// its physical stock. In ONE combined program different stocks may not share an
// offset; multiple setups on the same stock deliberately do. Separate files are
// independent loads (WO-2983, operator ruling 10-20: "share G54, separate files only"), so
// two of them may each use G54.

import type { Project, Setup } from '../../types'
import { buildPostInput, resolveMachineActions, resolveOperatorStops } from './buildPostInput'
import { postCombined, postProgram } from './index'
import { nothingToCutLine } from './emit'
import { sequenceNumberLines } from './sequenceNumbers'
import type {
  PostConfig,
  PostDiagnostic,
  PostInput,
  PostResult,
  ProgramContextEnvelopeStatus,
} from './types'
import { buildProgramContextForSetups } from '../machine/programContext'
import {
  appendProgramContextEnvelope,
  encodeProgramContextEnvelope,
  postSupportsProgramContextEnvelope,
} from './programContextEnvelope'
import {
  findResolvedWorkOffsetConflicts,
  resolveSetupWorkOffset,
  WorkOffsetResolutionError,
  type ResolvedSetupWorkOffset,
} from './workOffsets'
import { setupStockConsistency } from '../../store/stockAssignment'
import {
  onceEachAssignedToolNumber,
  validateModelRefsVerifiedSinceLoad,
  type ModelRefVerificationEvidence,
} from './validate'

export type PostProjectMode = 'combined' | 'separate'

export interface PostProjectOptions {
  mode: PostProjectMode
  /** Insert M5 + M0 (operator pause) between consecutive setups. Default false;
   *  only meaningful for 'combined'. */
  pauseBetweenSetups: boolean
  /** setupId -> op ids to KEEP (in their original order). A setup absent from
   *  this map, or this map being absent entirely, keeps ALL of that setup's
   *  enabled ops. */
  selectedOpIds?: Record<string, string[]>
  /** Base filename (no extension) used for 'separate' per-setup files. */
  baseName: string
  /** File extension WITHOUT the dot, e.g. 'nc'. */
  ext: string
  /** Session-only per-Model-Item verification evidence, threaded explicitly
   *  because postProject is pure and this state never belongs in the file.
   *  Omitted/true remains the compatibility default for older callers. */
  modelRefsVerifiedSinceLoad?: ModelRefVerificationEvidence
  /** WO-381: append the comment-only LienCAM program-context envelope (LCX1
   *  block) after program end. Default false = byte-for-byte historical output.
   *  One envelope = ONE setup: each 'separate' file carries its own; a
   *  'combined' program carries one only when exactly one setup is emitted;
   *  a setup whose operation selection is partial carries none (the context
   *  binds the setup's complete enabled-operation set). Each PostResult
   *  reports what happened in `programContextEnvelope`. Refused (with the
   *  reason) when the post has not declared the envelope capability. */
  programContext?: boolean
}

export interface PostProjectFile {
  filename: string
  /** The setup this file was posted from - a stable identity for anything keyed to
   *  one file (WO-2651 hand edits), unlike the name, which follows the project. */
  setupId?: string
  result: PostResult
}

export interface PostProjectResult {
  ok: boolean
  diagnostics: PostDiagnostic[]
  /** Present in 'combined' mode: the single composed program. */
  combined?: PostResult
  /** Present in 'separate' mode: one entry per exported setup, in order. */
  files?: PostProjectFile[]
}

/**
 * Filter a built PostInput's operations to a selected id set, preserving the
 * original operation order. Ids not present in the input are simply ignored
 * (the input was already filtered to enabled ops by buildPostInput).
 */
function filterOps(input: PostInput, keepIds: string[]): PostInput {
  const keep = new Set(keepIds)
  const operations = input.setup.operations.filter((o) => keep.has(o.op.id))
  // WO-2437: a stop before an operation left out runs before the next kept one.
  const operatorStops = resolveOperatorStops(
    input.setup.operations.map((o) => o.op.id),
    new Set(operations.map((o) => o.op.id)),
    input.setup.operatorStops,
  )
  const machineActions = resolveMachineActions(
    input.setup.operations.map((operation) => operation.op.id),
    new Set(operations.map((operation) => operation.op.id)),
    input.setup.machineActions,
  )
  // WO-2870: an operation with nothing to cut keeps its one line only when it
  // is selected, placed before the next kept operation.
  const { nothingToCut: _allNothingToCut, ...setupRest } = input.setup
  const ordered = input.setup.operations.map((o) => o.op.id)
  const nothingToCut = input.setup.nothingToCut
    ?.filter((entry) => keep.has(entry.opId))
    .map((entry) => {
      const from = entry.beforeOpId === null ? -1 : ordered.indexOf(entry.beforeOpId)
      const beforeOpId = from < 0 ? null : ordered.slice(from).find((id) => keep.has(id)) ?? null
      return { ...entry, beforeOpId }
    })
  return {
    ...input,
    setup: {
      ...setupRest,
      operations,
      ...(operatorStops ? { operatorStops } : {}),
      ...(machineActions ? { machineActions } : {}),
      ...(nothingToCut && nothingToCut.length > 0 ? { nothingToCut } : {}),
    },
  }
}

export function postProject(
  project: Project,
  setups: Setup[],
  config: PostConfig,
  options: PostProjectOptions,
  onResolvedInput?: (setup: Setup, input: PostInput) => void,
): PostProjectResult {
  // Resolve every selected setup's own controller frame before uniqueness
  // checks or output. Stock binding still proves which physical block is cut;
  // it no longer chooses the setup's work offset.
  const resolvedWorkOffsets: ResolvedSetupWorkOffset[] = []
  const resolutionDiagnostics: PostDiagnostic[] = []
  for (const setup of setups) {
    try {
      resolvedWorkOffsets.push(resolveSetupWorkOffset(project, setup))
    } catch (error) {
      const code = error instanceof WorkOffsetResolutionError
        ? error.code
        : 'WORK_OFFSET_INVALID'
      resolutionDiagnostics.push({
        level: 'error',
        code,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (resolutionDiagnostics.length > 0) {
    return { ok: false, diagnostics: resolutionDiagnostics }
  }
  const resolvedSetups = resolvedWorkOffsets.map((resolved) => resolved.setup)

  // ---- FAIL-LOUD BACKSTOP: distinct physical owners cannot collide ----
  // Only inside one combined program; each separate file runs on its own.
  const conflicts = options.mode === 'combined'
    ? findResolvedWorkOffsetConflicts(resolvedWorkOffsets)
    : []
  const offsetDiagnostics: PostDiagnostic[] = [
    ...conflicts.map((conflict): PostDiagnostic => ({
      level: 'error',
      code: 'DUPLICATE_WORK_OFFSET',
      message:
        `Setups ${conflict.setupNames.map((name) => `"${name}"`).join(' and ')} ` +
        `use work offset G${conflict.fixtureOffset} for different stocks or unbound setups, ` +
        `so one combined program cannot run them. Post them as separate files ` +
        `(one per setup), or give each stock its own work offset.`,
    })),
  ]
  if (offsetDiagnostics.length > 0) {
    return { ok: false, diagnostics: offsetDiagnostics }
  }

  // ---- FAIL-LOUD BACKSTOP: one stock per setup over SELECTED setups ----
  // ADR 0026: a setup is ONE WCS = ONE stock. A setup whose operations resolve
  // to more than one distinct stock has no single correct stock-top / clearance
  // plane (and rapids across different-height regions can crash), so refuse the
  // export and steer the user to split into separate setups (ADR 0003 fail-loud).
  // Scope-limited to `setups` (the selected set); an unselected multi-stock setup
  // never reaches here. setupStockConsistency ignores disabled ops and skips
  // ops with no resolvable stock (owned by the existing no-stock guards).
  const stockConflicts: PostDiagnostic[] = []
  for (const setup of resolvedSetups) {
    const consistency = setupStockConsistency(
      setup,
      project.geometry,
      project.stocks ?? [],
      project.nests ?? [],
    )
    if (!consistency.ok) {
      stockConflicts.push({
        level: 'error',
        code: 'SETUP_MULTI_STOCK',
        message: consistency.reason!,
      })
    }
  }
  if (stockConflicts.length > 0) {
    return { ok: false, diagnostics: stockConflicts }
  }

  // ---- BUILD + FILTER each setup's input; drop setups with zero kept ops ----
  const diagnostics: PostDiagnostic[] = []
  const prepared: Array<{ setup: Setup; input: PostInput }> = []
  // WO-2870: setups whose selected operations all have nothing left to cut.
  // They post no motion at all, only their one line per operation.
  const nothingToCutSetups: Array<{ setup: Setup; names: string[] }> = []
  const sourceSetupById = new Map(setups.map((setup) => [setup.id, setup]))
  for (const setup of resolvedSetups) {
    // Build from the persisted source setup so generation freshness remains
    // tied to the geometry-producing setup state. buildPostInput resolves the
    // owning stock's G54-G59 slot onto the emitted copy independently.
    let input = buildPostInput(project, sourceSetupById.get(setup.id) ?? setup)
    // Request-local reuse only, before selection/filtering changes emission.
    onResolvedInput?.(sourceSetupById.get(setup.id) ?? setup, input)
    const sel = options.selectedOpIds?.[setup.id]
    if (sel !== undefined) {
      input = filterOps(input, sel)
    }
    if (input.setup.operations.length === 0) {
      // Do NOT emit an empty section/program; note it and skip the setup.
      // WO-2870: say so plainly when its operations have nothing left to cut.
      const empty = input.setup.nothingToCut ?? []
      if (empty.length > 0) nothingToCutSetups.push({ setup, names: empty.map((e) => e.name) })
      diagnostics.push({
        level: 'info',
        code: 'SETUP_NO_OPS_SELECTED',
        message: empty.length > 0
          ? `Setup "${setup.name}" has nothing left to cut (${empty.map((e) => e.name).join(', ')}); it posts no motion.`
          : `Setup "${setup.name}" has no selected operations and was omitted from the export.`,
      })
      continue
    }
    prepared.push({ setup, input })
  }

  // ---- FAIL-LOUD BACKSTOP: model-reference session verification ----
  // Validate the prepared PostInputs rather than the raw setups so this gate
  // considers exactly what emission will consider: enabled operations by
  // default, further narrowed by any explicit selection.
  const modelRefDiagnostics = prepared.flatMap(({ input }) =>
    validateModelRefsVerifiedSinceLoad(
      input.setup.operations.map(({ op }) => op),
      options.modelRefsVerifiedSinceLoad ?? true,
    ),
  )
  if (modelRefDiagnostics.length > 0) {
    return { ok: false, diagnostics: modelRefDiagnostics }
  }

  // WO-2870: an export in which nothing is left to cut is its comment lines
  // only - no program start or end, so no motion (the end's retract included).
  const nothingToCutProgram = (names: string[]): PostResult => {
    const lines = sequenceNumberLines(names.map((name) => nothingToCutLine(name, config)), config)
    return {
      gcode: lines.join('\n') + '\n', ok: true, diagnostics: [],
      meta: { opCount: 0, lineCount: lines.length }, operationSpans: [],
      ...(options.programContext === true
        ? { programContextEnvelope: { included: false, reason: 'no operation posts motion' } }
        : {}),
    }
  }

  // ---- COMBINED ----
  if (options.mode === 'combined' && prepared.length === 0 && nothingToCutSetups.length > 0) {
    const combined = nothingToCutProgram(nothingToCutSetups.flatMap((s) => s.names))
    return { ok: true, diagnostics, combined }
  }
  if (options.mode === 'combined') {
    const inputs = prepared.map((p) => p.input)
    const sectionComments = prepared.map((p) => p.setup.name)
    let combined = postCombined(inputs, config, {
      pauseBetweenSetups: options.pauseBetweenSetups,
      sectionComments,
    })
    if (options.programContext === true && combined.ok) {
      // WO-412: one setup -> the V1 block; several -> ONE v=2 block listing
      // every emitted setup in order (the V1 one-setup boundary is lifted).
      combined = prepared.length === 0
        ? { ...combined, programContextEnvelope: { included: false, reason: 'no setup was emitted' } }
        : withProgramContextEnvelope(
            project,
            prepared.map((p) => sourceSetupById.get(p.setup.id) ?? p.setup),
            config,
            combined,
            options,
          )
    }
    return {
      ok: combined.ok,
      diagnostics: [...diagnostics, ...combined.diagnostics],
      combined,
    }
  }

  // ---- SEPARATE ----
  const emptyById = new Map(nothingToCutSetups.map((s) => [s.setup.id, s]))
  const preparedById = new Map(prepared.map((p) => [p.setup.id, p]))
  const emptyOrKept = (setupId: string) => emptyById.has(setupId) || preparedById.has(setupId)
  const filenames = separateFilenames(
    resolvedSetups.filter((setup) => emptyOrKept(setup.id)),
    options,
  )
  const files: PostProjectFile[] = []
  for (const resolved of resolvedSetups) {
    const empty = emptyById.get(resolved.id)
    if (empty) {
      files.push({
        filename: filenames.get(empty.setup.id)!,
        setupId: empty.setup.id,
        result: nothingToCutProgram(empty.names),
      })
      continue
    }
    const kept = preparedById.get(resolved.id)
    if (!kept) continue
    const { setup, input } = kept
    let result = postProgram(input, config)
    if (options.programContext === true && result.ok) {
      result = withProgramContextEnvelope(project, [sourceSetupById.get(setup.id) ?? setup], config, result, options)
    }
    files.push({
      filename: filenames.get(setup.id)!,
      setupId: setup.id,
      result,
    })
    diagnostics.push(...result.diagnostics)
  }

  return {
    ok: files.every((f) => f.result.ok),
    // WO-2019: one file per setup each says an assigned tool number; say it once.
    diagnostics: onceEachAssignedToolNumber(diagnostics),
    files,
  }
}

// ---------------------------------------------------------------------------
// WO-2983: unique default filenames for separate files
// ---------------------------------------------------------------------------

/** Characters Windows refuses in a file name (control characters too). */
const UNSAFE_FILENAME_CHARS = '<>:"/\\|?*'

function filenameLabel(name: string): string {
  const label = Array.from(name, (ch) =>
    ch.charCodeAt(0) < 32 || UNSAFE_FILENAME_CHARS.includes(ch) ? '-' : ch).join('')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/^[-.]+|[-.]+$/g, '')
  return label.length > 0 ? label : 'setup'
}

/**
 * Default name of each emitted separate file, keyed by setup id. A file keeps
 * the historical `<base>-G<offset>.<ext>` name when no other file in the batch
 * has it. Files that would share a name (two beds on G54) add their setup's
 * label, and a `-2`, `-3`... suffix when even that repeats. Names are compared
 * case-insensitively, as Windows does, and a generated name never takes one
 * that another file keeps.
 */
function separateFilenames(
  setups: ReadonlyArray<Setup>,
  options: Pick<PostProjectOptions, 'baseName' | 'ext'>,
): Map<string, string> {
  const fold = (name: string) => name.toLowerCase()
  const historical = (setup: Setup) => `${options.baseName}-G${setup.wcs.fixtureOffset}`
  const counts = new Map<string, number>()
  for (const setup of setups) {
    const key = fold(historical(setup))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const taken = new Set<string>()
  const names = new Map<string, string>()
  for (const setup of setups) {
    const stem = historical(setup)
    if (counts.get(fold(stem)) === 1) {
      names.set(setup.id, `${stem}.${options.ext}`)
      taken.add(fold(stem))
    }
  }
  for (const setup of setups) {
    if (names.has(setup.id)) continue
    const stem = `${historical(setup)}-${filenameLabel(setup.name)}`
    let candidate = stem
    for (let n = 2; taken.has(fold(candidate)) || counts.has(fold(candidate)); n++) {
      candidate = `${stem}-${n}`
    }
    names.set(setup.id, `${candidate}.${options.ext}`)
    taken.add(fold(candidate))
  }
  return names
}

// ---------------------------------------------------------------------------
// WO-381: program-context envelope
// ---------------------------------------------------------------------------

/**
 * Bind an emitted program to its context and append the comment-only LCX1
 * block: one setup = the V1 block (WO-381), several setups in one combined
 * program = ONE v=2 block listing every emitted setup in order (WO-412). The
 * context is built from the same authoritative inputs the direct setup load
 * uses (buildProgramContext / buildMultiSetupProgramContext over the exact
 * emitted gcode and its verified spans), so an export -> import round trip
 * yields the same snapshot a direct load would. Any refusal (post not
 * certified, partial operation selection in any listed setup, size caps, a
 * context the boundary will not build) leaves the gcode exactly as emitted and
 * records the reason - advisory data never blocks a valid program, and never
 * changes it.
 */
function withProgramContextEnvelope(
  project: Project,
  setups: ReadonlyArray<Setup>,
  config: PostConfig,
  result: PostResult,
  options: PostProjectOptions,
): PostResult {
  const omitted = (reason: string): PostResult => ({
    ...result,
    programContextEnvelope: { included: false, reason },
  })
  if (!postSupportsProgramContextEnvelope(config)) {
    return omitted(`the post "${config.label}" is not certified for LienCAM setup information`)
  }
  if (setups.some((setup) => options.selectedOpIds?.[setup.id] !== undefined)) {
    return omitted('not available when some of the setup\'s operations are deselected (the setup information describes the whole setup)')
  }
  if (!result.operationSpans) {
    return omitted('the post did not return verified operation source spans')
  }
  let encoded: ReturnType<typeof encodeProgramContextEnvelope>
  try {
    const context = buildProgramContextForSetups(project, setups, config, result.gcode, result.operationSpans)
    encoded = encodeProgramContextEnvelope(context, config)
  } catch (err) {
    return omitted(err instanceof Error ? err.message : String(err))
  }
  if (!encoded.ok) return omitted(encoded.reason)
  const status: ProgramContextEnvelopeStatus = {
    included: true,
    payloadBytes: encoded.payloadBytes,
    chunks: encoded.chunks,
    lines: encoded.lines.length,
    version: encoded.version,
    setupCount: encoded.setupCount,
  }
  const gcode = appendProgramContextEnvelope(result.gcode, encoded.lines)
  return {
    ...result,
    gcode,
    meta: result.meta ? { ...result.meta, lineCount: result.meta.lineCount + encoded.lines.length } : result.meta,
    programContextEnvelope: status,
  }
}

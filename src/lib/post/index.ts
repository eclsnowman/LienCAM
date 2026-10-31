// ============================================================
// Postprocessor entry point (C-P0) — validate + assemble, NO emission
// ============================================================
// Runs all validators; any 'error' diagnostic short-circuits to a failed
// result with empty g-code (ADR-0003: fail loud, never throw). On clean
// input it assembles the section skeleton and returns ok:true. Actual move
// formatting lands in C-P1.

import { emitCombinedProgram, emitProgram } from './emit'
import { sequenceNumberLines } from './sequenceNumbers'
import { vendorOutputLines, vendorPostInput } from './vendorPostImport/output'
import type { PostConfig, PostDiagnostic, PostInput, PostResult } from './types'
import {
  detectRotatedWcs,
  validateOpsCurrent,
  validateOpsReady,
  validateProgramFitsMachine,
  validateToolNumbers,
  onceEachAssignedToolNumber,
} from './validate'

export type {
  PostCapabilities,
  PostConfig,
  PostDiagnostic,
  PostInput,
  PostOperation,
  PostOptions,
  PostResult,
  ProgramEndMode,
  EmittedOperationSpan,
  ProgramContextEnvelopeCapability,
  ProgramContextEnvelopeStatus,
} from './types'
export {
  PROGRAM_CONTEXT_ENVELOPE_LIMITS,
  PROGRAM_CONTEXT_ENVELOPE_SCHEMA,
  PROGRAM_CONTEXT_ENVELOPE_TAG,
  PROGRAM_CONTEXT_ENVELOPE_VERSION,
  appendProgramContextEnvelope,
  decodeProgramContextEnvelope,
  encodeProgramContextEnvelope,
  importProgramContextFromGcode,
  postSupportsProgramContextEnvelope,
  programContextEnvelopeLineLength,
} from './programContextEnvelope'
export type {
  ProgramContextEnvelopePayload,
  ProgramContextImportResult,
} from './programContextEnvelope'
export { assembleSections } from './assemble'
export type { Section } from './assemble'
export { buildPostInput, MISSING_TOOL_ID } from './buildPostInput'
export {
  isPostToolNumber,
  postToolNumbersOf,
  withPostToolNumber,
  type PostToolNumbers,
} from './toolNumbers'
export { resolveCoolant, resolveSpindle } from './resolve'
export {
  detectRotatedWcs,
  validateOpsCurrent,
  validateOpsReady,
  validateProgramFitsMachine,
  validateToolNumbers,
  validateModelRefsVerifiedSinceLoad,
} from './validate'
export { emitCombinedProgram, emitProgram } from './emit'
export {
  postProject,
} from './postProject'
export type {
  PostProjectFile,
  PostProjectMode,
  PostProjectOptions,
  PostProjectResult,
} from './postProject'
export { UCCNC_CONFIG } from './dialects/uccnc'
export { GRBL_CONFIG } from './dialects/grbl'
export { GRBLHAL_CONFIG } from './dialects/grblhal'
export { LINUXCNC_CONFIG } from './dialects/linuxcnc'
export { GENERIC_CONFIG } from './dialects/base'
export { downloadFilenameForConfig, extForConfig } from './downloadExtension'
export {
  parseUserPostConfig,
  serializeUserPostConfig,
  userPostDefinitionFilename,
  withUserPostWordTable,
} from './userPostConfig'
export type { UserPostConfig, UserPostImportResult } from './userPostConfig'
export { importPostFile } from './vendorPostImport'
export type { VendorPostImportResult } from './vendorPostImport'

// ------------------------------------------------------------
// Built-in dialect registry — SINGLE SOURCE OF TRUTH
// ------------------------------------------------------------
// One ordered list of the shipping built-in PostConfigs. Both the post-process
// dialog's template selector AND the Machine Library "Controller" field source
// their options from here (id + label), so a new dialect appears in both places
// by adding it to this one array. A machine's `controller` value is one of these
// ids; PostProcessModal defaults the active post from it (exact id match, with a
// named fallback — never a silent wrong dialect, ADR-0003).
import { GENERIC_CONFIG as _GENERIC } from './dialects/base'
import { GRBL_CONFIG as _GRBL } from './dialects/grbl'
import { GRBLHAL_CONFIG as _GRBLHAL } from './dialects/grblhal'
import { LINUXCNC_CONFIG as _LINUXCNC } from './dialects/linuxcnc'
import { UCCNC_CONFIG as _UCCNC } from './dialects/uccnc'
import {
  registerGcodeWordTable,
  unregisterGcodeWordTable,
} from '../gcode/wordTable'
import {
  withUserPostWordTable,
  type UserPostConfig,
} from './userPostConfig'

const SHIPPING_DIALECTS: PostConfig[] = [
  _UCCNC,
  _GRBL,
  _GRBLHAL,
  _LINUXCNC,
  _GENERIC,
]

/** Historical public name: controller resolution already reads this array.
 *  It now contains the shipping definitions followed by user-owned ones, so a
 *  post import becomes a machine-definition controller choice without a new
 *  dispatch branch. Callers that need only templates filter `builtin`. */
export const BUILT_IN_DIALECTS: PostConfig[] = [...SHIPPING_DIALECTS]

interface DialectOption { id: string; label: string }

/** MachineLibraryModal maps this export once at module load. Keep those mapped
 *  views synchronized so importing a post later in the same app session makes
 *  it visible the next time the machine definition opens. */
class LiveDialectOptionList extends Array<DialectOption> {
  private readonly views: Array<{
    callback: (value: DialectOption, index: number, array: DialectOption[]) => unknown
    thisArg: unknown
    output: unknown[]
  }> = []

  constructor(items: readonly DialectOption[]) {
    super(...items)
  }

  static get [Symbol.species](): ArrayConstructor {
    return Array
  }

  override map<U>(
    callback: (value: DialectOption, index: number, array: DialectOption[]) => U,
    thisArg?: unknown,
  ): U[] {
    const output = Array.from(this, (value, index) => callback.call(thisArg, value, index, this))
    this.views.push({ callback, thisArg, output })
    return output
  }

  replace(items: readonly DialectOption[]): void {
    this.splice(0, this.length, ...items)
    for (const view of this.views) {
      const next = Array.from(this, (value, index) => view.callback.call(view.thisArg, value, index, this))
      view.output.splice(0, view.output.length, ...next)
    }
  }
}

const dialectOptions = new LiveDialectOptionList(
  SHIPPING_DIALECTS.map((dialect) => ({ id: dialect.id, label: dialect.label })),
)

/** Compact {id, label} list for the Machine Library controller selector. */
export const DIALECT_OPTIONS: DialectOption[] = dialectOptions

const registeredUserPosts = new Map<string, UserPostConfig>()

function rebuildControllerRegistry(): void {
  const users = [...registeredUserPosts.values()]
  BUILT_IN_DIALECTS.splice(0, BUILT_IN_DIALECTS.length, ...SHIPPING_DIALECTS, ...users)
  dialectOptions.replace(BUILT_IN_DIALECTS.map((dialect) => ({
    id: dialect.id,
    label: dialect.label,
  })))
}

/** Register one saved/imported post as a controller definition. */
export function registerUserPostController(config: PostConfig | UserPostConfig): UserPostConfig {
  const normalized = withUserPostWordTable(config)
  registeredUserPosts.set(normalized.id, normalized)
  registerGcodeWordTable(normalized.id, normalized.wordTable)
  rebuildControllerRegistry()
  return normalized
}

/** Remove one saved/imported controller definition. */
export function unregisterUserPostController(id: string): void {
  registeredUserPosts.delete(id)
  unregisterGcodeWordTable(id)
  rebuildControllerRegistry()
}

/** Make browser storage the complete user-controller registry. */
export function syncUserPostControllers(configs: readonly PostConfig[]): UserPostConfig[] {
  for (const id of registeredUserPosts.keys()) unregisterGcodeWordTable(id)
  registeredUserPosts.clear()
  const normalized = configs.map((config) => withUserPostWordTable(config))
  for (const config of normalized) {
    registeredUserPosts.set(config.id, config)
    registerGcodeWordTable(config.id, config.wordTable)
  }
  rebuildControllerRegistry()
  return normalized
}

export function postProgram(input: PostInput, config: PostConfig): PostResult {
  const { wcs, operations } = input.setup

  const diagnostics = [
    ...validateToolNumbers(operations),
    ...detectRotatedWcs(wcs),
    ...validateOpsCurrent(operations),
    ...validateOpsReady(operations),
    // WO-285: warning-only, so it rides the same diagnostics list to the same
    // panel as every other validator and never blocks the post.
    ...validateProgramFitsMachine(input.machine, operations),
  ]

  if (diagnostics.some((d) => d.level === 'error')) {
    return { gcode: '', ok: false, diagnostics }
  }

  // Validation clean -> emit. The engine appends its own diagnostics (e.g.
  // ARC_MALFORMED); any error among them fails the run loud (ADR-0003).
  const emitted = emitProgram(vendorPostInput(input, config), config)
  diagnostics.push(...emitted.diagnostics)

  if (diagnostics.some((d) => d.level === 'error')) {
    return { gcode: '', ok: false, diagnostics }
  }

  const outputLines = sequenceNumberLines(vendorOutputLines(emitted.lines, config, [input]), config)
  const gcode = outputLines.length > 0 ? outputLines.join('\n') + '\n' : ''

  return {
    gcode,
    ok: true,
    diagnostics,
    meta: { opCount: operations.length, lineCount: emitted.lines.length },
    operationSpans: emitted.operationSpans,
  }
}

/**
 * Multi-setup variant of postProgram: validate EVERY input, then compose them
 * into ONE program via emitCombinedProgram (single preamble/postamble, one
 * section per input sharing a modal). Validation+wrapping mirrors postProgram;
 * any error diagnostic from any input fails the whole run loud (ADR-0003).
 */
export function postCombined(
  inputs: PostInput[],
  config: PostConfig,
  opts: { pauseBetweenSetups: boolean; sectionComments?: string[] },
): PostResult {
  // WO-2637: ONE program, so its tool numbers are checked across every
  // section - two setups' different tools sharing a number is the same
  // conflict as two operations' in one setup.
  const diagnostics: PostDiagnostic[] = validateToolNumbers(inputs.flatMap((input) => input.setup.operations))
  let opCount = 0
  for (const input of inputs) {
    const { wcs, operations } = input.setup
    opCount += operations.length
    diagnostics.push(
      ...detectRotatedWcs(wcs),
      ...validateOpsCurrent(operations),
      ...validateOpsReady(operations),
      // WO-285: per input, because each setup carries its own zero — the fit
      // question is asked once per placed section, not once per emitted file.
      ...validateProgramFitsMachine(input.machine, operations),
    )
  }

  // WO-2019: every setup using an unnumbered tool says its number; say it once.
  const told = onceEachAssignedToolNumber(diagnostics)
  diagnostics.splice(0, diagnostics.length, ...told)

  if (diagnostics.some((d) => d.level === 'error')) {
    return { gcode: '', ok: false, diagnostics }
  }

  const emitted = emitCombinedProgram(inputs.map((input) => vendorPostInput(input, config)), config, opts)
  diagnostics.push(...emitted.diagnostics)

  if (diagnostics.some((d) => d.level === 'error')) {
    return { gcode: '', ok: false, diagnostics }
  }

  const outputLines = sequenceNumberLines(vendorOutputLines(emitted.lines, config, inputs), config)
  const gcode = outputLines.length > 0 ? outputLines.join('\n') + '\n' : ''

  return {
    gcode,
    ok: true,
    diagnostics,
    meta: { opCount, lineCount: emitted.lines.length },
    operationSpans: emitted.operationSpans,
  }
}

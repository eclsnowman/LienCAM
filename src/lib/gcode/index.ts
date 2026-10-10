// ============================================================
// G-code harness barrel (reusable groundwork for an in-app sender)
// ============================================================
// A dependency-free tokenizer + modal interpreter (parse), a structured linter
// (lint), and a plan-view backplot renderer (backplot). Designed so a future
// GRBL streaming sender can reuse the same parse/lint core.

export {
  parseGcode,
  tokenize,
  tokenizeLine,
  interpret,
  type GcodeProgram,
  type GcodeLine,
  type GcodeWord,
  type GcodeSegment,
  type SegmentKind,
  type GcodePoint,
} from './parse'

export {
  lintGcode,
  assertClean,
  type LintFinding,
  type LintLevel,
  type LintOptions,
} from './lint'

export { backplotSvg, type BackplotOptions } from './backplot'

export {
  readGcodeProgram,
  type GcodeDialect,
  type GcodeWcs,
  type GcodeReaderPoint,
  type GcodeReaderOptions,
  type GcodeReadItem,
  type GcodeReaderState,
  type GcodeReadProgram,
  type GcodeReadRefusal,
  type GcodeReadResult,
  type GcodeRefusedWord,
} from './reader'

// WO-1335: posted text -> the stages the geometry program route runs.
export {
  interpretGcodeProgram,
  sameGcodeCoolantState,
  type GcodeCoolantState,
  type GcodeInterpretOptions,
  type GcodeInterpretResult,
  type GcodeAcceptedWord,
  type GcodeInterpretedProgram,
  type GcodeSpindleIntent,
  type GcodeStage,
  type GcodeStageEnd,
} from './interpret'

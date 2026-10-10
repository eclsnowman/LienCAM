// Operator-facing console messages that appear in more than one place, or that
// were the longest in the 09-23 census (docs/audits/OPERATOR-MESSAGES-2026-09-23.txt).
// COHESION-STANDARD 13.2: one sentence saying what did not happen, plus one
// action sentence only when the operator has an action. The mechanism is not
// in the line. Pure strings, no imports: the geometry worker uses it too.

/** A program, setup or file with arcs, on a machine whose X/Y travel is unknown. */
export function arcsNeedTravelMessage(subject: string): string {
  return `Not loaded: ${subject} contains arcs and the machine's X and Y travel is not set. `
    + 'Set the X and Y soft limits in the machine definition, or home a machine that reports them.'
}

/** A program with arcs whose active work offset has no known origin. */
export function arcsNeedWorkZeroMessage(wcs: string): string {
  return `Not loaded: this program contains arcs and the ${wcs} work offset is not set. `
    + `Set the work zero for ${wcs}.`
}

/** The .pro export summary, shared by the Machine Library and the Controller area. */
export function proExportSummary(stem: string, emitted: number, absent: number): string {
  return `Exported ${stem}.pro: ${emitted} settings this machine states; `
    + `${absent} more it has not stated were left out.`
}

/** interpret.ts: a second tool change or macro at one boundary. */
export function collapsedBoundaryMessage(what: string, priorWhat: string, priorLine: number): string {
  return `is ${what} with nothing moving between it and the ${priorWhat} on line ${priorLine}. `
    + 'Not loaded: only one can run at a stop - remove one or put a move between them.'
}

/** interpret.ts: a second program stop with nothing moving since the first. */
export function secondStopMessage(priorMCode: 0 | 1, priorLine: number): string {
  return `is a second program stop with nothing moving between it and the M${priorMCode} on line ${priorLine}. `
    + 'Not loaded: remove one or put a move between them.'
}

/** pathFidelity.ts: the verdict reason when no status frame named a queued move. */
export const PATH_ORDER_UNCHECKED_REASON =
  'no status frame named a move this job queued, so the path was checked for distance only, '
  + 'not for the order it was flown.'

/** machineSession.ts MDI: a work-offset select between two parts of the running program. */
export function mdiFrameBetweenPartsMessage(gNumber: string): string {
  return `Not sent: G${gNumber} selects a work offset, and a work offset cannot change between `
    + 'two parts of the running program.'
}

/** machineSession.ts MDI: a moving or dwelling action between two parts of the running program. */
export const MDI_ACTION_BETWEEN_PARTS_MESSAGE =
  'Not sent: this action moves the machine or dwells, and cannot run between two parts of the '
  + 'running program.'

/** machineSession.ts MDI: an output word addressed by pin number. */
export function mdiOutputByNumberMessage(spelled: string, what: string): string {
  return `Not sent: ${spelled} ${what}, and the machine definition names outputs by M-code. `
    + 'Point an output at an M-code and use that word.'
}

/** uccncProfileImport.ts: a homing sequence that does not start with Z. */
export function homingZNotFirstMessage(sequence: string): string {
  return `SAFETY: this profile homes ${sequence} - Z is not first. `
    + 'Imported as written; check it before homing with a tool fitted.'
}

/** modelEdgeChainBinding.ts: an operation that binds a modeled body another way. */
export function edgeChainUnsupportedMessage(opType: string, mode: string): string {
  return `"${opType}" cannot consume a picked modeled-body edge chain: `
    + `this operation binds a modeled body as "${mode}".`
}

/** geom-engine.ts: a draft whose neutral plane is tilted against the pull direction. */
export function draftTiltedNeutralPlaneMessage(
  origin: string, normal: string, faces: string, pull: string,
): string {
  return `Not computed: draft about neutral plane (origin ${origin}, normal ${normal}) is not `
    + `supported for face ${faces} - its normal must be parallel to the pull direction ${pull}.`
}

/** useMachineDefinitionPanel.tsx: typed values dropped on a machine switch. */
export function droppedTypedValuesMessage(dropped: number): string {
  return `Dropped ${dropped} typed value${dropped === 1 ? '' : 's'} that belonged to the machine `
    + 'definition that was on screen - never saved.'
}

/**
 * Shared cutter-envelope helpers for operations that derive a tool-center path
 * from a selected boundary. Profile/pocket operations use polygon offsets for
 * arbitrary loops; analytic circular operations use these scalar equivalents.
 */

const EPS = 1e-9

function fmt(value: number): string {
  return value.toFixed(3)
}

export function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number.`)
  }
  return value
}

export function toolRadiusFromDiameter(toolDiameter: number, label = 'Tool diameter'): number {
  return positiveFinite(toolDiameter, label) / 2
}

export function resolveInternalCircleTargetDiameter(args: {
  operation: string
  loopId: string
  selectedDiameter: number
  targetDiameter?: number
  allowOversize?: boolean
  tolerance?: number
}): number {
  const selected = positiveFinite(args.selectedDiameter, `${args.operation}: selected diameter for loop "${args.loopId}"`)
  const target = args.targetDiameter == null
    ? selected
    : positiveFinite(args.targetDiameter, `${args.operation}: target diameter for loop "${args.loopId}"`)

  const tol = args.tolerance ?? Math.max(0.001, selected * 1e-6)
  if (!args.allowOversize && target > selected + tol) {
    throw new Error(
      `${args.operation}: target diameter ${fmt(target)} mm exceeds selected ` +
      `diameter ${fmt(selected)} mm for loop "${args.loopId}". ` +
      'This would overcut the selected boundary; choose larger geometry or use an explicit oversize/compensation setting when available.'
    )
  }

  return target
}

export function internalCircleCenterRadius(args: {
  operation: string
  loopId: string
  targetDiameter: number
  toolDiameter: number
  minRadialClearance?: number
}): number {
  const target = positiveFinite(args.targetDiameter, `${args.operation}: target diameter for loop "${args.loopId}"`)
  const toolRadius = toolRadiusFromDiameter(args.toolDiameter, `${args.operation}: tool diameter`)
  const centerRadius = target / 2 - toolRadius
  const minClearance = args.minRadialClearance ?? 0
  if (centerRadius <= minClearance + EPS) {
    throw new Error(
      `${args.operation}: selected diameter ${fmt(target)} mm is too small for ` +
      `${fmt(args.toolDiameter)} mm tool. Use a smaller end mill or a drill operation.`
    )
  }
  return centerRadius
}

export function assertInternalCircleEnvelopeInside(args: {
  operation: string
  loopId: string
  centerRadius: number
  toolDiameter: number
  boundaryDiameter: number
  tolerance?: number
}): void {
  const toolRadius = toolRadiusFromDiameter(args.toolDiameter, `${args.operation}: tool diameter`)
  const boundaryRadius = positiveFinite(args.boundaryDiameter, `${args.operation}: boundary diameter for loop "${args.loopId}"`) / 2
  const envelopeRadius = args.centerRadius + toolRadius
  const tol = args.tolerance ?? 1e-6
  if (envelopeRadius > boundaryRadius + tol) {
    throw new Error(
      `${args.operation}: cutter envelope radius ${fmt(envelopeRadius)} mm exceeds selected ` +
      `boundary radius ${fmt(boundaryRadius)} mm for loop "${args.loopId}".`
    )
  }
}

/** Planar mm geometry. Closure is explicit; points are never silently closed. */
export interface Point { x: number; y: number }
export type Loop = Point[]
export type Loops = Loop[]
export interface Path { id: string; closed: boolean; points: Loop }
export type BooleanOperation = 'union' | 'difference' | 'intersect' | 'xor'
export type OffsetMode = 'region' | 'open-round' | 'open-side'
export type Join = 'round' | 'miter' | 'square'
export interface OffsetOptions {
  mode?: OffsetMode
  arcTolerance?: number
  minArea?: number
  join?: Join
}
export interface Profile {
  readonly id: 'face' | 'adaptive' | 'vcarve' | 'cam3d' | 'script'
  readonly precision: 4 | 6 | null
  readonly fill: 'EvenOdd' | 'NonZero' | 'Positive' | 'raycast'
  readonly offsetFill: 'native' | 'Positive' | 'script'
  /** V-carve deliberately uses a different fill for difference than union. */
  readonly differenceFill?: 'Positive'
  readonly arcTolerance: number | null
  readonly decimation: number | null
  readonly miterLimit: number
  readonly orientation: 'preserve-native'
  readonly origin: string
}
export interface Backend {
  readonly profile: Profile
  readonly offsetModes: readonly OffsetMode[]
  readonly joins: readonly Join[]
  readonly booleans: readonly BooleanOperation[]
  /** False for geom2d, whose legacy boolean validates both operands. */
  readonly emptyBooleanOperand: boolean
  offset(loops: Loops, delta: number, options: OffsetOptions): Loops
  boolean?(subject: Loops, clip: Loops, op: BooleanOperation): Loops
  /** Preserve the native caller's answer without inventing a boundary rule. */
  membership?(point: Point, loop: Loop): boolean | -1 | 0 | 1
}
export interface Diagnostic {
  code: 'invalid-input' | 'open-skipped' | 'self-intersection' | 'collapsed' | 'unsupported' | 'backend-error'
  message: string
  pathId?: string
}
export interface Result<T> {
  status: 'supported' | 'degraded' | 'rejected' | 'unsupported'
  value: T | null
  diagnostics: Diagnostic[]
  profile: Profile
}
export type Location = 'inside' | 'outside' | 'boundary'
export interface PredicateAnswer {
  location: Location
  legacyMembership?: boolean | -1 | 0 | 1
}

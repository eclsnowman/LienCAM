import type { Backend, BooleanOperation, Diagnostic, Loops, OffsetOptions, Path, Point, PredicateAnswer, Result } from './contracts'
import { locatePoint, selfIntersects } from './predicates'
export * from './contracts'
export * from './profiles'
export * from './adapters'
export * from './predicates'
export * from './tolerance'

export function createGeometryService(backend: Backend) {
  const result = <T>(status: Result<T>['status'], value: T | null, diagnostics: Diagnostic[]): Result<T> => ({ status, value, diagnostics, profile: backend.profile })
  const unsupported = <T>(message: string) => result<T>('unsupported', null, [{ code: 'unsupported', message }])
  function validate(paths: Path[]): Diagnostic[] {
    if (!paths.length || paths.some(p => !p.points.length || p.points.some(pt => !Number.isFinite(pt.x) || !Number.isFinite(pt.y)))) {
      return [{ code: 'invalid-input', message: 'the selected geometry has no usable points' }]
    }
    return []
  }
  function select(paths: Path[], mode: 'region' | 'open-round' | 'open-side', diagnostics: Diagnostic[], fill = backend.profile.offsetFill === 'native' ? 'backend-native offset (orientation preserved)' : backend.profile.offsetFill): Loops {
    const selected: Loops = []
    for (const path of paths) {
      if ((mode === 'region' && !path.closed) || (mode !== 'region' && path.closed)) {
        diagnostics.push({ code: 'open-skipped', pathId: path.id, message: mode === 'region'
          ? `open chain ${path.id} skipped - this operation needs closed loops`
          : `closed loop ${path.id} skipped - this operation needs open chains` })
        continue
      }
      if (path.points.length < (path.closed ? 3 : 2)) {
        diagnostics.push({ code: 'open-skipped', pathId: path.id, message: `path ${path.id} skipped - too few points for this operation` })
        continue
      }
      if (path.closed && selfIntersects(path.points)) diagnostics.push({ code: 'self-intersection', pathId: path.id,
        message: `loop ${path.id} crosses itself; filled by the ${fill} rule` })
      // Do not let a third-party adapter mutate the caller's geometry.
      selected.push(path.points.map(p => ({ ...p })))
    }
    return selected
  }
  function execute(loops: () => Loops, diagnostics: Diagnostic[]): Result<Loops> {
    try {
      const value = loops()
      if (!value.length) diagnostics.push({ code: 'collapsed', message: 'the operation produced an empty region' })
      return result(diagnostics.some(d => d.code === 'open-skipped') ? 'degraded' : 'supported', value, diagnostics)
    } catch (error) {
      return result<Loops>('rejected', null, [...diagnostics, { code: 'backend-error', message: error instanceof Error ? error.message : String(error) }])
    }
  }
  return {
    profile: backend.profile,
    offset(paths: Path[], delta: number, options: OffsetOptions = {}): Result<Loops> {
      const diagnostics = validate(paths)
      if (!Number.isFinite(delta) || (options.arcTolerance !== undefined && (!Number.isFinite(options.arcTolerance) || options.arcTolerance <= 0))
        || (options.minArea !== undefined && (!Number.isFinite(options.minArea) || options.minArea < 0))) diagnostics.push({ code: 'invalid-input', message: 'offset parameters must be finite and tolerances positive' })
      if (diagnostics.length) return result<Loops>('rejected', null, diagnostics)
      const mode = options.mode ?? 'region'
      const join = options.join ?? (backend.profile.id === 'script' ? 'miter' : 'round')
      if (!backend.offsetModes.includes(mode) || !backend.joins.includes(join)) return unsupported<Loops>(`${backend.profile.id} does not support ${mode}/${join}`)
      if (options.arcTolerance !== undefined && backend.profile.id === 'face' && options.arcTolerance !== backend.profile.arcTolerance) return unsupported<Loops>('face arc tolerance is fixed by CAM-14')
      if (options.arcTolerance !== undefined && backend.profile.id === 'script') return unsupported<Loops>('script signed-side offsets have no arc tolerance')
      if (options.minArea !== undefined && backend.profile.id !== 'face') return unsupported<Loops>('minArea is supported only by the face compatibility profile')
      const loops = select(paths, mode, diagnostics)
      // Negative signed-side offsets are left offsets, not inward regions.
      if (mode === 'open-round' && delta <= 0) {
        for (const path of paths.filter(p => !p.closed)) diagnostics.push({ code: 'open-skipped', pathId: path.id, message: `open chain ${path.id} skipped - an open chain has no inside` })
        return result('degraded', [], diagnostics)
      }
      if (!loops.length) return result('degraded', [], diagnostics)
      return execute(() => backend.offset(loops, delta, { ...options, mode, join }), diagnostics)
    },
    boolean(subject: Path[], clip: Path[], op: BooleanOperation): Result<Loops> {
      if (!backend.booleans.includes(op) || !backend.boolean) return unsupported<Loops>(`${backend.profile.id} does not support boolean ${op}`)
      const diagnostics = validate([...subject, ...clip])
      if (diagnostics.length) return result<Loops>('rejected', null, diagnostics)
      const fill = op === 'difference' ? backend.profile.differenceFill ?? backend.profile.fill : backend.profile.fill
      const a = select(subject, 'region', diagnostics, fill), b = select(clip, 'region', diagnostics, fill)
      if ((!a.length || !b.length) && !backend.emptyBooleanOperand) return unsupported<Loops>('this legacy backend requires two nonempty closed operands')
      return execute(() => backend.boolean!(a, b, op), diagnostics)
    },
    predicate(point: Point, path: Path): Result<PredicateAnswer> {
      const diagnostics = validate([path])
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) diagnostics.push({ code: 'invalid-input', message: 'query point must be finite' })
      if (diagnostics.length) return result<PredicateAnswer>('rejected', null, diagnostics)
      if (!path.closed || path.points.length < 3) return unsupported<PredicateAnswer>('containment requires a closed loop')
      const location = locatePoint(point, [path.points], backend.profile.fill === 'raycast' ? 'EvenOdd' : backend.profile.fill)
      return result('supported', { location, legacyMembership: backend.membership?.(point, path.points) }, diagnostics)
    },
  }
}

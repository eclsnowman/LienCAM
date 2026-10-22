// pattern2d spec - parse, validate and convert a PatternSpec to mm (WO-2982).
//
// Sandbox (PLAN sec. 5): expressions go through the hand-rolled params parser
// (src/doc/params/parser.ts, used read-only) - no eval, no new Function, no
// interpreter. Names resolve only to `t` and the curve's own params (a depth
// expression: x, y, t); anything else is refused with its position. Unknown
// keys anywhere in the spec (e.g. `gcode`) are refused, so a pattern can only
// ever describe a path.
//
// Rule 11: only what the software cannot do is refused here - a spec it cannot
// read, a value it cannot use (a non-positive chord tolerance, a fractional
// copy count). There are no size caps.

import { FUNCTION_NAMES, MM_PER_INCH, ParamParseError, parseExpression } from '../../../doc/params'
import type { ParamAst } from '../../../doc/params'
import type { PatternParam, PatternPresetName, PatternTransform, PatternUnits } from './types'

export type PatternDiagCode =
  | 'PATTERN_SYNTAX_ERROR'
  | 'PATTERN_UNKNOWN_FUNCTION'
  | 'PATTERN_UNKNOWN_NAME'
  | 'PATTERN_UNKNOWN_KEY'
  | 'PATTERN_BAD_VALUE'
  | 'PATTERN_NON_FINITE'
  | 'PATTERN_NO_REGION'

export interface PatternDiag {
  code: PatternDiagCode
  /** Where in the spec, e.g. `curves[0].r`. */
  path: string
  /** Character offset into the expression, when the problem has one. */
  pos?: number
  snippet?: string
}

/** A refusal: the software cannot make this pattern. The message is one
 *  plain-language line naming where and why. */
export class PatternSpecError extends Error {
  readonly diagnostic: PatternDiag
  constructor(diagnostic: PatternDiag, detail: string) {
    const at = diagnostic.pos === undefined ? '' : ` (position ${diagnostic.pos}, near '${diagnostic.snippet}')`
    super(`Pattern ${diagnostic.path}: ${detail}${at}.`)
    this.name = 'PatternSpecError'
    this.diagnostic = diagnostic
  }
}

export interface CompiledExpr {
  path: string
  source: string
  ast: ParamAst
}

/** A resolved similarity transform; lengths already in mm. */
export type ResolvedTransform =
  | { kind: 'translate'; dx: number; dy: number }
  | { kind: 'rotate'; deg: number }
  | { kind: 'scale'; s: number }
  | { kind: 'mirror'; axis: 'x' | 'y' }
  | { kind: 'polar-array'; count: number; deg: number }

export interface ResolvedCurve {
  path: string
  kind: 'polar' | 'xy'
  /** polar: [r]; xy: [x, y]. */
  exprs: CompiledExpr[]
  t: [number, number]
  /** Param values in mm (lengths) or as written (ratios). */
  params: ReadonlyMap<string, number>
  transforms: ResolvedTransform[]
}

export interface ResolvedPatternSpec {
  units: PatternUnits
  anchor: { kind: 'region-centroid' } | { kind: 'wcs-origin' } | { kind: 'point'; x: number; y: number }
  curves: ResolvedCurve[]
  depth: { kind: 'const'; mm: number } | { kind: 'expr'; expr: CompiledExpr }
  chordTol: number
  clip: 'none' | 'region'
}

export const DEFAULT_CHORD_TOL_MM = 0.005

const RESERVED = new Set<string>(['t', 'x', 'y', 'pi', 'mm', 'in', ...FUNCTION_NAMES])
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

// ── small validators ──────────────────────────────────────────────────────────

function bad(path: string, detail: string): PatternSpecError {
  return new PatternSpecError({ code: 'PATTERN_BAD_VALUE', path }, detail)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new PatternSpecError({ code: 'PATTERN_UNKNOWN_KEY', path: path ? `${path}.${key}` : key },
        `'${key}' is not a pattern field (a pattern describes a path only; allowed here: ${allowed.join(', ')})`)
    }
  }
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(path, 'must be a finite number')
  return v
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') throw bad(path, 'must be an expression string')
  return v
}

/** Offset of the first use of `name` as a plain reference (not a call). */
function refPosition(source: string, name: string): number {
  const re = /[A-Za-z_][A-Za-z0-9_]*/g
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (m[0] !== name) continue
    const rest = source.slice(m.index + m[0].length)
    if (!/^\s*\(/.test(rest)) return m.index
  }
  return 0
}

/** Parse one expression and check every name it uses is in `names`. */
export function compileExpr(source: string, path: string, names: ReadonlySet<string>): CompiledExpr {
  let parsed
  try {
    parsed = parseExpression(source)
  } catch (err) {
    if (!(err instanceof ParamParseError)) throw err
    const p = err.diagnostic.params
    const pos = Number(p.pos)
    if (err.diagnostic.code === 'PARAM_UNKNOWN_FUNCTION') {
      throw new PatternSpecError({ code: 'PATTERN_UNKNOWN_FUNCTION', path, pos, snippet: p.snippet },
        `unknown function '${p.name}' (functions: ${FUNCTION_NAMES.join(', ')})`)
    }
    throw new PatternSpecError({ code: 'PATTERN_SYNTAX_ERROR', path, pos, snippet: p.snippet }, p.detail)
  }
  for (const ref of parsed.refs) {
    if (names.has(ref)) continue
    const pos = refPosition(source, ref)
    const known = [...names].join(', ')
    throw new PatternSpecError({ code: 'PATTERN_UNKNOWN_NAME', path, pos, snippet: ref },
      `unknown name '${ref}' (names here: ${known})`)
  }
  return { path, source, ast: parsed.ast }
}

// ── transforms and params ─────────────────────────────────────────────────────

function resolveTransforms(raw: unknown, path: string, k: number): ResolvedTransform[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw bad(path, 'must be a list of transforms')
  return raw.map((tr, i): ResolvedTransform => {
    const p = `${path}[${i}]`
    if (!isObject(tr)) throw bad(p, 'must be a transform object')
    switch (tr.kind) {
      case 'translate':
        checkKeys(tr, ['kind', 'dx', 'dy'], p)
        return { kind: 'translate', dx: num(tr.dx, `${p}.dx`) * k, dy: num(tr.dy, `${p}.dy`) * k }
      case 'rotate':
        checkKeys(tr, ['kind', 'deg'], p)
        return { kind: 'rotate', deg: num(tr.deg, `${p}.deg`) }
      case 'scale':
        checkKeys(tr, ['kind', 's'], p)
        return { kind: 'scale', s: num(tr.s, `${p}.s`) }
      case 'mirror':
        checkKeys(tr, ['kind', 'axis'], p)
        if (tr.axis !== 'x' && tr.axis !== 'y') throw bad(`${p}.axis`, "must be 'x' or 'y'")
        return { kind: 'mirror', axis: tr.axis }
      case 'polar-array': {
        checkKeys(tr, ['kind', 'count', 'deg'], p)
        const count = num(tr.count, `${p}.count`)
        if (!Number.isInteger(count) || count < 1) throw bad(`${p}.count`, 'must be a whole number of copies, 1 or more')
        const deg = tr.deg === undefined ? 360 / count : num(tr.deg, `${p}.deg`)
        return { kind: 'polar-array', count, deg }
      }
      default:
        throw bad(`${p}.kind`, "must be 'translate', 'rotate', 'scale', 'mirror' or 'polar-array'")
    }
  })
}

function resolveParams(raw: unknown, path: string, k: number): Map<string, number> {
  const out = new Map<string, number>()
  if (raw === undefined) return out
  if (!Array.isArray(raw)) throw bad(path, 'must be a list of { name, value, length }')
  raw.forEach((entry, i) => {
    const p = `${path}[${i}]`
    if (!isObject(entry)) throw bad(p, 'must be { name, value, length }')
    checkKeys(entry, ['name', 'value', 'length'], p)
    const name = entry.name
    if (typeof name !== 'string' || !IDENT.test(name)) throw bad(`${p}.name`, 'must be a plain name (letters, digits, _)')
    if (RESERVED.has(name)) throw bad(`${p}.name`, `'${name}' is reserved`)
    if (out.has(name)) throw bad(`${p}.name`, `'${name}' is defined twice`)
    if (typeof entry.length !== 'boolean') throw bad(`${p}.length`, 'must be true (a length) or false (a ratio or count)')
    out.set(name, num(entry.value, `${p}.value`) * (entry.length ? k : 1))
  })
  return out
}

function tRange(raw: unknown, path: string): [number, number] {
  if (!Array.isArray(raw) || raw.length !== 2) throw bad(path, 'must be [start, end]')
  return [num(raw[0], `${path}[0]`), num(raw[1], `${path}[1]`)]
}

// ── presets: each expands to ordinary curves in the same grammar ──────────────

interface PresetDef {
  /** Default per param; `length` params convert with the spec units. */
  defaults: Record<string, { value: number; length: boolean }>
  expand(p: Record<string, number>, path: string): Array<Omit<ResolvedCurve, 'transforms'> & { extra?: ResolvedTransform[] }>
}

function positive(p: Record<string, number>, name: string, path: string): void {
  if (!(p[name] > 0)) throw bad(`${path}.params.${name}`, 'must be greater than 0')
}

/** Parallel line family centred on the frame origin: one xy curve per line,
 *  alternating direction so consecutive passes start where the last ended. */
function lineFamily(p: Record<string, number>, path: string, amplitude: number, wavelength: number): Array<Omit<ResolvedCurve, 'transforms'>> {
  const n = Math.max(0, Math.floor(p.height / p.spacing + 1e-9) + 1)
  const names = new Set(['t', 'c', 'amp', 'wl'])
  const x = compileExpr('t', `${path}.x`, names)
  const y = compileExpr(amplitude === 0 ? 'c' : 'c + amp * sin(360 * t / wl)', `${path}.y`, names)
  const half = p.width / 2
  return Array.from({ length: n }, (_, i) => ({
    path: `${path} line ${i + 1}`,
    kind: 'xy' as const,
    exprs: [x, y],
    t: (i % 2 === 0 ? [-half, half] : [half, -half]) as [number, number],
    params: new Map([['c', -((n - 1) * p.spacing) / 2 + i * p.spacing], ['amp', amplitude], ['wl', wavelength]]),
  }))
}

const PRESETS: Record<PatternPresetName, PresetDef> = {
  'rose-spiral': {
    defaults: {
      r0: { value: 27.5, length: true }, pitch: { value: 1.6, length: true },
      amp: { value: 0.02, length: false }, lobes: { value: 9, length: false }, turns: { value: 15, length: false },
    },
    expand(p, path) {
      const names = new Set(['t', 'r0', 'pitch', 'amp', 'lobes'])
      return [{
        path, kind: 'polar',
        exprs: [compileExpr('(r0 - pitch * t / 360) * (1 + amp * sin(lobes * t))', `${path}.r`, names)],
        t: [0, 360 * p.turns],
        params: new Map([['r0', p.r0], ['pitch', p.pitch], ['amp', p.amp], ['lobes', p.lobes]]),
      }]
    },
  },
  'sine-raster': {
    defaults: {
      width: { value: 40, length: true }, height: { value: 30, length: true }, spacing: { value: 3, length: true },
      amplitude: { value: 1, length: true }, wavelength: { value: 10, length: true },
    },
    expand(p, path) {
      positive(p, 'spacing', path)
      // WO-3001: with no amplitude the lines are straight and the wavelength is
      // never read, so 0 is accepted there (lineFamily emits y = c).
      if (p.wavelength === 0 && p.amplitude !== 0) throw bad(`${path}.params.wavelength`, 'must not be 0')
      return lineFamily(p, path, p.amplitude, p.wavelength)
    },
  },
  epitrochoid: {
    defaults: {
      R: { value: 20, length: true }, r: { value: 5, length: true }, d: { value: 8, length: true },
      turns: { value: 1, length: false },
    },
    expand(p, path) {
      if (p.r === 0) throw bad(`${path}.params.r`, 'must not be 0')
      const names = new Set(['t', 'R', 'r', 'd'])
      return [{
        path, kind: 'xy',
        exprs: [
          compileExpr('(R + r) * cos(t) - d * cos((R + r) / r * t)', `${path}.x`, names),
          compileExpr('(R + r) * sin(t) - d * sin((R + r) / r * t)', `${path}.y`, names),
        ],
        t: [0, 360 * p.turns],
        params: new Map([['R', p.R], ['r', p.r], ['d', p.d]]),
      }]
    },
  },
  'line-moire': {
    defaults: {
      width: { value: 40, length: true }, height: { value: 30, length: true }, spacing: { value: 2, length: true },
      angle: { value: 5, length: false },
    },
    expand(p, path) {
      positive(p, 'spacing', path)
      const a = lineFamily(p, `${path} family 1`, 0, 1)
      const b = lineFamily(p, `${path} family 2`, 0, 1).map(c => ({ ...c, extra: [{ kind: 'rotate' as const, deg: p.angle }] }))
      return [...a, ...b]
    },
  },
}

function resolvePreset(c: Record<string, unknown>, path: string, k: number): ResolvedCurve[] {
  checkKeys(c, ['kind', 'name', 'params', 'transforms'], path)
  const name = c.name
  if (typeof name !== 'string' || !Object.hasOwn(PRESETS, name)) {
    throw bad(`${path}.name`, `must be one of ${Object.keys(PRESETS).join(', ')}`)
  }
  const def = PRESETS[name as PatternPresetName]
  const given = c.params === undefined ? {} : c.params
  if (!isObject(given)) throw bad(`${path}.params`, 'must be an object of numbers')
  checkKeys(given, Object.keys(def.defaults), `${path}.params`)
  const p: Record<string, number> = {}
  for (const [key, d] of Object.entries(def.defaults)) {
    const v = given[key] === undefined ? d.value : num(given[key], `${path}.params.${key}`)
    p[key] = v * (d.length ? k : 1)
  }
  const transforms = resolveTransforms(c.transforms, `${path}.transforms`, k)
  return def.expand(p, path).map(({ extra, ...curve }) => ({ ...curve, transforms: [...(extra ?? []), ...transforms] }))
}

function resolveCurve(c: unknown, path: string, k: number): ResolvedCurve[] {
  if (!isObject(c)) throw bad(path, 'must be a curve object')
  if (c.kind === 'preset') return resolvePreset(c, path, k)
  if (c.kind !== 'polar' && c.kind !== 'xy') throw bad(`${path}.kind`, "must be 'polar', 'xy' or 'preset'")
  const fields = c.kind === 'polar' ? ['r'] : ['x', 'y']
  checkKeys(c, ['kind', ...fields, 't', 'params', 'transforms'], path)
  const params = resolveParams(c.params, `${path}.params`, k)
  const names = new Set(['t', ...params.keys()])
  return [{
    path,
    kind: c.kind,
    exprs: fields.map(f => compileExpr(str(c[f], `${path}.${f}`), `${path}.${f}`, names)),
    t: tRange(c.t, `${path}.t`),
    params,
    transforms: resolveTransforms(c.transforms, `${path}.transforms`, k),
  }]
}

/** Validate a raw spec (as stored on an operation) and convert it to mm.
 *  Throws PatternSpecError naming the field (and expression position) it cannot use. */
export function parsePatternSpec(raw: unknown): ResolvedPatternSpec {
  if (!isObject(raw)) throw bad('spec', 'must be a pattern object')
  checkKeys(raw, ['version', 'units', 'anchor', 'curves', 'depth', 'chordTol', 'clip'], '')
  if (raw.version !== 1) throw bad('version', 'must be 1')
  if (raw.units !== 'mm' && raw.units !== 'in') throw bad('units', "must be 'mm' or 'in'")
  const units = raw.units
  const k = units === 'in' ? MM_PER_INCH : 1

  let anchor: ResolvedPatternSpec['anchor']
  if (raw.anchor === 'region-centroid' || raw.anchor === 'wcs-origin') {
    anchor = { kind: raw.anchor }
  } else if (isObject(raw.anchor)) {
    checkKeys(raw.anchor, ['x', 'y'], 'anchor')
    anchor = { kind: 'point', x: num(raw.anchor.x, 'anchor.x') * k, y: num(raw.anchor.y, 'anchor.y') * k }
  } else {
    throw bad('anchor', "must be 'region-centroid', 'wcs-origin' or { x, y }")
  }

  if (!Array.isArray(raw.curves) || raw.curves.length === 0) throw bad('curves', 'must list at least one curve')
  const curves = raw.curves.flatMap((c, i) => resolveCurve(c, `curves[${i}]`, k))

  let depth: ResolvedPatternSpec['depth']
  if (typeof raw.depth === 'number') {
    depth = { kind: 'const', mm: num(raw.depth, 'depth') * k }
  } else if (isObject(raw.depth)) {
    checkKeys(raw.depth, ['expr'], 'depth')
    depth = { kind: 'expr', expr: compileExpr(str(raw.depth.expr, 'depth.expr'), 'depth.expr', new Set(['x', 'y', 't'])) }
  } else {
    throw bad('depth', 'must be a number or { expr }')
  }

  const chordTol = raw.chordTol === undefined ? DEFAULT_CHORD_TOL_MM : num(raw.chordTol, 'chordTol') * k
  if (!(chordTol > 0)) throw bad('chordTol', 'must be greater than 0')

  const clip = raw.clip === undefined ? 'none' : raw.clip
  if (clip !== 'none' && clip !== 'region') throw bad('clip', "must be 'none' or 'region'")

  return { units, anchor, curves, depth, chordTol, clip }
}

export type { PatternParam, PatternTransform }

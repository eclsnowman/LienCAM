import {
  engagedForLoop, engagedForMaterialSide, flipSide, flipWinding, foldForSpindle, loopWindingFor,
  materialSideFor, spindleForCutHand,
  type LoopWinding, type MaterialSide, type MillingDirection, type SpindleRotation,
} from './rules'
import { FAMILY_POLICY, familyFolds, resolveFlags, type DirectionFamily, type DirectionFlags } from './policy'

// WO-3003 (alpha.3 A3-14, P2 parity slice): one direction service defined by the
// engaged side. In: the loop (closure, winding), the material fact, the
// operator's preference and the cutter hand. Out: the traversal, the engaged side
// computed from the geometry alone, whether the fold was applied, and one-line
// notices. It never refuses an operator input; with every flag off it returns
// exactly what today's engine does, including the rows whose label does not
// name the side they engage (BL-397), which it reports instead of correcting.

export type DirectionPreference = MillingDirection | 'both_ways' | 'as_drawn' | 'auto'
export type ResolvedPreference = MillingDirection | 'both_ways' | 'as_drawn'

export type MaterialSource = 'side-parameter' | 'nesting' | 'probe' | 'fill-order' | 'none'

export interface MaterialFact {
  source: Exclude<MaterialSource, 'none'>
  /** Closed loop: the loop encloses the material (an outside profile, an island wall). */
  inside?: boolean
  /** Open curve: the side of the DRAWN order the material sits on. */
  sideOfDrawn?: MaterialSide
  /** Nesting role when the source is nesting; standard winding is CCW outer, CW hole.
   *  With no `inside`, nesting parity decides it the way chamfer2d.ts:177-191 does
   *  today: an outer loop bounds the part (material inside), a hole does not. */
  nesting?: 'outer' | 'hole'
}

/** Draft step 1: normalise the material side; an explicit `inside` wins over nesting parity. */
function normalizeMaterial(material: MaterialFact | undefined): MaterialFact | undefined {
  if (material?.source !== 'nesting' || material.inside !== undefined || !material.nesting) return material
  return { ...material, inside: material.nesting === 'outer' }
}

export type PassRole =
  | 'loop' | 'orbit' | 'trace'
  | 'pocket-rough-ring' | 'pocket-outer-wall' | 'pocket-island-wall'
  | 'face-linear' | 'face-zigzag' | 'face-one-way' | 'face-offset' | 'face-spiral'

export interface DirectionRequest {
  family: DirectionFamily
  /** Operator preference. Adaptive 2D reads `adaptiveStoredBit` instead. */
  preference?: DirectionPreference
  /** Adaptive 2D's persisted legacy `climb` bit (true/undefined -> conventional today). */
  adaptiveStoredBit?: boolean
  /** Tool cut hand as stored; anything but 'left' is a right-hand cutter. */
  cutHand?: unknown
  role?: PassRole
  /** Pocket and face rings: which way the rings advance. */
  fill?: 'outside_in' | 'inside_out'
  loop?: { closed: boolean; winding?: LoopWinding }
  material?: MaterialFact
}

export interface DirectionResolution {
  family: DirectionFamily
  role: PassRole
  /** The physical direction after the parity policy (Adaptive 2D legacy bit, auto). */
  selected: ResolvedPreference
  /** The same direction in the CW-spindle convention planners are written in. */
  planner: ResolvedPreference
  spindle: SpindleRotation
  foldApplied: boolean
  /** Side of travel the planner keeps the material on. */
  materialSide?: MaterialSide
  /** Traversal winding of a closed loop, ring or orbit. */
  winding?: LoopWinding
  /** Walk the given loop (its stated winding) or open curve (its drawn order) backwards. */
  reverse?: boolean
  /** Orbit sense, +1 counter-clockwise (Y-up). */
  orbitSense?: 1 | -1
  /** Face one-way passes travel +X' (true) or -X' (false). */
  travelPlusX?: boolean
  /** What the pass engages, from the geometry alone (never from the label). */
  engaged: MillingDirection | 'both' | 'follows-drawing' | 'unknown'
  /** Whether `selected` names the side engaged; undefined when it cannot be judged. */
  labelMatchesEngaged?: boolean
  materialSource: MaterialSource
  notices: string[]
}

const DEFAULT_ROLE: Readonly<Record<DirectionFamily, PassRole>> = {
  contour: 'loop', chamfer: 'loop', bore: 'orbit', thread: 'orbit', trochoid: 'orbit', engrave: 'loop',
  pocket: 'pocket-rough-ring', face: 'face-linear', adaptive2d: 'loop',
  adaptive3d: 'loop', rest3d: 'loop', wallCleanup3d: 'loop', waterline: 'loop', scallop: 'trace', pencil: 'trace',
}

const ROLES: Readonly<Record<DirectionFamily, readonly PassRole[]>> = {
  contour: ['loop'], chamfer: ['loop'], bore: ['orbit'], thread: ['orbit'], trochoid: ['orbit'],
  engrave: ['loop', 'orbit'],
  pocket: ['pocket-rough-ring', 'pocket-outer-wall', 'pocket-island-wall'],
  face: ['face-linear', 'face-zigzag', 'face-one-way', 'face-offset', 'face-spiral'],
  adaptive2d: ['loop'], adaptive3d: ['loop'], rest3d: ['loop'], wallCleanup3d: ['loop'], waterline: ['loop'],
  scallop: ['trace'], pencil: ['trace'],
}

export const NOTICE_FOLLOWS_DRAWING = 'Direction follows the drawing.'
export const NOTICE_NESTING_WINS = 'A loop is wound against its nesting; the nesting decides the cut side.'
export const NOTICE_AUTO_CLIMB = 'Direction "auto" cuts climb.'

function selectedFor(request: DirectionRequest, flags: Readonly<DirectionFlags>, notices: string[]): ResolvedPreference {
  if (request.family === 'adaptive2d') {
    // RC-005 / alpha3-05 I06: the stored bit means "conventional" unless it is
    // exactly false. MD-73 (carded) makes a missing bit climb.
    if (request.adaptiveStoredBit === undefined && flags.adaptive2d_default_climb) return 'climb'
    return request.adaptiveStoredBit === false ? 'climb' : 'conventional'
  }
  const preference = request.preference ?? FAMILY_POLICY[request.family].missingPreference
  if (preference === 'auto') { notices.push(NOTICE_AUTO_CLIMB); return 'climb' }
  if (preference === 'climb' || preference === 'conventional') return preference
  if (preference === 'both_ways' && request.family === 'face') return preference
  if (preference === 'as_drawn' && request.family === 'engrave') return preference
  throw new Error(`Direction ${String(preference)} is not a ${request.family} direction.`)
}

function judged(result: DirectionResolution): DirectionResolution {
  if ((result.engaged === 'climb' || result.engaged === 'conventional')
    && (result.selected === 'climb' || result.selected === 'conventional')) {
    result.labelMatchesEngaged = result.engaged === result.selected
  }
  return result
}

/** Resolve one loop or pass. Pure and deterministic; reads no store or DOM. */
export function resolveDirection(request: DirectionRequest, flagInput?: Partial<DirectionFlags>): DirectionResolution {
  const flags = resolveFlags(flagInput)
  const family = request.family
  const policy = FAMILY_POLICY[family]
  if (!policy) throw new Error(`Unknown direction family "${String(family)}".`)
  const role = request.role ?? DEFAULT_ROLE[family]
  if (!ROLES[family].includes(role)) throw new Error(`Pass role ${role} is not a ${family} role.`)
  const notices: string[] = []
  const spindle = spindleForCutHand(request.cutHand)
  const selected = selectedFor(request, flags, notices)
  const folds = familyFolds(family, flags)
  const fold = (direction: MillingDirection) => folds ? foldForSpindle(direction, spindle) : direction
  const planner: ResolvedPreference = selected === 'climb' || selected === 'conventional' ? fold(selected) : selected
  const material = normalizeMaterial(request.material)
  const loop = request.loop
  const result: DirectionResolution = {
    family, role, selected, planner, spindle,
    foldApplied: folds && spindle === 'ccw' && planner !== selected,
    engaged: 'unknown', materialSource: material?.source ?? 'none', notices,
  }
  if (material?.source === 'nesting' && material.nesting && loop?.closed && loop.winding
    && loop.winding !== (material.nesting === 'outer' ? 'ccw' : 'cw')) notices.push(NOTICE_NESTING_WINS)

  // A closed loop walked with `winding`: reverse against its stated winding, and
  // the engaged side when the material fact is known.
  const wind = (winding: LoopWinding, inside: boolean | undefined) => {
    result.winding = winding
    if (loop?.winding) result.reverse = loop.winding !== winding
    if (inside !== undefined) result.engaged = engagedForLoop(winding, inside, spindle)
  }

  if (selected === 'as_drawn') {
    // Engrave "as drawn": closed loops keep their source winding, open strokes
    // their drawn order; orbits still turn the climb way for this cutter.
    result.reverse = false
    result.engaged = 'follows-drawing'
    if (role === 'orbit') result.orbitSense = loopWindingFor(fold('climb'), false) === 'ccw' ? 1 : -1
    notices.push(NOTICE_FOLLOWS_DRAWING)
    return result
  }

  if (family === 'face') {
    const single = planner === 'both_ways' ? undefined : planner
    if (role === 'face-zigzag' || (role === 'face-linear' && !single)) {
      result.engaged = 'both'
      return result
    }
    if (role === 'face-linear' || role === 'face-one-way') {
      result.travelPlusX = single !== 'conventional'
      return result
    }
    // Rings and the spiral advance outside-in: the standing stock is inside each ring.
    const ringDirection: MillingDirection = role === 'face-spiral'
      ? fold(selected === 'both_ways' ? 'climb' : selected)
      : single === 'conventional' ? 'conventional' : 'climb'
    wind(flags.labels_mean_engaged_side
      ? loopWindingFor(ringDirection, true)
      : ringDirection === 'climb' ? 'ccw' : 'cw', true)
    return judged(result)
  }

  const direction = planner as MillingDirection
  result.materialSide = materialSideFor(direction)

  if (family === 'pocket') {
    if (role === 'pocket-rough-ring') {
      // Outside-in rings hold the stock inside; inside-out rings have it outside.
      const inside = (request.fill ?? 'outside_in') === 'outside_in'
      wind(flags.labels_mean_engaged_side
        ? loopWindingFor(direction, inside)
        : direction === 'conventional' ? 'cw' : 'ccw', inside)
      result.materialSource = 'fill-order'
    } else if (role === 'pocket-island-wall') {
      wind(direction === 'conventional' ? 'ccw' : 'cw', true)
    } else {
      // The outer wall finish keeps its path for climb and reverses it for conventional.
      result.reverse = direction === 'conventional'
      if (loop?.winding) {
        result.winding = result.reverse ? flipWinding(loop.winding) : loop.winding
        result.engaged = engagedForLoop(result.winding, false, spindle)
      }
    }
    return judged(result)
  }

  if (family === 'scallop' || family === 'pencil') {
    if (family === 'scallop') {
      // Climb walks every closed ring clockwise, whatever the material side.
      if (loop?.closed !== false) wind(direction === 'climb' ? 'cw' : 'ccw', material?.inside)
    } else {
      result.reverse = direction === 'conventional'
      if (material?.sideOfDrawn) result.engaged = engagedForMaterialSide(result.reverse ? flipSide(material.sideOfDrawn) : material.sideOfDrawn, spindle)
    }
    return judged(result)
  }

  if (role === 'orbit') {
    // The orbit cuts the wall around it (bore, internal thread, trochoid) or the
    // boss inside it (external thread).
    const inside = material?.inside ?? false
    wind(loopWindingFor(direction, inside), inside)
    result.orbitSense = result.winding === 'ccw' ? 1 : -1
    return judged(result)
  }

  if (loop && !loop.closed) {
    if (family === 'engrave') {
      // engrave2d/index.ts:224-235 turns only closed curves for the direction; an open
      // stroke keeps its drawn order. Report what it engages, never correct it at parity.
      result.reverse = false
      if (material?.sideOfDrawn) result.engaged = engagedForMaterialSide(material.sideOfDrawn, spindle)
      else { result.engaged = 'follows-drawing'; notices.push(NOTICE_FOLLOWS_DRAWING) }
    } else if (material?.sideOfDrawn) {
      result.reverse = material.sideOfDrawn !== result.materialSide
      result.engaged = engagedForMaterialSide(result.reverse ? flipSide(material.sideOfDrawn) : material.sideOfDrawn, spindle)
    } else {
      result.reverse = false
      result.engaged = 'follows-drawing'
      notices.push(NOTICE_FOLLOWS_DRAWING)
    }
    return judged(result)
  }

  if (family === 'engrave') {
    // Engrave winds every closed loop as if the material were inside it
    // (climb -> CW), whatever its side (G-31 / G-32 open; decided on the card).
    wind(loopWindingFor(direction, true), material?.inside)
    return judged(result)
  }

  if (loop && material?.inside !== undefined) wind(loopWindingFor(direction, material.inside), material.inside)
  return judged(result)
}

export interface DirectionService {
  readonly flags: Readonly<DirectionFlags>
  resolve(request: DirectionRequest): DirectionResolution
  /** Every distinct notice once, in first-seen order. */
  notices(): string[]
}

/** One service per planning run, so each notice is said once however many loops repeat it. */
export function createDirectionService(flags?: Partial<DirectionFlags>): DirectionService {
  const resolved = resolveFlags(flags)
  const seen = new Set<string>()
  return {
    flags: resolved,
    resolve(request) {
      const result = resolveDirection(request, resolved)
      for (const notice of result.notices) seen.add(notice)
      return result
    },
    notices: () => [...seen],
  }
}

import { describe, it, expect } from 'vitest'
import {
  boxFaceId,
  extrudeSideFaceId,
  extrudeCapId,
  revolveFaceId,
  filletFaceId,
  chamferFaceId,
  shellInnerFaceId,
  booleanFragmentId,
  patternInstanceId,
  importFaceId,
  healFaceId,
  edgeId,
  seamEdgeId,
  vertexId,
  mintBooleanFragments,
  FragmentTieError,
  compareCentroids,
  EDGE_JOIN,
  EDGE_DISAMB_MARK,
  parseStableId,
} from '../../doc/stable-id'
import type { Vec3 } from '../../geom/geom-service'

// AC #1: ID minting per the spec grammar for BOX faces, boolean-cut fragments,
// and the generic op outputs the per-op origin table enumerates. Every mint is a
// pure function of its inputs -> byte-identical on repeat (no randomness).

describe('stable-id minting (grammar + per-op origin rules)', () => {
  it('mints BOX primitive faces as featureRef:opCode:originTag', () => {
    expect(boxFaceId('F1', 'zmax')).toBe('F1:BOX:zmax')
    expect(boxFaceId('F1', 'xmin')).toBe('F1:BOX:xmin')
  })

  it('mints extrude side faces and caps per the spec examples', () => {
    expect(extrudeSideFaceId('F12', 'S3.e7')).toBe('F12:XTR:S3.e7:side')
    expect(extrudeCapId('F12', 1)).toBe('F12:XTR:cap1')
    expect(extrudeCapId('F12', 0)).toBe('F12:XTR:cap0')
  })

  it('mints revolve / shell / pattern / import / heal ids', () => {
    expect(revolveFaceId('F14', 'S3.e2')).toBe('F14:REV:S3.e2:surf')
    expect(shellInnerFaceId('F22', 'F1:BOX:zmax')).toBe('F22:SHL:F1:BOX:zmax:inner')
    expect(patternInstanceId('F9', 3, 'F5:FIL:g0')).toBe('F9:PAT:i3:F5:FIL:g0')
    expect(importFaceId('IMP1', 'step', 42)).toBe('IMP1:step:face#42')
    expect(importFaceId('IMP2', 'stl', 0)).toBe('IMP2:stl:face#0')
    expect(healFaceId('F30', 0)).toBe('F30:DELF:heal#0')
  })

  it('reproduces the spec fillet-on-edge example byte-for-byte', () => {
    // "F20:FIL:(F12:XTR:S3.e7:side<AND>F12:XTR:cap1)"
    const side = extrudeSideFaceId('F12', 'S3.e7')
    const cap = extrudeCapId('F12', 1)
    const eid = edgeId(side, cap)
    // 'S...' sorts before 'c...' so the side face comes first inside the pair.
    expect(eid).toBe(`(F12:XTR:S3.e7:side${EDGE_JOIN}F12:XTR:cap1)`)
    expect(filletFaceId('F20', eid)).toBe(`F20:FIL:(F12:XTR:S3.e7:side${EDGE_JOIN}F12:XTR:cap1)`)
    expect(chamferFaceId('F21', eid)).toBe(`F21:CHM:(F12:XTR:S3.e7:side${EDGE_JOIN}F12:XTR:cap1)`)
  })

  it('boolean fragment id embeds op + parent + #j', () => {
    expect(booleanFragmentId('F16', 'CUT', 'F12:XTR:cap1', 0)).toBe('F16:CUT:F12:XTR:cap1#0')
  })
})

describe('derived edge / vertex ids (unordered, sorted, dedup)', () => {
  it('edge id is order-independent and lexicographically sorted', () => {
    expect(edgeId('A', 'B')).toBe(edgeId('B', 'A'))
    expect(edgeId('B', 'A')).toBe(`(A${EDGE_JOIN}B)`)
  })

  it('seam edge keeps the single adjacent face first', () => {
    expect(seamEdgeId('A', 2)).toBe(`(A${EDGE_JOIN}seam#2)`)
  })

  it('vertex id is the sorted, duplicate-free set of adjacent faces', () => {
    expect(vertexId(['C', 'A', 'B', 'A'])).toBe(`(A${EDGE_JOIN}B${EDGE_JOIN}C)`)
    // Order of the input does not matter.
    expect(vertexId(['B', 'C', 'A'])).toBe(vertexId(['A', 'B', 'C']))
  })
})

describe('deterministic boolean-fragment ordering (centroid, snapped 1e-7)', () => {
  const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
  const UP = at(0, 0, 1)
  // Full valid seed with a distinct shapeKey; every ordering test now supplies
  // the required centroid/area/orientation/shapeKey fields (DOC-1-R2).
  const seed = (
    centroid: Vec3,
    tag: string,
    over: Partial<{ area: number; orientation: Vec3; shapeKey: string }> = {},
  ) => ({ centroid, area: 5, orientation: UP, shapeKey: tag, tag, ...over })

  it('assigns #j by centroid x,y,z lexicographic order, not input order', () => {
    // Hand them over deliberately out of order.
    const frags = [
      seed(at(10, 0, 0), 'east'),
      seed(at(0, 0, 0), 'origin'),
      seed(at(0, 10, 0), 'north'),
    ]
    const { fragments: minted } = mintBooleanFragments('F16', 'CUT', 'F1:BOX:zmax', frags)
    expect(minted.map((m) => m.seed.tag)).toEqual(['origin', 'north', 'east'])
    expect(minted.map((m) => m.id)).toEqual([
      'F16:CUT:F1:BOX:zmax#0',
      'F16:CUT:F1:BOX:zmax#1',
      'F16:CUT:F1:BOX:zmax#2',
    ])
    expect(minted.map((m) => m.index)).toEqual([0, 1, 2])
  })

  it('is invariant to input order (same fragments shuffled -> same ids)', () => {
    const idsOf = (frags: ReturnType<typeof seed>[]) =>
      mintBooleanFragments('F16', 'CUT', 'P', frags).fragments.map(
        (m) => `${m.id}@${m.seed.centroid.x},${m.seed.centroid.y}`,
      )
    const a = idsOf([seed(at(0, 0, 0), 'o'), seed(at(1, 0, 0), 'e'), seed(at(0, 1, 0), 'n')])
    const b = idsOf([seed(at(0, 1, 0), 'n'), seed(at(0, 0, 0), 'o'), seed(at(1, 0, 0), 'e')])
    expect(b).toEqual(a)
  })

  it('coincident-centroid fragments order by GEOMETRY, not caller/input order', () => {
    // Regression for the DOC-1-R1 major: a symmetric split producing two fragments
    // that SHARE a centroid (mirrored slots) must assign #j by a geometric key,
    // never by the order the caller/kernel handed them over. Here the two frags
    // are distinguished only by their mirrored orientation vectors.
    const left = seed(at(0, 0, 0), 'left', { orientation: at(-1, 0, 0) })
    const right = seed(at(0, 0, 0), 'right', { orientation: at(1, 0, 0) })

    const forward = mintBooleanFragments('F16', 'CUT', 'P', [left, right]).fragments
    const reversed = mintBooleanFragments('F16', 'CUT', 'P', [right, left]).fragments

    const idOf = (minted: typeof forward, tag: string) => minted.find((m) => m.seed.tag === tag)!.id
    // Each tagged fragment gets the SAME id regardless of input order (before the
    // fix the tie broke on inputIndex, so 'left' flipped between #0 and #1).
    expect(idOf(forward, 'left')).toBe(idOf(reversed, 'left'))
    expect(idOf(forward, 'right')).toBe(idOf(reversed, 'right'))
    // ...and the two fragments got DISTINCT ids (the tie was actually broken).
    expect(idOf(forward, 'left')).not.toBe(idOf(forward, 'right'))
    // Concretely: the -x-orientation fragment sorts first (#0) in both orders.
    expect(idOf(forward, 'left')).toBe('F16:CUT:P#0')
  })

  it('coincident-centroid + coincident-orientation fragments tie-break by area, not input order', () => {
    // A second coincident-centroid case where orientation also matches but AREA
    // differs (e.g. concentric annular fragments): still fully caller-order-free.
    const small = seed(at(1, 2, 3), 'small', { area: 4 })
    const big = seed(at(1, 2, 3), 'big', { area: 9 })
    const forward = mintBooleanFragments('F7', 'FUS', 'Q', [small, big]).fragments
    const reversed = mintBooleanFragments('F7', 'FUS', 'Q', [big, small]).fragments
    const idOf = (minted: typeof forward, tag: string) => minted.find((m) => m.seed.tag === tag)!.id
    expect(idOf(forward, 'small')).toBe(idOf(reversed, 'small'))
    expect(idOf(forward, 'big')).toBe(idOf(reversed, 'big'))
    expect(idOf(forward, 'small')).toBe('F7:FUS:Q#0') // smaller area sorts first
  })

  it('R2(a): centroid+area+orientation all equal but shapeKey differs -> byte-identical ids both orders', () => {
    // The exact gap the R1 audit flagged: two DISTINCT fragments (e.g. equal-area
    // concentric coplanar annuli) that collide on every scalar key and are told
    // apart ONLY by the canonical shapeKey discriminator. Reversing input must not
    // swap #j, and no tie diagnostic should fire (they are genuinely resolved).
    const inner = seed(at(0, 0, 0), 'inner', { area: 7, orientation: UP, shapeKey: 'annulus:r=1..2' })
    const outer = seed(at(0, 0, 0), 'outer', { area: 7, orientation: UP, shapeKey: 'annulus:r=3..4' })
    const forward = mintBooleanFragments('F9', 'CUT', 'P', [inner, outer])
    const reversed = mintBooleanFragments('F9', 'CUT', 'P', [outer, inner])
    const idOf = (r: typeof forward, tag: string) => r.fragments.find((m) => m.seed.tag === tag)!.id
    expect(idOf(forward, 'inner')).toBe(idOf(reversed, 'inner'))
    expect(idOf(forward, 'outer')).toBe(idOf(reversed, 'outer'))
    expect(idOf(forward, 'inner')).not.toBe(idOf(forward, 'outer'))
    // shapeKey 'annulus:r=1..2' < 'annulus:r=3..4' lexicographically -> inner is #0.
    expect(idOf(forward, 'inner')).toBe('F9:CUT:P#0')
  })

  it('R2(b): a seed missing required discrimination data throws, never falls back to input order', () => {
    // Missing shapeKey (and other required fields) must be a LOUD failure, not a
    // silent centroid-only degrade that would reintroduce the input-order tie.
    const good = seed(at(0, 0, 0), 'good')
    const bad = { centroid: at(1, 0, 0), tag: 'bad' } as unknown as typeof good
    expect(() => mintBooleanFragments('F16', 'CUT', 'P', [good, bad])).toThrow(/missing required/i)
    // Also reject a partial seed that has some but not all fields.
    const partial = { centroid: at(2, 0, 0), area: 5, orientation: UP, tag: 'partial' } as unknown as typeof good
    expect(() => mintBooleanFragments('F16', 'CUT', 'P', [partial])).toThrow(/shapeKey|missing required/i)
  })

  it('BK-6: a whitespace-only shapeKey is rejected as missing discrimination data', () => {
    // A shapeKey of "   " passed the old `.length > 0` check yet carries no real
    // discriminating signal (it would compare equal to any other whitespace-only
    // key). Treated as missing required data, same as an absent shapeKey.
    const whitespace = seed(at(0, 0, 0), 'w', { shapeKey: '   ' })
    expect(() => mintBooleanFragments('F16', 'CUT', 'P', [whitespace])).toThrow(/missing required/i)
    const tabsAndNewline = seed(at(0, 0, 0), 'w2', { shapeKey: '\t\n ' })
    expect(() => mintBooleanFragments('F16', 'CUT', 'P', [tabsAndNewline])).toThrow(/missing required/i)
  })

  it('R3(c): two TRULY identical seeds -> structured REFUSAL (throw + FRAGMENT_TIE_UNRESOLVED diag), mints nothing', () => {
    // Architect ruling (DOC-1-R3): a true full-key tie is a REFUSAL, never an
    // assignment. Two seeds geometrically indistinguishable through the ENTIRE
    // key chain mean degenerate/invalid input (two distinct faces of a valid
    // B-rep solid cannot be full-key identical). mintBooleanFragments must THROW
    // a FragmentTieError carrying the structured diagnostic and mint NOTHING --
    // it must never consult input order to hand out #0/#1.
    const twin = () => seed(at(0, 0, 0), 'twin', { area: 5, orientation: UP, shapeKey: 'identical' })
    expect(() => mintBooleanFragments('F16', 'CUT', 'P', [twin(), twin()])).toThrow(FragmentTieError)
    // The throw carries the structured diagnostic (never string-parse the message).
    let caught: unknown
    try {
      mintBooleanFragments('F16', 'CUT', 'P', [twin(), twin()])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FragmentTieError)
    const diag = (caught as FragmentTieError).diagnostic
    expect(diag.code).toBe('FRAGMENT_TIE_UNRESOLVED')
    expect(diag.severity).toBe('error')
    expect(diag.params.parentFaceId).toBe('P')
    expect(diag.params.op).toBe('CUT')
  })

  it('R3(c-reversed): identical geometry + distinguishable labels -> refuses in BOTH orders (no label-to-id flip possible)', () => {
    // The R2 audit gap: a warn-and-assign implementation would pass a same-order
    // probe yet FLIP label->id when the input array is reversed. Two seeds with
    // identical REQUIRED geometry but distinguishable extra caller labels (tagA
    // vs tagB) must never produce an id for either label -- because minting
    // REFUSES, no order can bias the assignment. We prove the flip is impossible
    // by showing neither order mints anything at all.
    const twin = (label: string) =>
      seed(at(2, 3, 4), label, { area: 8, orientation: UP, shapeKey: 'identical-sig' })
    const a = twin('tagA')
    const b = twin('tagB')
    // Forward order [a, b] refuses.
    expect(() => mintBooleanFragments('F16', 'CUT', 'P', [a, b])).toThrow(FragmentTieError)
    // Reversed order [b, a] also refuses -- there is no order in which a label
    // wins an id, so no label-to-id flip can exist.
    expect(() => mintBooleanFragments('F16', 'CUT', 'P', [b, a])).toThrow(FragmentTieError)
  })

  it('R3(deg): degenerate seeds throw -- zero-length orientation, zero area, negative area', () => {
    // assertSeed hardening (DOC-1-R3): a FINITE-but-meaningless field (zero-length
    // orientation, non-positive area) slips past the finiteness check yet poisons
    // the comparator chain. It is invalid input and must fail loud BEFORE any
    // ordering happens.
    const ZERO = at(0, 0, 0)
    // Zero-length orientation vector.
    expect(() =>
      mintBooleanFragments('F16', 'CUT', 'P', [seed(at(0, 0, 0), 'z', { orientation: ZERO })]),
    ).toThrow(/zero-length orientation/i)
    // Zero area.
    expect(() =>
      mintBooleanFragments('F16', 'CUT', 'P', [seed(at(0, 0, 0), 'z', { area: 0 })]),
    ).toThrow(/non-positive area/i)
    // Negative area.
    expect(() =>
      mintBooleanFragments('F16', 'CUT', 'P', [seed(at(0, 0, 0), 'z', { area: -3 })]),
    ).toThrow(/non-positive area/i)
  })

  it('sub-1e-7 wobble (same grid cell) does not flip the ordering', () => {
    // 1e-8 snaps into the same 1e-7 grid cell as 0 -> equal; 2e-7 is a full two
    // cells away -> ordered. (Grid snapping resolves sub-tolerance noise.)
    expect(compareCentroids({ x: 0, y: 0, z: 0 }, { x: 1e-8, y: 0, z: 0 })).toBe(0)
    expect(compareCentroids({ x: 0, y: 0, z: 0 }, { x: 2e-7, y: 0, z: 0 })).toBe(-1)
  })
})

// UI-H2 (BK-56): parseStableId is the ONE grammar-aware parser every UI-side
// consumer must go through instead of hand-splitting id strings. Coverage
// below walks every production named in docs/stable-id-spec.md's Grammar
// section: plain featureRef, every opCode's originTag shape (including the
// FIL/CHM "band form" that embeds a whole nested edge id), edge pairs,
// seam edges, the orphan seam edge, vertex ids (>2 operands), PAT:merge
// overlap faces, and -- the actual BK-56 defect scenario -- nesting DEPTH
// (an edge/vertex/PAT:merge whose operand is itself a parenthesized id).
describe('parseStableId (grammar-aware, depth-aware -- BK-56)', () => {
  describe('plain featureRef / opCode segment chains (no nesting)', () => {
    it('a bare featureRef parses as a single segment with no opCode', () => {
      const parsed = parseStableId('F12')
      expect(parsed).toEqual({ kind: 'segments', segments: ['F12'], featureId: 'F12', opCode: undefined })
    })

    it('BOX / XTR side / XTR cap / REV / SHL / DELF heal all round-trip through segments', () => {
      const ids = [
        boxFaceId('F1', 'zmax'),
        extrudeSideFaceId('F12', 'S3.e7'),
        extrudeCapId('F12', 1),
        revolveFaceId('F14', 'S3.e2'),
        shellInnerFaceId('F22', 'F1:BOX:zmax'),
        healFaceId('F30', 0),
        importFaceId('IMP1', 'step', 42),
        importFaceId('IMP2', 'stl', 0),
      ]
      for (const id of ids) {
        const parsed = parseStableId(id)
        if (parsed.kind !== 'segments') throw new Error(`expected segments, got ${parsed.kind}`)
        // Depth-aware split is lossless when there's no nesting: rejoining on
        // ':' must reproduce the id byte-for-byte.
        expect(parsed.segments.join(':')).toBe(id)
        expect(parsed.featureId).toBe(id.split(':')[0])
      }
    })

    it('extracts opCode as segment[1] for every opCode-bearing id', () => {
      const opCodeOf = (id: string): string | undefined => {
        const parsed = parseStableId(id)
        return parsed.kind === 'segments' ? parsed.opCode : undefined
      }
      expect(opCodeOf(boxFaceId('F1', 'zmax'))).toBe('BOX')
      expect(opCodeOf(extrudeSideFaceId('F12', 'S3.e7'))).toBe('XTR')
      expect(opCodeOf(revolveFaceId('F14', 'S3.e2'))).toBe('REV')
      expect(opCodeOf(shellInnerFaceId('F22', 'F1:BOX:zmax'))).toBe('SHL')
      expect(opCodeOf(healFaceId('F30', 0))).toBe('DELF')
      expect(opCodeOf(importFaceId('IMP1', 'step', 42))).toBe('step')
      expect(opCodeOf(patternInstanceId('F9', 3, 'F5:FIL:g0'))).toBe('PAT')
      expect(opCodeOf(booleanFragmentId('F16', 'CUT', 'F12:XTR:cap1', 0))).toBe('CUT')
    })

    it('ALL-20 table: one row per opCode literal in docs/stable-id-spec.md:12-13, no exceptions (WO UI-H2-R2)', () => {
      // R2 rework (WO UI-H2-R2, second bounce): the R1 table here only
      // covered the 8 literals R1 itself had missed (SWP/LFT/FUS/INT/MIR/
      // DFT/HOL/OFS), scattered against BOX/XTR/REV/FIL/CHM/SHL/CUT/PAT/
      // DELF/step/stl asserted piecemeal in the tests above, and left MVF
      // uncovered entirely (report-only, per the R1 audit). This is the ONE
      // table the R2 order requires: EXACTLY the 20 opCode literals named in
      // docs/stable-id-spec.md:12-13, each with a single realistic id shape,
      // asserted in one pass -- INCLUDING a literal MVF shape (auditor
      // suggestion, coordination/reports/UI-H2-R1.audit.json) and the
      // step/stl import shapes.
      //
      // Real mint helpers are used wherever stable-id.ts has one (BOX, XTR,
      // REV, FIL, CHM, SHL, CUT, FUS, INT, PAT, DELF, step, stl). The
      // remaining 7 -- SWP, LFT, MIR, DFT, HOL, OFS, MVF -- have no mint
      // helper and no worked example in the spec's Per-op origin rules
      // table (MVF's row only says the MOVED face keeps its EXISTING id;
      // "MVF" is never itself a literal opCode segment of a persisted id in
      // practice). Their shapes below are constructed BY ANALOGY to the
      // sibling shape the spec DOES define, documented per-row. This proves
      // the parser's generic ':'-split path (no opCode string is
      // special-cased except the PAT+'merge' pair) accepts every one of the
      // 20 grammar alternatives -- not that these 7 are byte-identical to
      // some future real minter. If a future minter never actually emits a
      // literal "MVF" segment, that is a spec/grammar note, not a parser
      // defect: the parser must still accept the shape the grammar allows.
      const filEdge = edgeId(extrudeSideFaceId('F12', 'S3.e7'), extrudeCapId('F12', 1))
      const chmEdge = edgeId(extrudeCapId('F9', 0), extrudeCapId('F9', 1))
      const cases: Array<{ opCode: string; id: string }> = [
        { opCode: 'BOX', id: boxFaceId('F1', 'zmax') },
        { opCode: 'XTR', id: extrudeSideFaceId('F12', 'S3.e7') },
        { opCode: 'REV', id: revolveFaceId('F14', 'S3.e2') },
        // Sweep: profile-edge side face swept along a path -- same shape as
        // XTR's side face (F:XTR:<sketchEntityId>:side). No mint helper.
        { opCode: 'SWP', id: 'F15:SWP:S3.e7:side' },
        // Loft: section face between profiles -- same shape as REV's surface.
        { opCode: 'LFT', id: 'F16:LFT:S3.e2:surf' },
        { opCode: 'FIL', id: filletFaceId('F20', filEdge) },
        { opCode: 'CHM', id: chamferFaceId('F21', chmEdge) },
        { opCode: 'SHL', id: shellInnerFaceId('F22', 'F1:BOX:zmax') },
        { opCode: 'CUT', id: booleanFragmentId('F16', 'CUT', 'F12:XTR:cap1', 0) },
        // Boolean fuse / intersect: real booleanFragmentId minter (BooleanOp
        // = 'CUT' | 'FUS' | 'INT') -- only 'CUT' is exercised elsewhere.
        { opCode: 'FUS', id: booleanFragmentId('F17', 'FUS', 'F1:BOX:zmax', 0) },
        { opCode: 'INT', id: booleanFragmentId('F18', 'INT', 'F1:BOX:zmax', 0) },
        { opCode: 'PAT', id: patternInstanceId('F9', 3, 'F5:FIL:g0') },
        // Mirror: mirrored copy of a source face -- SHL's "<faceId>:<tag>" shape.
        { opCode: 'MIR', id: 'F19:MIR:F1:BOX:zmax:mirror' },
        // Draft: drafted (angle-modified) copy of a source face, same shape.
        { opCode: 'DFT', id: 'F25:DFT:F1:BOX:xmin:drafted' },
        // Hole: wall face of a simple-hole feature, instance-tagged like PAT.
        { opCode: 'HOL', id: 'F26:HOL:i0:wall' },
        // Direct edit / move-face: spec line 32 says the MOVED face keeps its
        // id and MVF only records the event in lineage -- but the grammar
        // (spec line 12-13) still lists MVF as a legal opCode segment, so the
        // parser must accept a literal MVF id shape (e.g. a lineage-delta
        // record naming the affected face by its own per-op id).
        { opCode: 'MVF', id: 'F23:MVF:F1:BOX:zmax' },
        // Offset: offset copy of a source face -- same shape as SHL.
        { opCode: 'OFS', id: 'F22:OFS:F1:BOX:zmax:offset' },
        { opCode: 'DELF', id: healFaceId('F30', 0) },
        { opCode: 'step', id: importFaceId('IMP1', 'step', 42) },
        { opCode: 'stl', id: importFaceId('IMP2', 'stl', 0) },
      ]
      // Guard the table itself: exactly 20 rows, each opCode literal distinct
      // (so a future accidental duplicate-and-forget-one is caught here, not
      // silently passed off as "all 20 covered").
      expect(cases.length).toBe(20)
      expect(new Set(cases.map((c) => c.opCode)).size).toBe(20)
      for (const { opCode, id } of cases) {
        const parsed = parseStableId(id)
        expect(parsed.kind).toBe('segments')
        if (parsed.kind !== 'segments') throw new Error('unreachable')
        expect(parsed.opCode).toBe(opCode)
        expect(parsed.featureId).toBe(id.split(':')[0])
        // Depth-aware split is lossless: rejoining on ':' reproduces the id
        // byte-for-byte, including the FIL/CHM band forms whose originTag
        // embeds a whole nested edge id.
        expect(parsed.segments.join(':')).toBe(id)
      }
    })
  })

  describe('edge pair extraction (a, b, seam#) -- no nesting', () => {
    it('parses a normal 2-face edge id into its sorted operand pair', () => {
      const side = extrudeSideFaceId('F12', 'S3.e7')
      const cap = extrudeCapId('F12', 1)
      const eid = edgeId(side, cap)
      const parsed = parseStableId(eid)
      expect(parsed.kind).toBe('edge')
      if (parsed.kind !== 'edge') throw new Error('unreachable')
      expect(parsed.operands).toEqual([
        { raw: side, isSeam: false, isOrphan: false }, // 'S...' sorts before 'F12:XTR:cap1'
        { raw: cap, isSeam: false, isOrphan: false },
      ])
    })

    it('parses a seam edge -- second operand flagged isSeam', () => {
      const faceA = 'F1:BOX:zmax'
      const seam = seamEdgeId(faceA, 2)
      const parsed = parseStableId(seam)
      expect(parsed.kind).toBe('edge')
      if (parsed.kind !== 'edge') throw new Error('unreachable')
      expect(parsed.operands).toEqual([
        { raw: faceA, isSeam: false, isOrphan: false },
        { raw: 'seam#2', isSeam: true, isOrphan: false },
      ])
    })

    it('parses the orphan seam edge (no real face named)', () => {
      const orphan = `(orphan${EDGE_JOIN}seam#0)`
      const parsed = parseStableId(orphan)
      expect(parsed.kind).toBe('edge')
      if (parsed.kind !== 'edge') throw new Error('unreachable')
      expect(parsed.operands[0]).toEqual({ raw: 'orphan', isSeam: false, isOrphan: true })
      expect(parsed.operands[1]).toEqual({ raw: 'seam#0', isSeam: true, isOrphan: false })
    })

    it('vertex ids (>2 operands, sorted set) parse with one operand per adjacent face', () => {
      const vid = vertexId(['C', 'A', 'B', 'A'])
      const parsed = parseStableId(vid)
      expect(parsed.kind).toBe('edge')
      if (parsed.kind !== 'edge') throw new Error('unreachable')
      expect(parsed.operands.map((o) => o.raw)).toEqual(['A', 'B', 'C'])
      expect(parsed.operands.every((o) => !o.isSeam && !o.isOrphan)).toBe(true)
    })
  })

  // GEO-16 (ICR-3 step 2): a two-face edge id may carry a trailing `@<token>`
  // geometric disambiguator OUTSIDE the closing paren -- `(A^B)@m..._l...`. The
  // parser must strip and expose it while leaving the two FACE operands
  // unchanged, so every existing consumer (edgesOfFace, measure length !== 2,
  // visibility) reads the same A and B whether or not a disambiguator is present.
  describe('GEO-16 disambiguated two-face edge (@token)', () => {
    const A = 'F1:XTR:S1.c0:side'
    const B = 'F1:XTR:new#0'
    const bare = edgeId(A, B) // sorted `(A^B)`
    const token = 'm10_20_30_l50'
    const disamb = `${bare}${EDGE_DISAMB_MARK}${token}`

    it('exposes the disambiguator and keeps the SAME two face operands as the bare form', () => {
      const parsed = parseStableId(disamb)
      expect(parsed.kind).toBe('edge')
      if (parsed.kind !== 'edge') throw new Error('unreachable')
      expect(parsed.disambiguator).toBe(token)
      // operands identical to the bare id -> face-reading consumers unaffected.
      const bareParsed = parseStableId(bare)
      if (bareParsed.kind !== 'edge') throw new Error('unreachable')
      expect(parsed.operands).toEqual(bareParsed.operands)
      expect(parsed.operands.length).toBe(2)
      expect(parsed.operands.some((o) => o.raw === A)).toBe(true)
      expect(parsed.operands.some((o) => o.raw === B)).toBe(true)
    })

    it('a bare edge id has an undefined disambiguator (byte-identical common case)', () => {
      const parsed = parseStableId(bare)
      if (parsed.kind !== 'edge') throw new Error('unreachable')
      expect(parsed.disambiguator).toBeUndefined()
    })

    it('a FIL band face embedding a disambiguated edge splits at the top level, edge recovered by recursion', () => {
      const band = `F9:FIL:${disamb}`
      const parsed = parseStableId(band)
      expect(parsed.kind).toBe('segments')
      if (parsed.kind !== 'segments') throw new Error('unreachable')
      expect(parsed.featureId).toBe('F9')
      expect(parsed.opCode).toBe('FIL')
      // the embedded edge id (with its @token) survives as ONE segment...
      expect(parsed.segments[2]).toBe(disamb)
      // ...and recursing recovers the edge + its disambiguator.
      const inner = parseStableId(parsed.segments[2])
      if (inner.kind !== 'edge') throw new Error('unreachable')
      expect(inner.disambiguator).toBe(token)
      expect(inner.operands.length).toBe(2)
    })
  })

  describe('band forms + nesting depth (the BK-56 defect scenario)', () => {
    it('a FIL band face keeps its embedded edge id as ONE verbatim segment, not torn apart', () => {
      const side = extrudeSideFaceId('F12', 'S3.e7')
      const cap = extrudeCapId('F12', 1)
      const innerEdge = edgeId(side, cap)
      const band = filletFaceId('F20', innerEdge)
      const parsed = parseStableId(band)
      expect(parsed.kind).toBe('segments')
      if (parsed.kind !== 'segments') throw new Error('unreachable')
      expect(parsed.featureId).toBe('F20')
      expect(parsed.opCode).toBe('FIL')
      // The 3rd segment is the whole embedded edge id, untouched.
      expect(parsed.segments).toEqual(['F20', 'FIL', innerEdge])
      // ...and it's a valid stableId one recursive call away.
      const innerParsed = parseStableId(parsed.segments[2])
      expect(innerParsed.kind).toBe('edge')
      if (innerParsed.kind !== 'edge') throw new Error('unreachable')
      expect(innerParsed.operands.map((o) => o.raw)).toEqual([side, cap])
    })

    it('CHM band form parses the same way as FIL', () => {
      const innerEdge = edgeId(extrudeCapId('F9', 0), extrudeCapId('F9', 1))
      const band = chamferFaceId('F21', innerEdge)
      const parsed = parseStableId(band)
      if (parsed.kind !== 'segments') throw new Error('unreachable')
      expect(parsed.opCode).toBe('CHM')
      expect(parsed.segments[2]).toBe(innerEdge)
    })

    it('BK-56 core case: an edge between a band face and a plain face extracts BOTH operands intact despite the nested join', () => {
      // This is exactly geometryVisibility.ts's live defect scenario: the pre-WO
      // deriveHiddenEdgeIds did `edgeId.slice(1,-1).split(EDGE_JOIN)` and required
      // EXACTLY 2 parts. This outer edge id contains the join char TWICE (once at
      // the top level, once nested inside the band operand) so the naive split
      // produced 3 parts and was silently dropped.
      const innerEdge = edgeId('F1:BOX:face#0', 'F1:BOX:face#1')
      const band = filletFaceId('F20', innerEdge)
      const plainFace = 'F1:BOX:face#2'
      const outerEdge = edgeId(band, plainFace)
      const parsed = parseStableId(outerEdge)
      expect(parsed.kind).toBe('edge')
      if (parsed.kind !== 'edge') throw new Error('unreachable')
      expect(parsed.operands.length).toBe(2)
      expect(parsed.operands.map((o) => o.raw).sort()).toEqual([band, plainFace].sort())
    })

    it('BK-56 double-nested case: an edge between TWO band faces (join nested on both sides) still extracts exactly 2 operands', () => {
      const bandA = filletFaceId('F20', edgeId('F1:BOX:face#0', 'F1:BOX:face#1'))
      const bandB = chamferFaceId('F21', edgeId('F1:BOX:face#2', 'F1:BOX:face#3'))
      const outerEdge = edgeId(bandA, bandB)
      const parsed = parseStableId(outerEdge)
      expect(parsed.kind).toBe('edge')
      if (parsed.kind !== 'edge') throw new Error('unreachable')
      expect(parsed.operands.map((o) => o.raw).sort()).toEqual([bandA, bandB].sort())
    })
  })

  describe('PAT:merge overlap-face form', () => {
    it('parses the spec example byte-for-byte', () => {
      const id = 'PO:PAT:merge:(i0:F1:BOX:yMin|i1:F1:BOX:yMin)'
      const parsed = parseStableId(id)
      expect(parsed.kind).toBe('segments')
      if (parsed.kind !== 'segments') throw new Error('unreachable')
      expect(parsed.featureId).toBe('PO')
      expect(parsed.opCode).toBe('PAT')
      expect(parsed.patternMerge).toEqual([
        { instance: 'i0', childId: 'F1:BOX:yMin' },
        { instance: 'i1', childId: 'F1:BOX:yMin' },
      ])
    })

    it('a merge member whose childId is itself a nested band id is not corrupted by the "|" split', () => {
      const nestedChild = filletFaceId('F20', edgeId('F1:BOX:face#0', 'F1:BOX:face#1'))
      const id = `PO:PAT:merge:(i0:${nestedChild}|i1:F2:BOX:yMax)`
      const parsed = parseStableId(id)
      if (parsed.kind !== 'segments') throw new Error('unreachable')
      expect(parsed.patternMerge).toEqual([
        { instance: 'i0', childId: nestedChild },
        { instance: 'i1', childId: 'F2:BOX:yMax' },
      ])
    })

    it('an ordinary (non-merge) PAT instance id has no patternMerge field', () => {
      const id = patternInstanceId('F9', 3, 'F5:FIL:g0')
      const parsed = parseStableId(id)
      if (parsed.kind !== 'segments') throw new Error('unreachable')
      expect(parsed.patternMerge).toBeUndefined()
    })
  })

  describe('round-trip invariant', () => {
    it('segments.join(":") always reproduces the original id, nested or not', () => {
      const ids = [
        'F12',
        boxFaceId('F1', 'zmax'),
        filletFaceId('F20', edgeId('F1:BOX:face#0', 'F1:BOX:face#1')),
        'PO:PAT:merge:(i0:F1:BOX:yMin|i1:F1:BOX:yMin)',
      ]
      for (const id of ids) {
        const parsed = parseStableId(id)
        if (parsed.kind !== 'segments') throw new Error('unreachable')
        expect(parsed.segments.join(':')).toBe(id)
      }
    })

    it('"(" + operands.join(EDGE_JOIN) + ")" always reproduces the original edge/vertex id', () => {
      const ids = [
        edgeId('A', 'B'),
        seamEdgeId('A', 2),
        `(orphan${EDGE_JOIN}seam#0)`,
        vertexId(['C', 'A', 'B']),
        edgeId(filletFaceId('F20', edgeId('F1:BOX:face#0', 'F1:BOX:face#1')), 'F1:BOX:face#2'),
      ]
      for (const id of ids) {
        const parsed = parseStableId(id)
        if (parsed.kind !== 'edge') throw new Error('unreachable')
        expect(`(${parsed.operands.map((o) => o.raw).join(EDGE_JOIN)})`).toBe(id)
      }
    })
  })
})

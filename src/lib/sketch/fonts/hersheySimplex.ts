// Hershey "futural" (Sans 1-stroke) single-line vector font -- PUBLIC DOMAIN.
//
// SOURCE: The Hershey fonts were digitized by Dr. A. V. Hershey at the US
// Naval Weapons Laboratory and released by the US National Bureau of
// Standards (NIST) -- they are PUBLIC DOMAIN (no copyright; the only NIST
// usage note is an acknowledgement request, not a license restriction).
// The glyph table below is the "futural" face (a.k.a. "Hershey Sans
// 1-stroke") extracted verbatim from the hersheytextjs dataset
// (github.com/techninja/hersheytextjs, MIT-licensed packaging of the
// public-domain Hershey data), itself sourced from the Evil Mad Scientist
// Hershey Text Inkscape extension.
//
// COVERAGE: FULL printable ASCII, code points 33 ('!') through 126 ('~') --
// uppercase A-Z, lowercase a-z, digits 0-9, and every common punctuation
// mark. Space (32) carries no strokes (advance only). An entry for 127
// (a filled box) doubles as the "tofu" fallback for unsupported code points.
//
// COORDINATE SPACE (raw Hershey units, as stored): x increases RIGHT, y
// increases DOWN. The cap line is at y=1 and the BASELINE is at y=22, so the
// cap height is 21 units; descenders run below the baseline (to ~29). Each
// glyph's nominal advance width is the first tuple element (`o`); the
// reference renderer multiplies it by 1.68 to space glyphs, which this font
// preserves as HERSHEY_ADVANCE_SCALE. text.ts flips Y, scales by the
// requested cap height, and lays glyphs out left-to-right.
//
// Single-stroke (centerline) glyphs are exactly what an ENGRAVE op wants:
// each stroke bakes to an OPEN polyline the tool traces with its tip. A
// later Part B adds OUTLINE/TTF fonts (closed contours) under fontStyle.

import type { Vec2 } from '../../../types'

/** Baseline y in raw Hershey units (cap letters sit here). */
export const HERSHEY_BASELINE = 22
/** Cap height in raw Hershey units (baseline y=22 minus cap-line y=1). */
export const HERSHEY_CAP_HEIGHT = 21
/** Horizontal advance multiplier the reference renderer applies to `o`. */
export const HERSHEY_ADVANCE_SCALE = 1.68
/** Nominal advance (raw `o` units) for a space; advances, draws nothing. */
export const HERSHEY_SPACE_ADVANCE = 10
/** ASCII code of the first table entry. */
const FIRST_CODE = 33

// [advance(o), pathData] indexed by (charCode - 33). Path mini-language:
// "M x,y" starts a new stroke (pen up + move), "L x,y" / bare "x,y" extend
// the current stroke (pen down). Coordinates are raw Hershey units.
const GLYPHS: ReadonlyArray<readonly [number, string]> = [
  [5, 'M5,1 L5,15 M5,20 L4,21 5,22 6,21 5,20'], // 33 !
  [8, 'M4,1 L4,8 M12,1 L12,8'], // 34 "
  [11, 'M11,-3 L4,29 M17,-3 L10,29 M4,10 L18,10 M3,16 L17,16'], // 35 #
  [10, 'M8,-3 L8,26 M12,-3 L12,26 M17,4 L15,2 12,1 8,1 5,2 3,4 3,6 4,8 5,9 7,10 13,12 15,13 16,14 17,16 17,19 15,21 12,22 8,22 5,21 3,19'], // 36 $
  [12, 'M21,1 L3,22 M8,1 L10,3 10,5 9,7 7,8 5,8 3,6 3,4 4,2 6,1 8,1 10,2 13,3 16,3 19,2 21,1 M17,15 L15,16 14,18 14,20 16,22 18,22 20,21 21,19 21,17 19,15 17,15'], // 37 %
  [13, 'M23,10 L23,9 22,8 21,8 20,9 19,11 17,16 15,19 13,21 11,22 7,22 5,21 4,20 3,18 3,16 4,14 5,13 12,9 13,8 14,6 14,4 13,2 11,1 9,2 8,4 8,6 9,9 11,12 16,19 18,21 20,22 22,22 23,21 23,20'], // 38 &
  [5, 'M5,3 L4,2 5,1 6,2 6,4 5,6 4,7'], // 39 apostrophe
  [7, 'M11,-3 L9,-1 7,2 5,6 4,11 4,15 5,20 7,24 9,27 11,29'], // 40 (
  [7, 'M3,-3 L5,-1 7,2 9,6 10,11 10,15 9,20 7,24 5,27 3,29'], // 41 )
  [8, 'M8,7 L8,19 M3,10 L13,16 M13,10 L3,16'], // 42 *
  [13, 'M13,4 L13,22 M4,13 L22,13'], // 43 +
  [4, 'M5,18 L4,19 3,18 4,17 5,18 5,20 3,22'], // 44 ,
  [13, 'M4,13 L22,13'], // 45 -
  [4, 'M4,17 L3,18 4,19 5,18 4,17'], // 46 .
  [11, 'M20,-3 L2,29'], // 47 /
  [10, 'M9,1 L6,2 4,5 3,10 3,13 4,18 6,21 9,22 11,22 14,21 16,18 17,13 17,10 16,5 14,2 11,1 9,1'], // 48 0
  [10, 'M6,5 L8,4 11,1 11,22'], // 49 1
  [10, 'M4,6 L4,5 5,3 6,2 8,1 12,1 14,2 15,3 16,5 16,7 15,9 13,12 3,22 17,22'], // 50 2
  [10, 'M5,1 L16,1 10,9 13,9 15,10 16,11 17,14 17,16 16,19 14,21 11,22 8,22 5,21 4,20 3,18'], // 51 3
  [10, 'M13,1 L3,15 18,15 M13,1 L13,22'], // 52 4
  [10, 'M15,1 L5,1 4,10 5,9 8,8 11,8 14,9 16,11 17,14 17,16 16,19 14,21 11,22 8,22 5,21 4,20 3,18'], // 53 5
  [10, 'M16,4 L15,2 12,1 10,1 7,2 5,5 4,10 4,15 5,19 7,21 10,22 11,22 14,21 16,19 17,16 17,15 16,12 14,10 11,9 10,9 7,10 5,12 4,15'], // 54 6
  [10, 'M17,1 L7,22 M3,1 L17,1'], // 55 7
  [10, 'M8,1 L5,2 4,4 4,6 5,8 7,9 11,10 14,11 16,13 17,15 17,18 16,20 15,21 12,22 8,22 5,21 4,20 3,18 3,15 4,13 6,11 9,10 13,9 15,8 16,6 16,4 15,2 12,1 8,1'], // 56 8
  [10, 'M16,8 L15,11 13,13 10,14 9,14 6,13 4,11 3,8 3,7 4,4 6,2 9,1 10,1 13,2 15,4 16,8 16,13 15,18 13,21 10,22 8,22 5,21 4,19'], // 57 9
  [4, 'M4,10 L3,11 4,12 5,11 4,10 M4,17 L3,18 4,19 5,18 4,17'], // 58 :
  [4, 'M4,10 L3,11 4,12 5,11 4,10 M5,18 L4,19 3,18 4,17 5,18 5,20 3,22'], // 59 ;
  [12, 'M20,4 L4,13 20,22'], // 60 <
  [13, 'M4,10 L22,10 M4,16 L22,16'], // 61 =
  [12, 'M4,4 L20,13 4,22'], // 62 >
  [9, 'M3,6 L3,5 4,3 5,2 7,1 11,1 13,2 14,3 15,5 15,7 14,9 13,10 9,12 9,15 M9,20 L8,21 9,22 10,21 9,20'], // 63 ?
  [14, 'M18,9 L17,7 15,6 12,6 10,7 9,8 8,11 8,14 9,16 11,17 14,17 16,16 17,14 M12,6 L10,8 9,11 9,14 10,16 11,17 M18,6 L17,14 17,16 19,17 21,17 23,15 24,12 24,10 23,7 22,5 20,3 18,2 15,1 12,1 9,2 7,3 5,5 4,7 3,10 3,13 4,16 5,18 7,20 9,21 12,22 15,22 18,21 20,20 21,19 M19,6 L18,14 18,16 19,17'], // 64 @
  [9, 'M9,1 L1,22 M9,1 L17,22 M4,15 L14,15'], // 65 A
  [10, 'M4,1 L4,22 M4,1 L13,1 16,2 17,3 18,5 18,7 17,9 16,10 13,11 M4,11 L13,11 16,12 17,13 18,15 18,18 17,20 16,21 13,22 4,22'], // 66 B
  [11, 'M18,6 L17,4 15,2 13,1 9,1 7,2 5,4 4,6 3,9 3,14 4,17 5,19 7,21 9,22 13,22 15,21 17,19 18,17'], // 67 C
  [10, 'M4,1 L4,22 M4,1 L11,1 14,2 16,4 17,6 18,9 18,14 17,17 16,19 14,21 11,22 4,22'], // 68 D
  [9, 'M4,1 L4,22 M4,1 L17,1 M4,11 L12,11 M4,22 L17,22'], // 69 E
  [8, 'M4,1 L4,22 M4,1 L17,1 M4,11 L12,11'], // 70 F
  [11, 'M18,6 L17,4 15,2 13,1 9,1 7,2 5,4 4,6 3,9 3,14 4,17 5,19 7,21 9,22 13,22 15,21 17,19 18,17 18,14 M13,14 L18,14'], // 71 G
  [11, 'M4,1 L4,22 M18,1 L18,22 M4,11 L18,11'], // 72 H
  [4, 'M4,1 L4,22'], // 73 I
  [8, 'M12,1 L12,17 11,20 10,21 8,22 6,22 4,21 3,20 2,17 2,15'], // 74 J
  [10, 'M4,1 L4,22 M18,1 L4,15 M9,10 L18,22'], // 75 K
  [7, 'M4,1 L4,22 M4,22 L16,22'], // 76 L
  [12, 'M4,1 L4,22 M4,1 L12,22 M20,1 L12,22 M20,1 L20,22'], // 77 M
  [11, 'M4,1 L4,22 M4,1 L18,22 M18,1 L18,22'], // 78 N
  [11, 'M9,1 L7,2 5,4 4,6 3,9 3,14 4,17 5,19 7,21 9,22 13,22 15,21 17,19 18,17 19,14 19,9 18,6 17,4 15,2 13,1 9,1'], // 79 O
  [10, 'M4,1 L4,22 M4,1 L13,1 16,2 17,3 18,5 18,8 17,10 16,11 13,12 4,12'], // 80 P
  [11, 'M9,1 L7,2 5,4 4,6 3,9 3,14 4,17 5,19 7,21 9,22 13,22 15,21 17,19 18,17 19,14 19,9 18,6 17,4 15,2 13,1 9,1 M12,18 L18,24'], // 81 Q
  [10, 'M4,1 L4,22 M4,1 L13,1 16,2 17,3 18,5 18,7 17,9 16,10 13,11 4,11 M11,11 L18,22'], // 82 R
  [10, 'M17,4 L15,2 12,1 8,1 5,2 3,4 3,6 4,8 5,9 7,10 13,12 15,13 16,14 17,16 17,19 15,21 12,22 8,22 5,21 3,19'], // 83 S
  [8, 'M8,1 L8,22 M1,1 L15,1'], // 84 T
  [11, 'M4,1 L4,16 5,19 7,21 10,22 12,22 15,21 17,19 18,16 18,1'], // 85 U
  [9, 'M1,1 L9,22 M17,1 L9,22'], // 86 V
  [12, 'M2,1 L7,22 M12,1 L7,22 M12,1 L17,22 M22,1 L17,22'], // 87 W
  [10, 'M3,1 L17,22 M17,1 L3,22'], // 88 X
  [9, 'M1,1 L9,11 9,22 M17,1 L9,11'], // 89 Y
  [10, 'M17,1 L3,22 M3,1 L17,1 M3,22 L17,22'], // 90 Z
  [7, 'M4,-3 L4,29 M5,-3 L5,29 M4,-3 L11,-3 M4,29 L11,29'], // 91 [
  [7, 'M0,1 L14,25'], // 92 backslash
  [7, 'M9,-3 L9,29 M10,-3 L10,29 M3,-3 L10,-3 M3,29 L10,29'], // 93 ]
  [8, 'M8,-1 L0,13 M8,-1 L16,13'], // 94 ^
  [9, 'M0,29 L18,29'], // 95 _
  [4, 'M5,6 L3,8 3,10 4,11 5,10 4,9 3,10'], // 96 `
  [10, 'M15,8 L15,22 M15,11 L13,9 11,8 8,8 6,9 4,11 3,14 3,16 4,19 6,21 8,22 11,22 13,21 15,19'], // 97 a
  [9, 'M4,1 L4,22 M4,11 L6,9 8,8 11,8 13,9 15,11 16,14 16,16 15,19 13,21 11,22 8,22 6,21 4,19'], // 98 b
  [9, 'M15,11 L13,9 11,8 8,8 6,9 4,11 3,14 3,16 4,19 6,21 8,22 11,22 13,21 15,19'], // 99 c
  [10, 'M15,1 L15,22 M15,11 L13,9 11,8 8,8 6,9 4,11 3,14 3,16 4,19 6,21 8,22 11,22 13,21 15,19'], // 100 d
  [9, 'M3,14 L15,14 15,12 14,10 13,9 11,8 8,8 6,9 4,11 3,14 3,16 4,19 6,21 8,22 11,22 13,21 15,19'], // 101 e
  [7, 'M10,1 L8,1 6,2 5,5 5,22 M2,8 L9,8'], // 102 f
  [10, 'M15,8 L15,24 14,27 13,28 11,29 8,29 6,28 M15,11 L13,9 11,8 8,8 6,9 4,11 3,14 3,16 4,19 6,21 8,22 11,22 13,21 15,19'], // 103 g
  [10, 'M4,1 L4,22 M4,12 L7,9 9,8 12,8 14,9 15,12 15,22'], // 104 h
  [4, 'M3,1 L4,2 5,1 4,0 3,1 M4,8 L4,22'], // 105 i
  [5, 'M5,1 L6,2 7,1 6,0 5,1 M6,8 L6,25 5,28 3,29 1,29'], // 106 j
  [8, 'M4,1 L4,22 M14,8 L4,18 M8,14 L15,22'], // 107 k
  [4, 'M4,1 L4,22'], // 108 l
  [15, 'M4,8 L4,22 M4,12 L7,9 9,8 12,8 14,9 15,12 15,22 M15,12 L18,9 20,8 23,8 25,9 26,12 26,22'], // 109 m
  [10, 'M4,8 L4,22 M4,12 L7,9 9,8 12,8 14,9 15,12 15,22'], // 110 n
  [10, 'M8,8 L6,9 4,11 3,14 3,16 4,19 6,21 8,22 11,22 13,21 15,19 16,16 16,14 15,11 13,9 11,8 8,8'], // 111 o
  [9, 'M4,8 L4,29 M4,11 L6,9 8,8 11,8 13,9 15,11 16,14 16,16 15,19 13,21 11,22 8,22 6,21 4,19'], // 112 p
  [10, 'M15,8 L15,29 M15,11 L13,9 11,8 8,8 6,9 4,11 3,14 3,16 4,19 6,21 8,22 11,22 13,21 15,19'], // 113 q
  [6, 'M4,8 L4,22 M4,14 L5,11 7,9 9,8 12,8'], // 114 r
  [9, 'M14,11 L13,9 10,8 7,8 4,9 3,11 4,13 6,14 11,15 13,16 14,18 14,19 13,21 10,22 7,22 4,21 3,19'], // 115 s
  [7, 'M5,1 L5,18 6,21 8,22 10,22 M2,8 L9,8'], // 116 t
  [10, 'M4,8 L4,18 5,21 7,22 10,22 12,21 15,18 M15,8 L15,22'], // 117 u
  [8, 'M2,8 L8,22 M14,8 L8,22'], // 118 v
  [11, 'M3,8 L7,22 M11,8 L7,22 M11,8 L15,22 M19,8 L15,22'], // 119 w
  [9, 'M3,8 L14,22 M14,8 L3,22'], // 120 x
  [8, 'M2,8 L8,22 M14,8 L8,22 6,26 4,28 2,29 1,29'], // 121 y
  [9, 'M14,8 L3,22 M3,8 L14,8 M3,22 L14,22'], // 122 z
  [7, 'M9,-3 L7,-2 6,-1 5,1 5,3 6,5 7,6 8,8 8,10 6,12 M7,-2 L6,0 6,2 7,4 8,5 9,7 9,9 8,11 4,13 8,15 9,17 9,19 8,21 7,22 6,24 6,26 7,28 M6,14 L8,16 8,18 7,20 6,21 5,23 5,25 6,27 7,28 9,29'], // 123 {
  [4, 'M4,-3 L4,29'], // 124 |
  [7, 'M5,-3 L7,-2 8,-1 9,1 9,3 8,5 7,6 6,8 6,10 8,12 M7,-2 L8,0 8,2 7,4 6,5 5,7 5,9 6,11 10,13 6,15 5,17 5,19 6,21 7,22 8,24 8,26 7,28 M8,14 L6,16 6,18 7,20 8,21 9,23 9,25 8,27 7,28 5,29'], // 125 }
  [12, 'M3,16 L3,14 4,11 6,10 8,10 10,11 14,14 16,15 18,15 20,14 21,12 M3,14 L4,12 6,11 8,11 10,12 14,15 16,16 18,16 20,15 21,12 21,10'], // 126 ~
  [8, 'M0,1 L0,22 1,22 1,1 2,1 2,22 3,22 3,1 4,1 4,22 5,22 5,1 6,1 6,22 7,22 7,1 8,1 8,22 9,22 9,1 10,1 10,22 11,22 11,1 12,1 12,22 13,22 13,1 14,1 14,22 15,22 15,1 16,1 16,22'], // 127 (tofu fallback)
]

/** A decoded glyph: its strokes in RAW Hershey coords (Y-down) and the
 *  nominal advance width `o` (raw units; multiply by HERSHEY_ADVANCE_SCALE
 *  to get the layout advance). */
export interface HersheyGlyph {
  advance: number
  strokes: Vec2[][]
}

/** Parse one glyph path string into RAW-coordinate strokes. "M" opens a new
 *  stroke; "L" / a bare pair extends the current one. Pure + deterministic. */
function parsePath(d: string): Vec2[][] {
  const strokes: Vec2[][] = []
  let cur: Vec2[] | null = null
  for (const tok of d.split(' ')) {
    if (tok.length === 0) continue
    const cmd = tok[0]
    const body = cmd === 'M' || cmd === 'L' ? tok.slice(1) : tok
    const comma = body.indexOf(',')
    if (comma < 0) continue
    const x = Number(body.slice(0, comma))
    const y = Number(body.slice(comma + 1))
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (cmd === 'M' || cur === null) {
      cur = [{ x, y }]
      strokes.push(cur)
    } else {
      cur.push({ x, y })
    }
  }
  return strokes
}

// Decode once at module load (memoized table indexed by charCode - 33).
const DECODED: HersheyGlyph[] = GLYPHS.map(([advance, d]) => ({
  advance,
  strokes: parsePath(d),
}))

/** The decoded "tofu" box used for any code point with no glyph. */
const TOFU = DECODED[DECODED.length - 1] // index for code 127

/**
 * Decoded glyph for a code point, in RAW Hershey coordinates. Code 32
 * (space) returns null (advance-only, the caller spaces it). Any code
 * outside 33..126 falls back to the tofu box so unknown text still bakes
 * to something visible rather than silently vanishing.
 */
export function hersheyGlyph(code: number): HersheyGlyph | null {
  if (code === 32) return null
  const idx = code - FIRST_CODE
  if (idx >= 0 && idx < DECODED.length - 1) return DECODED[idx]
  return TOFU
}

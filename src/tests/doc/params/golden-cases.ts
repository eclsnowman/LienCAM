// WO DOC-4 AC #1 + WO DOC-4-R1.4.A/C: the canonical golden expression table
// (source -> expected mm value). Shared between parser.test.ts (the
// determinism + evaluation golden itself) and math-domain.test.ts (R1.4.C's
// "sweep every golden-table row ... assert Number.isFinite on every
// committed value" requirement) so both exercise the SAME table, not two
// copies that could silently drift apart. Not a *.test.ts file itself --
// vitest never collects it as a test suite.

export const GOLDEN_CASES: Array<[string, number]> = [
  // precedence
  ['5', 5],
  ['2+3', 5],
  ['2-3', -1],
  ['2*3+4', 10],
  ['2+3*4', 14],
  ['2*3*4', 24],
  ['2+3-1', 4],
  ['20/2/5', 2],
  // parentheses
  ['(2+3)*4', 20],
  ['2*(3+4)', 14],
  ['((1+2))*3', 9],
  ['(1+2)*(3+4)', 21],
  // unary minus
  ['-5', -5],
  ['-2*3', -6],
  ['2*-3', -6],
  ['2--3', 5],
  ['2 - -3', 5],
  ['-(2+3)', -5],
  ['-(-5)', 5],
  ['--5', 5],
  // unit suffixes (bare number = mm; a suffix converts only its own literal)
  ['1in', 25.4],
  ['2mm', 2],
  ['1 in', 25.4],
  ['2 mm', 2],
  ['-1in', -25.4],
  ['2*1in', 50.8],
  // mixed-unit arithmetic
  ['1in + 2mm', 27.4],
  ['1in - 2mm', 23.4],
  ['(1in + 1in) / 2', 25.4],
  ['1in + 1in + 1mm', 51.8],
  // float edge cases
  ['.5', 0.5],
  ['0.1+0.2', 0.1 + 0.2],
  ['1/3', 1 / 3],
  ['10/4', 2.5],
  ['100000000.0001', 100000000.0001],
  ['0.0001*0.0001', 0.0001 * 0.0001],
  // WO DOC-4-R1.4.A: exponent operator -- right-associative, binds TIGHTER
  // than unary minus (the binding Fusion/standard-math golden row).
  ['2^3', 8],
  ['2^3^2', 512], // right-associative: 2^(3^2), NOT (2^3)^2 = 64
  ['-2^2', -4], // -(2^2), NOT (-2)^2
  ['2^-2', 0.25], // exponent's own RHS may carry a leading unary minus
  ['(-2)^2', 4], // parens override: THIS is (-2)^2
  ['2*3^2', 18], // '^' binds tighter than '*' too (via unary->power)
  // WO DOC-4-R1.4.A: function library (trig in DEGREES) + pi constant.
  ['sqrt(16)', 4],
  ['sqrt(2)', Math.sqrt(2)],
  ['abs(-5)', 5],
  ['abs(5)', 5],
  ['floor(2.7)', 2],
  ['ceil(2.1)', 3],
  ['round(2.5)', 3],
  ['round(2.4)', 2],
  ['min(3, 7)', 3],
  ['max(3, 7)', 7],
  ['sin(30)', Math.sin(30 * (Math.PI / 180))],
  ['cos(60)', Math.cos(60 * (Math.PI / 180))],
  ['tan(45)', Math.tan(45 * (Math.PI / 180))],
  ['asin(1)', Math.asin(1) * (180 / Math.PI)],
  ['acos(0)', Math.acos(0) * (180 / Math.PI)],
  ['atan(1)', Math.atan(1) * (180 / Math.PI)],
  ['atan2(1, 1)', Math.atan2(1, 1) * (180 / Math.PI)],
  ['pi', Math.PI],
  ['2*pi', 2 * Math.PI],
  // nested calls
  ['min(sin(30), 0.4)', 0.4],
  ['max(sqrt(16), min(10, 2))', 4],
  ['sqrt(abs(-16))', 4],
]

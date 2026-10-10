// cam3d L6: Toolpath Intermediate Representation (IR).
//
// One IR, three consumers (preview, simulation, post). Strategies emit this
// and nothing else -- no per-strategy output formats (MISSION.md rule 6).
//
// Units: mm, Z-up, Z=0 at table surface.

/** Semantic role of a move, used by feedrate resolution, sim coloring, and post. */
export type IrMoveRole =
  | 'rapid'
  | 'cut'
  | 'plunge'
  | 'ramp'
  | 'lead_in'
  | 'lead_out'
  | 'stepover'
  | 'finish';

/**
 * A single linear or arc move to an absolute endpoint (mm).
 * - 'rapid': positioning move, no feed.
 * - 'feed':  linear cutting move at feedrate f (mm/min).
 * - 'arc':   circular move; i/j are the arc center offset from the START
 *            point (G2/G3 convention), cw selects direction.
 */
export type IrMove = {
  t: 'rapid' | 'feed' | 'arc';
  x: number;
  y: number;
  z: number;
  f?: number;
  i?: number;
  j?: number;
  cw?: boolean;
  role?: IrMoveRole;
};

export type ToolpathIR = {
  moves: IrMove[];
  meta: {
    strategyId: string;
    cutterId: string;
    params?: Record<string, unknown>;
  };
};

// ---------------------------------------------------------------------------
// Deterministic fingerprint
// ---------------------------------------------------------------------------
//
// WHY determinism matters: the engine's regression safety net is snapshot
// testing WITHOUT a human in the loop. Identical inputs must produce a
// byte-identical ToolpathIR (MISSION.md rule 5: fixed iteration order, no
// Math.random, no time-dependent sampling). irFingerprint reduces an IR to a
// short content hash over a CANONICAL serialization, so a gate test can
// assert "this strategy on this fixture still produces exactly this path"
// with one string compare, and any behavioral drift -- reordered moves, a
// coordinate off by >=1e-6 mm, a changed role or feed -- flips the hash and
// stops the line. Numbers are formatted at a fixed 6 decimal places (1e-6 mm,
// well below machining tolerance) so the hash is stable across serialization
// quirks while still catching real geometric change; params objects are
// serialized with recursively sorted keys so JS object key insertion order
// (an accident of construction, not content) cannot affect the hash.

/** Canonical fixed-point number formatting: 6 decimals, no negative zero. */
function canonNum(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`irFingerprint: non-finite number in IR: ${n}`);
  }
  const s = n.toFixed(6);
  // Values in (-5e-7, 0] format as "-0.000000"; canonicalize to positive zero.
  return s === '-0.000000' ? '0.000000' : s;
}

/** JSON-like canonical serialization with recursively sorted object keys. */
function canonValue(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'number':
      return canonNum(v);
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'undefined':
      return 'undefined';
    case 'object': {
      if (Array.isArray(v)) {
        return '[' + v.map(canonValue).join(',') + ']';
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonValue(obj[k])).join(',') + '}';
    }
    default:
      throw new Error(`irFingerprint: unsupported value type '${typeof v}' in params`);
  }
}

function canonMove(m: IrMove): string {
  // Fixed field order; optional fields included only when present, so
  // "f absent" and "f=0" hash differently (they mean different things).
  let s = m.t + ';' + canonNum(m.x) + ',' + canonNum(m.y) + ',' + canonNum(m.z);
  if (m.f !== undefined) s += ';f=' + canonNum(m.f);
  if (m.i !== undefined) s += ';i=' + canonNum(m.i);
  if (m.j !== undefined) s += ';j=' + canonNum(m.j);
  if (m.cw !== undefined) s += ';cw=' + (m.cw ? '1' : '0');
  if (m.role !== undefined) s += ';role=' + m.role;
  return s;
}

/**
 * FNV-1a 64-bit over the canonical serialization, returned as 16 hex chars.
 * Pure and deterministic: same IR content -> same string, on every run,
 * every machine. 64-bit keeps accidental collisions negligible for the
 * snapshot-test population (hundreds of fixtures, not billions).
 */
export function irFingerprint(ir: ToolpathIR): string {
  const parts: string[] = [];
  parts.push('strategyId=' + JSON.stringify(ir.meta.strategyId));
  parts.push('cutterId=' + JSON.stringify(ir.meta.cutterId));
  if (ir.meta.params !== undefined) {
    parts.push('params=' + canonValue(ir.meta.params));
  }
  parts.push('moves[' + ir.moves.length + ']');
  for (const m of ir.moves) parts.push(canonMove(m));
  const text = parts.join('\n');

  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK64 = 0xffffffffffffffffn;
  let h = FNV_OFFSET;
  for (let idx = 0; idx < text.length; idx++) {
    // Hash UTF-16 code units byte-wise (lo then hi) so the input alphabet
    // is bytes, as FNV specifies. IR content is plain ASCII in practice.
    const cu = text.charCodeAt(idx);
    h ^= BigInt(cu & 0xff);
    h = (h * FNV_PRIME) & MASK64;
    h ^= BigInt(cu >>> 8);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

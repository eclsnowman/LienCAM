// WO-2869: the 3D Rough straight-plunge refusal, written once and read back once.
//
// emitLevelPasses refuses a straight plunge through standing stock (ADR-0003).
// Its engine text is the evidence the engine tests pin, so it stays exactly as
// it was; the operator never sees it. The integration layer reads the same
// fields back out of the worker's error (only name and message cross the
// worker boundary) and says them in machinist words. Formatter and parser live
// side by side so the two cannot drift apart.

/** Why the descent had to be a straight plunge. */
export type PlungeRefusalWhere =
  /** A region's opening entry: the planner's helix is below the floor radius. */
  | { kind: 'region'; mode: string; helixRadius: number; minHelixRadius: number }
  /** A lift-and-replunge landing: the fallback helix was too small, or none fit. */
  | { kind: 'landing'; fallbackHelixTooSmall: boolean };

export interface StraightPlungeRefusal {
  x: number;
  y: number;
  /** Highest standing material the plunge would meet. */
  fromZ: number;
  /** The level floor the plunge descends to. */
  toZ: number;
  fraction: number;
  uncutColumns: number;
  columns: number;
  allowance: number;
  where: PlungeRefusalWhere;
}

function whereText(where: PlungeRefusalWhere): string {
  if (where.kind === 'region') {
    return `region entry, mode ${where.mode}, helix radius ${where.helixRadius.toFixed(3)} below the ` +
      `${where.minHelixRadius.toFixed(3)} minimum`;
  }
  return where.fallbackHelixTooSmall ? 'lift landing, fallback helix too small' : 'lift landing, no helix fits';
}

/** The engine text emitLevelPasses throws. */
export function formatStraightPlungeRefusal(r: StraightPlungeRefusal): string {
  return (
    `emitLevelPasses: refusing a straight plunge through remaining stock at ` +
    `(${r.x.toFixed(3)}, ${r.y.toFixed(3)}) from ` +
    `${r.fromZ.toFixed(3)} to ${r.toZ.toFixed(3)}: ` +
    `${(r.fraction * 100).toFixed(1)}% of the cutter face ` +
    `(${r.uncutColumns} of ${r.columns} cells) still stands above the floor, ` +
    `allowance ${(r.allowance * 100).toFixed(0)}% (${whereText(r.where)}); adaptive cleanup must ` +
    `provide a cleared shaft, side entry, or fitting helix.`
  );
}

const NUM = '(-?\\d+(?:\\.\\d+)?|-?Infinity|NaN)';
const REFUSAL = new RegExp(
  `refusing a straight plunge through remaining stock at \\(${NUM}, ${NUM}\\) from ${NUM} to ${NUM}: ` +
    `${NUM}% of the cutter face \\((\\d+) of (\\d+) cells\\) still stands above the floor, ` +
    `allowance ${NUM}% \\(([^)]*)\\)`,
);
const REGION = /^region entry, mode (\S+), helix radius (-?\d+(?:\.\d+)?) below the (-?\d+(?:\.\d+)?) minimum$/;

/** The fields of a refusal message, or undefined when `message` is not one. */
export function parseStraightPlungeRefusal(message: string): StraightPlungeRefusal | undefined {
  const m = REFUSAL.exec(message);
  if (!m) return undefined;
  const whereRaw = m[9];
  const region = REGION.exec(whereRaw);
  let where: PlungeRefusalWhere;
  if (region) {
    where = { kind: 'region', mode: region[1], helixRadius: Number(region[2]), minHelixRadius: Number(region[3]) };
  } else if (whereRaw === 'lift landing, fallback helix too small' || whereRaw === 'lift landing, no helix fits') {
    where = { kind: 'landing', fallbackHelixTooSmall: whereRaw.includes('fallback') };
  } else {
    return undefined;
  }
  return {
    x: Number(m[1]),
    y: Number(m[2]),
    fromZ: Number(m[3]),
    toZ: Number(m[4]),
    fraction: Number(m[5]) / 100,
    uncutColumns: Number(m[6]),
    columns: Number(m[7]),
    allowance: Number(m[8]) / 100,
    where,
  };
}

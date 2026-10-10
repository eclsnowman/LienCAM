// WO-134 evidence shooter: a SECTION through the audit's 2 x 2-cell fixture
// showing the material a Z-level rougher leaves standing on it, before and
// after the fix.
//
// This is not part of the test gate -- it writes artifacts, so it only runs
// when WO134_CAPTURE names a shot label:
//
//   WO134_CAPTURE=after  npx vitest run src/tests/cam3d/wo134LadderCapture.test.ts
//   git checkout <pre-fix-sha> -- src/cam3d/rough/criticalDepths.ts
//   WO134_CAPTURE=before npx vitest run src/tests/cam3d/wo134LadderCapture.test.ts
//   git checkout HEAD -- src/cam3d/rough/criticalDepths.ts
//
// The BEFORE shot is therefore the REAL pre-fix code rendered by this same
// shooter, not a reconstruction, and each shot carries per-shot provenance
// (sha256 of the source files that produced it, plus the ladder and the
// measured remainder) in a sidecar JSON.
//
// WHAT IS SIMULATED, stated plainly. This shoots the LEVEL LADDER, not a full
// toolpath replay, and the carve applies the rougher's own documented masking
// rule directly to the z-dexel field: at level z a column is cleared to z when
// the PART does not stand above z (top > z + EPS_ABOVE is what remainingAbove
// tests), and is masked otherwise. That is the exact mechanism this WO is
// about -- a face at height h is only ever cut by a level AT or ABOVE h, so a
// ladder that steps over h leaves h's remainder behind. Tool radius and
// reachability are deliberately NOT modelled: the fixture's face is wider than
// the cutter in both directions and passes findCriticalDepths' own area gate,
// so reachability is not the variable under test. WO-101's shooter replays real
// IR moves through adaptiveRough; that path cannot shoot THIS fixture (see the
// worker result in queue/WO-134 -- adaptiveRough refuses this fixture class on
// current main for an unrelated region-accounting reason), and shooting the
// ladder is in any case the layer where the defect lives.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ZDexelField, EPS_ABOVE } from '../../cam3d/stock';
import { planLevels, findCriticalDepths } from '../../cam3d/rough';
import type { CutterSpec } from '../../cam3d/kernel/types';

const LABEL = process.env.WO134_CAPTURE ?? '';
const EVIDENCE = resolve(process.cwd(), 'src/tests/evidence/WO-134');
const SOURCES = ['src/cam3d/rough/criticalDepths.ts', 'src/cam3d/rough/levels.ts'];

// --- the audit's fixture, verbatim -------------------------------------------
const CELL = 2;
const SPAN = 40;
const FACE_MM = 4;
const FACE_Z = 5;
const FLOOR_Z = 2;
const STOCK_TOP_Z = 10;
const MAX_STEPDOWN = 4;
const CUTTER: CutterSpec = { kind: 'flat', diameter: 3 };
const CUTTER_AREA = Math.PI * (CUTTER.diameter / 2) ** 2;

/** The part: a 4 x 4 mm boss at Z=5 standing 3 mm proud of a solid floor at Z=2. */
function buildPart(): ZDexelField {
  const n = Math.round(SPAN / CELL);
  const tops = new Float32Array(n * n).fill(FLOOR_Z);
  for (let j = 0; j < n; j++) {
    const y = (j + 0.5) * CELL;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * CELL;
      if (x >= 16 && x <= 16 + FACE_MM && y >= 16 && y <= 16 + FACE_MM) tops[j * n + i] = FACE_Z;
    }
  }
  return ZDexelField.fromColumnTops({ originX: 0, originY: 0, nx: n, ny: n, cell: CELL }, tops, 0);
}

/**
 * Carve solid stock with `levels`, applying the rougher's masking rule per
 * column: cleared to z unless the part stands above z.
 */
function carve(part: ZDexelField, levels: readonly number[]): Float32Array {
  const stock = new Float32Array(part.top.length).fill(STOCK_TOP_Z);
  for (const z of levels) {
    for (let c = 0; c < stock.length; c++) {
      if (part.top[c] > z + EPS_ABOVE) continue; // part stands above: masked
      if (stock[c] > z) stock[c] = z;
    }
  }
  return stock;
}

/** Worst (largest) stock left above the part over the columns of the face. */
function remainderOverFace(part: ZDexelField, stock: Float32Array): { worst: number; cols: number } {
  let worst = 0;
  let cols = 0;
  for (let c = 0; c < stock.length; c++) {
    if (Math.abs(part.top[c] - FACE_Z) > 1e-6) continue;
    cols++;
    const left = stock[c] - part.top[c];
    if (left > worst) worst = left;
  }
  return { worst, cols };
}

// --- minimal PNG writer (8-bit RGB, filter 0) --------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 3);
    raw[o] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the section render -------------------------------------------------------

const PX_PER_MM = 16;
const PAD = 8;

/**
 * Section through row `j`, Z-up vs X: grey = stock still standing after the
 * carve, red = the part surface the rougher was asked to expose, yellow dashes
 * = the planned levels. Whatever grey sits above red is stock left behind.
 */
function renderSection(
  part: ZDexelField,
  stock: Float32Array,
  j: number,
  levels: readonly number[],
): { png: Buffer; width: number; height: number } {
  const w = Math.round(SPAN * PX_PER_MM) + 2 * PAD;
  const h = Math.round(STOCK_TOP_Z * PX_PER_MM) + 2 * PAD;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = 24;
    rgb[i * 3 + 1] = 26;
    rgb[i * 3 + 2] = 32;
  }
  const set = (x: number, y: number, r: number, g: number, b: number): void => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const o = (y * w + x) * 3;
    rgb[o] = r;
    rgb[o + 1] = g;
    rgb[o + 2] = b;
  };
  const px = (x: number): number => PAD + Math.round(x * PX_PER_MM);
  const py = (z: number): number => h - PAD - Math.round(z * PX_PER_MM);

  // Yellow dashes: the planned ladder.
  for (const z of levels) {
    for (let x = PAD; x < w - PAD; x += 8) {
      for (let k = 0; k < 4; k++) set(x + k, py(z), 210, 190, 70);
    }
  }
  // Grey: material still standing after the carve.
  for (let i = 0; i < part.nx; i++) {
    const c = part.colIndex(i, j);
    const x0 = px(part.centerX(i) - CELL / 2);
    const x1 = px(part.centerX(i) + CELL / 2);
    for (let x = x0; x < x1; x++) for (let y = py(stock[c]); y <= py(0); y++) set(x, y, 186, 190, 200);
  }
  // Red: the part surface.
  for (let i = 0; i < part.nx; i++) {
    const c = part.colIndex(i, j);
    const x0 = px(part.centerX(i) - CELL / 2);
    const x1 = px(part.centerX(i) + CELL / 2);
    const y = py(part.top[c]);
    for (let x = x0; x < x1; x++) {
      set(x, y, 232, 72, 72);
      set(x, y - 1, 232, 72, 72);
    }
  }
  return { png: encodePng(w, h, rgb), width: w, height: h };
}

/** sha256 of a source file, or 'absent' when this checkout has no such file. */
function sha256OfSource(relPath: string): string {
  const abs = resolve(process.cwd(), relPath);
  if (!existsSync(abs)) return 'absent';
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

describe.skipIf(LABEL === '')('WO-134 ladder capture', () => {
  it(`shoots the ${LABEL} section`, { timeout: 120000 }, () => {
    expect(['before', 'after']).toContain(LABEL);
    mkdirSync(EVIDENCE, { recursive: true });
    const pngPath = resolve(EVIDENCE, `face-section-${LABEL}.png`);
    const jsonPath = resolve(EVIDENCE, `face-section-${LABEL}.json`);

    // DELETE FIRST: a stale artifact must never be mistaken for a fresh shot.
    rmSync(pngPath, { force: true });
    rmSync(jsonPath, { force: true });
    expect(existsSync(pngPath)).toBe(false);
    expect(existsSync(jsonPath)).toBe(false);

    const part = buildPart();
    const pins = findCriticalDepths(part, {
      stockTopZ: STOCK_TOP_Z,
      floorZ: 0,
      minFlatArea: CUTTER_AREA,
    });
    const levels = planLevels(STOCK_TOP_Z, 0, MAX_STEPDOWN, pins);
    const stock = carve(part, levels);
    const left = remainderOverFace(part, stock);

    // The section row through the middle of the face.
    const j = Math.floor(18 / CELL);
    const shot = renderSection(part, stock, j, levels);
    writeFileSync(pngPath, shot.png);
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          wo: 'WO-134',
          label: LABEL,
          view: `section at y=${((j + 0.5) * CELL).toFixed(3)} mm (through the face centre), Z-up vs X`,
          legend:
            'grey = stock standing after the level ladder; red = part surface; ' +
            'yellow dashes = the planned levels',
          simulated:
            "level ladder only -- each level clears a column to z unless the part stands above z " +
            '(the rougher\'s own remainingAbove rule); tool radius not modelled',
          fixture: {
            source: "the WO-101 audit's constructed counterexample, verbatim",
            cell: CELL,
            span: SPAN,
            face: { widthMm: FACE_MM, z: FACE_Z, areaMm2: FACE_MM * FACE_MM, columns: left.cols },
            surroundingFloorZ: FLOOR_Z,
            stockTopZ: STOCK_TOP_Z,
            maxStepdown: MAX_STEPDOWN,
            cutter: CUTTER,
            cutterCrossSectionMm2: Number(CUTTER_AREA.toFixed(4)),
          },
          result: {
            criticalDepths: pins,
            levels,
            stockLeftOnFaceMm: Number(left.worst.toFixed(6)),
          },
          source: Object.fromEntries(SOURCES.map((s) => [s, sha256OfSource(s)])),
          image: { width: shot.width, height: shot.height, pxPerMm: PX_PER_MM },
        },
        null,
        2,
      )}\n`,
    );

    console.log(
      `WO-134 capture [${LABEL}]: pins [${pins.join(', ')}]; levels [${levels.join(', ')}]; ` +
        `stock left on the ${FACE_MM} x ${FACE_MM} mm face (${left.cols} columns): ` +
        `${left.worst.toFixed(3)} mm -> ${pngPath}`,
    );

    expect(statSync(pngPath).size).toBeGreaterThan(0);
    expect(statSync(jsonPath).size).toBeGreaterThan(0);
    expect(left.cols).toBe(4);
  });
});

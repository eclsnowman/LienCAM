// WO-1889: LienCAM finds the holes in the STLs real exporters write.
//
// WO-1846 proved the recogniser on clean, fine geometry. This order is about
// the three things that made it refuse a hole it could see perfectly well:
//   1. COARSE tessellation - a fit made through facet corners sits on the
//      circumscribed surface, so a 16-segment 32 mm bore misses by its own
//      chord error (0.307 mm) against a 0.25 mm budget;
//   2. CRACKED export - a seam column written twice, 1e-5 mm apart, leaves the
//      bore open, so it has one boundary loop instead of two and is no hole;
//   3. a SHALLOW chamfer - below the 26.6-degree region growing angle the
//      chamfer and its bore arrive as one region that fits no cylinder;
//   4. and a countersink an exporter wrote as several cone BANDS, which fits
//      no single cone.
//
// Rule 6: every assertion runs on REAL STL BYTES, read off disk and parsed by
// `importStl`, exactly as an import does. The files are generated - no
// third-party geometry - by src/tests/evidence/WO-1889/generate.mjs, which
// documents what each one is and why its numbers are what they are.
//
// Every case carries its NEGATIVE CONTROL in the same test: the same bytes with
// the one mechanism switched off, proving the fixture is found because of that
// mechanism and not by accident.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importStl } from '../../mesh/stl';
import { sourceFacetIdsOf } from '../../mesh/edit';
import { recognizeMeshFeatures, DEFAULT_FEATURE_OPTIONS } from '../../mesh/recognition';
import type { MeshFeatureOptions } from '../../mesh/recognition';

const DIR = 'src/tests/evidence/WO-1889';

function featuresOf(name: string, options: MeshFeatureOptions = {}) {
  const parsed = importStl(readFileSync(`${DIR}/${name}`));
  return recognizeMeshFeatures(parsed.mesh, sourceFacetIdsOf(parsed.mesh), options);
}

/** The recogniser exactly as WO-1846 shipped it: exact weld, corner-only fit,
 *  no second look at a region that proves as nothing. */
const WO1846: MeshFeatureOptions = {
  weldToleranceMm: 0,
  fitSubdivisionLevels: 0,
  splitMergedRegions: false,
};

/** The chord error of an `n`-segment circle of radius `r`, mm. */
const chordError = (r: number, n: number) => r * (1 - Math.cos(Math.PI / n));

describe('WO-1889 (1): a coarse countersink is found, and says how far off round it is', () => {
  const found = featuresOf('coarse-countersink.stl');

  it('the fixture really is outside the budget at its corners - that is why it was refused', () => {
    // 16 segments, 32 mm bore: this is the number the fit has to answer, and it
    // is arithmetic, not a guess.
    expect(chordError(16, 16)).toBeGreaterThan(DEFAULT_FEATURE_OPTIONS.toleranceMm);
    expect(chordError(16, 16)).toBeCloseTo(0.3074, 4);
  });

  it('is one countersink: a 32 mm bore opening through a 90-degree cone to 40 mm', () => {
    expect(found.features.map((f) => f.kind)).toEqual(['countersink']);
    const cs = found.features[0];
    expect(cs.bands.map((b) => b.surface)).toEqual(['cylinder', 'cone']);
    expect(cs.diameterMm).toBeCloseTo(32, 0);
    expect(Math.max(...cs.diametersMm)).toBeCloseTo(40, 0);
    expect(cs.bands[1].includedAngleDeg).toBeCloseTo(90, 0);
    expect(cs.depthMm).toBeCloseTo(12, 6);
  });

  it('reports a fit error inside the stated tolerance, and a diameter true to it', () => {
    const cs = found.features[0];
    expect(cs.maxDeviationMm).toBeGreaterThan(0);
    expect(cs.maxDeviationMm).toBeLessThanOrEqual(found.toleranceMm);
    // the measured error covers the distance from the fitted mid-surface to the
    // 32 mm the part was drawn at
    expect(Math.abs(cs.diameterMm - 32)).toBeLessThanOrEqual(2 * cs.maxDeviationMm);
    // and the clear bore it promises is never wider than the true one
    expect(cs.coreRadiusMm).toBeLessThan(16 * Math.cos(Math.PI / 16));
  });

  it('NEGATIVE CONTROL: with the subdivided fit off, the same bytes prove nothing', () => {
    const control = featuresOf('coarse-countersink.stl', { fitSubdivisionLevels: 0 });
    expect(control.features).toEqual([]);
    expect(control.refusals.some((r) => r.reason === 'surface-mismatch')).toBe(true);
  });
});

describe('WO-1889 (2): a hair-cracked export still has its hole', () => {
  const found = featuresOf('cracked-through-hole.stl');

  it('finds the 6 mm through hole, all 12 mm of it', () => {
    expect(found.features.map((f) => f.kind)).toEqual(['through-hole']);
    const hole = found.features[0];
    expect(hole.diameterMm).toBeCloseTo(6, 2);
    expect(hole.depthMm).toBeCloseTo(12, 6);
    expect(hole.maxDeviationMm).toBeLessThanOrEqual(found.toleranceMm);
  });

  it('says what it welded: two cracked corners, nothing ambiguous', () => {
    expect(found.crackWeldsClosed).toBe(2);
    expect(found.ambiguousCrackWelds).toBe(0);
  });

  it('NEGATIVE CONTROL: welding by exact coordinate leaves the bore open', () => {
    const control = featuresOf('cracked-through-hole.stl', { weldToleranceMm: 0 });
    expect(control.crackWeldsClosed).toBe(0);
    expect(control.features).toEqual([]);
    expect(control.refusals.some((r) => r.reason === 'unsupported-boundary-topology')).toBe(true);
  });
});

describe('WO-1889 (2b): an ambiguous crack is SKIPPED, not guessed', () => {
  it('three copies of one corner weld nothing there, and the hole stays unfound', () => {
    const result = featuresOf('ambiguous-crack-hole.stl');
    // the clean crack at the bottom of the seam still closes; the three-way one
    // at the top does not, and is counted rather than picked between
    expect(result.crackWeldsClosed).toBe(1);
    expect(result.ambiguousCrackWelds).toBeGreaterThan(0);
    expect(result.features).toEqual([]);
    expect(result.refusals.some((r) => r.reason === 'unsupported-boundary-topology')).toBe(true);
  });
});

describe('WO-1889 (3): a 20-degree chamfer is a chamfer, not a lost bore', () => {
  const found = featuresOf('shallow-chamfer-hole.stl');

  it('the chamfer really is inside the region growing angle - that is why it was lost', () => {
    expect(Math.tan((20 * Math.PI) / 180)).toBeLessThan(DEFAULT_FEATURE_OPTIONS.maxNormalSlope);
  });

  it('is a 6 mm bore with a 20-degree cone on its lip', () => {
    expect(found.features.map((f) => f.kind)).toEqual(['countersink']);
    const cs = found.features[0];
    expect(cs.bands.map((b) => b.surface)).toEqual(['cylinder', 'cone']);
    expect(cs.diameterMm).toBeCloseTo(6, 2);
    // 20 degrees off the bore on each side is a 40-degree included cone
    expect(cs.bands[1].includedAngleDeg).toBeCloseTo(40, 1);
    expect(cs.bands[1].diameterMm).toBeCloseTo(6, 1);
    expect(cs.bands[1].endDiameterMm).toBeCloseTo(2 * (3 + 3 * Math.tan((20 * Math.PI) / 180)), 1);
    expect(cs.maxDeviationMm).toBeLessThanOrEqual(found.toleranceMm);
  });

  it('the bore and the chamfer are different facets, and the feature owns both', () => {
    const cs = found.features[0];
    const [bore, cone] = cs.bands;
    expect(bore.sourceFacetIds.length).toBeGreaterThan(0);
    expect(cone.sourceFacetIds.length).toBeGreaterThan(0);
    expect(bore.sourceFacetIds.some((id) => cone.sourceFacetIds.includes(id))).toBe(false);
    for (const id of [...bore.sourceFacetIds, ...cone.sourceFacetIds]) {
      expect(cs.sourceFacetIds).toContain(id);
    }
  });

  it('NEGATIVE CONTROL: without the second cut the pair is refused as one region', () => {
    const control = featuresOf('shallow-chamfer-hole.stl', { splitMergedRegions: false });
    expect(control.features).toEqual([]);
    expect(control.refusals.some((r) => r.reason === 'surface-mismatch')).toBe(true);
  });
});

describe('WO-1889 (4): a countersink written as several bands is ONE countersink', () => {
  const found = featuresOf('banded-countersink.stl');

  it('lists one feature, with both cone bands in axial order under it', () => {
    expect(found.features.map((f) => f.kind)).toEqual(['countersink']);
    const cs = found.features[0];
    expect(cs.bands.map((b) => b.surface)).toEqual(['cylinder', 'cone', 'cone']);
    expect(cs.diameterMm).toBeCloseTo(6, 2);
    expect(cs.depthMm).toBeCloseTo(12, 6);
    expect(cs.maxDeviationMm).toBeLessThanOrEqual(found.toleranceMm);
  });

  it('the bands meet: each one starts where the one below it ended', () => {
    const bands = found.features[0].bands;
    for (let i = 1; i < bands.length; i++) {
      const below = bands[i - 1];
      expect(bands[i].axialRangeMm[0]).toBeCloseTo(below.axialRangeMm[1], 6);
      expect(bands[i].diameterMm).toBeCloseTo(below.endDiameterMm ?? below.diameterMm, 1);
    }
  });

  it('each band keeps its OWN angle - nothing is averaged into one cone', () => {
    const [, first, second] = found.features[0].bands;
    expect(first.includedAngleDeg).toBeCloseTo(60, 1);
    expect(second.includedAngleDeg).toBeCloseTo(110, 1);
  });

  it('NEGATIVE CONTROL: without the second cut the banded cone proves nothing', () => {
    const control = featuresOf('banded-countersink.stl', { splitMergedRegions: false });
    expect(control.features).toEqual([]);
  });
});

describe('WO-1889: nothing that recognised before this order changes its answer', () => {
  it('the WO-1846 acceptance plate reads identically with and without all three', () => {
    const now = featuresOf('plain-plate.stl');
    const before = featuresOf('plain-plate.stl', WO1846);
    expect(now.features.map((f) => f.kind).sort()).toEqual(
      ['boss', 'counterbore', 'countersink', 'through-hole'],
    );
    // not "the same kinds" - the same numbers, facet for facet
    expect(now.features).toEqual(before.features);
    expect(now.refusals).toEqual(before.refusals);
    expect(now.crackWeldsClosed).toBe(0);
  });

  it('a closed solid has no open boundary, so the crack weld cannot touch it', () => {
    for (const name of ['plain-plate.stl', 'coarse-countersink.stl', 'shallow-chamfer-hole.stl']) {
      expect(featuresOf(name).crackWeldsClosed).toBe(0);
    }
  });

  it('every feature found here still owns a unique, ascending, in-range facet set', () => {
    for (const name of [
      'coarse-countersink.stl',
      'cracked-through-hole.stl',
      'shallow-chamfer-hole.stl',
      'banded-countersink.stl',
      'plain-plate.stl',
    ]) {
      const result = featuresOf(name);
      const seen = new Set<number>();
      for (const feature of result.features) {
        expect([...feature.sourceFacetIds].sort((a, b) => a - b)).toEqual(feature.sourceFacetIds);
        expect(new Set(feature.sourceFacetIds).size).toBe(feature.sourceFacetIds.length);
        expect(Math.max(...feature.sourceFacetIds)).toBeLessThan(result.facetCount);
        for (const id of feature.sourceFacetIds) {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }
      }
    }
  });
});

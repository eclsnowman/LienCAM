// WO-2080: the app's own STL export of Step Test With Holes keeps the entry
// chamfer, cylindrical bore and flat floor as one editable hole.
//
// Rule 6: these are the real headed-run STL bytes, parsed by `importStl` and
// passed through `recognizeMeshFeatures`, the production call used by the
// Model screen. No mesh or recognition payload is built in the test.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildStlModelBodyModel } from '../../components/model3d/workbench/stlModelBody';
import { stlToolAccepts } from '../../components/model3d/workbench/stlFeatureEdits';
import { sourceFacetIdsOf } from '../../mesh/edit';
import { recognizeMeshFeatures } from '../../mesh/recognition';
import { importStl } from '../../mesh/stl';

const FIXTURES = 'src/tests/fixtures/WO-2080';
const STEP_TEST = `${FIXTURES}/export-step-test-with-holes.stl`;

function recognize(path: string) {
  const parsed = importStl(readFileSync(path));
  return recognizeMeshFeatures(parsed.mesh, sourceFacetIdsOf(parsed.mesh));
}

describe('WO-2080: chamfered blind holes exported from Step Test With Holes', () => {
  const result = recognize(STEP_TEST);

  it('recognises all 12 complete hole stacks with their measured dimensions', () => {
    expect(result.facetCount).toBe(3658);
    expect(result.features).toHaveLength(12);
    expect(result.features.map((feature) => feature.kind)).toEqual(Array(12).fill('blind-hole'));
    expect(result.features.map((feature) => feature.depthMm).sort((a, b) => a - b)).toEqual([
      8, 8, 8, 8,
      10, 10, 10, 10,
      13, 13, 13, 13,
    ]);
    for (const feature of result.features) {
      expect(feature.diameterMm).toBeCloseTo(5, 5);
      expect(feature.bands.map((band) => band.surface)).toEqual(['cylinder', 'cone']);
      // 72 cylinder facets + 72 cone facets + the 34-facet disk floor.
      expect(feature.sourceFacetIds).toHaveLength(178);
    }
    expect(result.refusals.some((refusal) =>
      refusal.reason === 'unsupported-transition' || refusal.reason === 'insufficient-radius-change',
    )).toBe(false);
  });

  it('offers every recognised hole to both Model-screen edit tools', () => {
    const model = buildStlModelBodyModel({
      geoId: 'wo-2080-step-test',
      name: 'export-step-test-with-holes.stl',
      bytes: readFileSync(STEP_TEST),
      meshEdits: [],
    });
    const holes = model.features.filter((feature) => feature.target.family === 'round');
    expect(holes).toHaveLength(12);
    for (const hole of holes) {
      expect(stlToolAccepts('resize-hole', hole)).toBe(true);
      expect(stlToolAccepts('defeature', hole)).toBe(true);
    }
  });
});

describe('WO-2080: established STL recognition stays unchanged', () => {
  it('keeps Platte C as five 5.5 mm chamfered through holes', () => {
    const result = recognize('src/tests/mesh/fixtures/obj_1_Platte C.stl');
    expect(result.features.map((feature) => feature.kind)).toEqual(Array(5).fill('chamfered-hole'));
    for (const feature of result.features) {
      expect(feature.diameterMm).toBeCloseTo(5.5, 5);
      expect(feature.depthMm).toBe(4);
      expect(feature.bands.map((band) => band.surface)).toEqual(['cone', 'cylinder', 'cone']);
      expect(feature.sourceFacetIds).toHaveLength(198);
    }
  });

  it('keeps the fix_plate_holes export as its six plain through holes', () => {
    const result = recognize(`${FIXTURES}/export-fix-plate-holes.stl`);
    expect(result.features.map((feature) => feature.kind)).toEqual(Array(6).fill('through-hole'));
    expect(result.features.map((feature) => Number(feature.diameterMm.toFixed(5)))).toEqual([
      6, 6, 6, 10, 10, 3,
    ]);
    for (const feature of result.features) {
      expect(feature.depthMm).toBe(10);
      expect(feature.bands.map((band) => band.surface)).toEqual(['cylinder']);
      expect(feature.sourceFacetIds).toHaveLength(72);
    }
  });
});

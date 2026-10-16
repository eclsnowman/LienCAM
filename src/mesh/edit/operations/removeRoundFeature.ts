// WO-1847 / ADR-0051 s3: fill a hole, or cut a boss off flush.
//
// The edit WO-1846 exists for. The operator picks a round feature LienCAM
// PROVED in his STL - a through hole, a blind hole, a counterbore, a
// countersink, a chamfered hole or a boss - and says Remove. The facets that
// make that feature go; the rim they leave is re-closed flat (boundaryCap.ts).
// No boolean, no kernel, no new vertex: the cap is built from the rim's own
// corners, so it welds to the part exactly and the result is closed and wound
// the same way the part already was.
//
// This file ADDS an operation and registers it. It changes nothing in the
// framework, which is what ADR-0051 s3 asks of every slice after WO-1845.
//
// What the record carries and why:
//   - `facets` (the framework's, not ours) is the selection, and it is the ONLY
//     thing the geometry depends on. Replay therefore never re-runs recognition
//     and never needs it to agree with a build from six months ago; the
//     witness (ADR-0051 s1.4) is what proves those indices still point at the
//     same region.
//   - `feature` names WHAT the operator removed, so the panel line and the
//     console say "Filled the 6.00 mm through hole" rather than "removed 128
//     facets". It is a label the app supplies from recognition, never something
//     the operator types.

import type { FeatureKind } from '../../recognition/types';
import { provePlateBosses } from '../../recognition/plateBosses';
import { weldMesh } from '../../recognition/topology';
import type { MeshBuffers } from '../../types';
import { facetCount, facetVertices, vertexCount } from '../idView';
import { registerMeshEditOperation } from '../registry';
import type {
  MeshEditAncestry,
  MeshEditApplyInput,
  MeshEditApplyResult,
  MeshEditOperation,
  MeshEditRecord,
} from '../types';
import { capExposedBoundary, facetSoup, keptFacetsOf } from './boundaryCap';

export const REMOVE_ROUND_FEATURE_KIND = 'remove-round-feature';
export const REMOVE_ROUND_FEATURE_VERSION = 1;

export interface RemoveRoundFeatureParameters {
  /** which WO-1846 feature this removed, for the panel line and the console */
  feature: FeatureKind;
  /** its functional diameter at the time, mm - reported, never used to cut */
  diameterMm?: number;
}

const FEATURE_WORDS: Record<FeatureKind, string> = {
  'through-hole': 'through hole',
  'blind-hole': 'blind hole',
  boss: 'boss',
  counterbore: 'counterbore',
  countersink: 'countersink',
  'chamfered-hole': 'chamfered hole',
};

const PARAMETER_KEYS = new Set(['feature', 'diameterMm']);

/** WO-2802: the boss foot remains a separately pickable blend. A boss
 * removal includes it, and the journal witnesses that complete selection. */
function completeBossSelection(mesh: MeshBuffers, facets: readonly number[]): number[] {
  const selected = new Set(facets);
  for (const boss of provePlateBosses(weldMesh(mesh))) {
    if (!boss.footFacets?.length) continue;
    const whole = new Set(boss.facets), foot = new Set(boss.footFacets);
    if (facets.every((f) => whole.has(f)) && boss.facets.every((f) => foot.has(f) || selected.has(f))) {
      return boss.facets;
    }
  }
  return [...facets];
}

/**
 * Delete `facets` and re-close what that opens.
 *
 * Throws a sentence naming what LienCAM cannot do when the rim cannot be
 * closed flat (see boundaryCap.ts). The caller has changed nothing at that
 * point - replay stops at this edit and keeps the earlier ones (replay.ts).
 */
export function removeRoundFeature(
  mesh: MeshBuffers,
  facets: readonly number[],
  options: { completeSelection?: boolean } = {},
): MeshEditApplyResult {
  const removed = new Set(options.completeSelection === false ? facets : completeBossSelection(mesh, facets));
  const kept = keptFacetsOf(mesh, removed);
  if (kept.length === 0) {
    throw new Error(
      'Removing this would take away every facet of the part, leaving nothing to cut. ' +
        'Nothing was changed.',
    );
  }
  const cap = capExposedBoundary(mesh, kept);
  const corners = kept.map((f) => facetVertices(mesh, f));
  return {
    mesh: facetSoup([...corners, ...cap.triangles]),
    ancestry: ancestryOf(mesh, kept),
  };
}

/**
 * The sentence this removal would refuse with, or null when it would go
 * through. The panel asks BEFORE it records, so a refusal never lands in the
 * journal as an edit that cannot replay.
 */
export function roundFeatureRemovalRefusal(
  mesh: MeshBuffers,
  facets: readonly number[],
): string | null {
  try {
    removeRoundFeature(mesh, facets);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export const removeRoundFeatureOperation: MeshEditOperation<RemoveRoundFeatureParameters> = {
  kind: REMOVE_ROUND_FEATURE_KIND,
  version: REMOVE_ROUND_FEATURE_VERSION,
  label: 'Remove round feature',
  completeSelection: completeBossSelection,

  describe(record: MeshEditRecord): string {
    const parameters = (record.parameters ?? {}) as Partial<RemoveRoundFeatureParameters>;
    const word = parameters.feature ? FEATURE_WORDS[parameters.feature] : undefined;
    const size =
      typeof parameters.diameterMm === 'number' && Number.isFinite(parameters.diameterMm)
        ? `${parameters.diameterMm.toFixed(2)} mm `
        : '';
    if (!word) return `Removed ${record.facets.length} facet(s)`;
    // A boss stands proud and is cut off; everything else is a void and is
    // filled. Same edit, the word the operator would use.
    return parameters.feature === 'boss'
      ? `Removed the ${size}boss, flush with the face`
      : `Filled the ${size}${word}`;
  },

  validate(parameters: Record<string, unknown>): RemoveRoundFeatureParameters {
    const given = parameters ?? {};
    const extra = Object.keys(given).filter((key) => !PARAMETER_KEYS.has(key));
    if (extra.length > 0) {
      throw new Error(
        `"${REMOVE_ROUND_FEATURE_KIND}" does not take ${extra.join(', ')}.`,
      );
    }
    const feature = given.feature;
    if (typeof feature !== 'string' || !(feature in FEATURE_WORDS)) {
      throw new Error(
        `"${REMOVE_ROUND_FEATURE_KIND}" needs to know which kind of feature it removed; ` +
          `"${String(feature)}" is not one LienCAM recognises.`,
      );
    }
    const diameterMm = given.diameterMm;
    if (diameterMm !== undefined) {
      if (typeof diameterMm !== 'number' || !Number.isFinite(diameterMm) || diameterMm <= 0) {
        throw new Error(
          `"${REMOVE_ROUND_FEATURE_KIND}" was given a diameter of "${String(diameterMm)}", ` +
            'which is not a measurement.',
        );
      }
      return { feature: feature as FeatureKind, diameterMm };
    }
    return { feature: feature as FeatureKind };
  },

  apply({ mesh, facets }: MeshEditApplyInput<RemoveRoundFeatureParameters>): MeshEditApplyResult {
    return removeRoundFeature(mesh, facets, { completeSelection: false });
  },
};

registerMeshEditOperation(removeRoundFeatureOperation);

/**
 * Who became what (ADR-0051 s4.4 / WO-1845's `MeshEditAncestry`). A surviving
 * facet maps to its one new index; a removed facet maps to nothing. The cap
 * facets deliberately appear in NO entry, which is how `composeSourceFacetIds`
 * marks them NO_SOURCE_FACET - "added by this edit", not descended from the
 * file. That is the acceptance line "every output facet maps back to a source
 * facet or is marked as added by this edit", made true by construction.
 */
function ancestryOf(mesh: MeshBuffers, kept: readonly number[]): MeshEditAncestry {
  const triangles: number[][] = Array.from({ length: facetCount(mesh) }, () => []);
  const vertices: number[][] = Array.from({ length: vertexCount(mesh) }, () => []);
  for (let out = 0; out < kept.length; out++) {
    const facet = kept[out];
    triangles[facet] = [out];
    for (let corner = 0; corner < 3; corner++) {
      vertices[mesh.indices[facet * 3 + corner]].push(out * 3 + corner);
    }
  }
  return { triangles, vertices };
}

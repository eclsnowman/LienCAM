// viewport3d: local tessellation-quality tiers for progressive display (WO
// UI-2, architect ruling #2: "coarse tier for first paint, refine to display
// tier asynchronously" -- measured need is 894k tris / 7.4s at default
// deflection on the Operator-designated Tray.step).
//
// HANDOFF NOTE: docs/3d-modeling-plan.md describes a shared, named
// TessQuality tier-preset system owned by GEO-2 (STEP import lane). That
// system had NOT merged into this branch at the time this WO was written, so
// these are LOCAL constants scoped to viewport3d only, not a substitute for
// the eventual shared presets. When GEO-2's presets land, replace these two
// exports with imports from that module (interfaceConcern; not this WO's to
// resolve since src/geom/** is frozen/out-of-scope here).

import type { TessQuality } from '../geom/geom-service';

/** First-paint tier: loose deflection, fast to tessellate, visibly coarse
 *  facets on curved geometry -- acceptable because it is swapped out for the
 *  display tier before the user can act on it. */
export const COARSE_TESS_QUALITY: TessQuality = { deflection: 0.5, angularDeflection: 0.8 };

/** Refined tier swapped in asynchronously once ready -- fine enough for
 *  normal interactive use (measure/pick precision, visual smoothness on
 *  curved faces). */
export const DISPLAY_TESS_QUALITY: TessQuality = { deflection: 0.08, angularDeflection: 0.35 };

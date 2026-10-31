# Workholding and setup-tabs service (WO-3004, alpha.3 A3-19 P2 parity slice)

A headless kernel service. It imports only kernel files and the pure modules the
WO-2904 boundary allows (`src/types`, `src/lib/cam/types`). Nothing in the app
calls it yet: the engine selector stays `current`, and `contour2d.ts`,
`workholdingIsland.ts`, the store's tab preview and every engine file are
unchanged. The composition root supplies today's authorities:

```ts
import { ensureClipperReady, offsetLoop } from '../../lib/cam/face2d/clipperOffset'
import { buildSolidColumns } from '../../lib/cam/holderClearance'
import { createGeometryService, faceAdapter } from '../geometry'
import { createWorkholdingService } from './index'

await ensureClipperReady()
const workholding = createWorkholdingService({
  geometry: createGeometryService(faceAdapter({ offsetLoop })),
  solidColumns: buildSolidColumns,
})
const setup = workholding.setup({ setupId, frame, obstacles: meshes.map((mesh, i) => ({ id: ids[i], mesh })) })
const bands = setup.depthBands({ depths, topZ: topZ + fluteLength, allowanceMm })
```

## What it does (the draft's algorithm sketch)

1. **Setup record**: setup id, the caller's WO-2945 frame token, the flip relation,
   the machine envelope by reference, and each fixture or clamp as an obstacle with
   its XY footprint and Z range. A missing or unreadable mesh is not refused: it is
   an omission with one operator line, and planning proceeds without that keep-out
   (today's behaviour plus the line).
2. **Keep-out at a cutting level**: `keepOuts(level)` and `depthBands(request)` are
   today's WO-1579 / WO-1618 footprint, read off the same solid column grid the reach
   trim tests and grown by allowance + half-diagonal + 0.05 mm, with every boolean and
   offset through the WO-2931 geometry service on the Face backend. `reduceRegion`
   takes them out of a region. `toolCentreKeepOuts` adds the tool radius (today each
   planner applies the radius itself; nothing calls this yet).
3. **Family routing**: `islandRouting(family)`. Flag off (parity): Pocket and
   Adaptive Clearing plan around the keep-outs, every other family is planned
   through and trimmed afterwards. The reach trim stays the backstop either way.
4. **Fixture evidence**: `obstacleTops()` publishes obstacle tops, highest first, for
   the future heights service. Nothing consumes them yet, so safe Z is unchanged.
5. **One tab block**: `tabBlock(request, loops, tabLocations)` resolves the tab
   settings once (stock bottom from the caller's planning stock record, never the
   viewport) and plans every loop's intervals with stable ids `loopId#k`. The words
   when it cannot are the engine's words.
6. **Routes**: `tabRoutes()`. Flag off (parity): Offset and Trochoidal roughing and
   the finish keep tabs, a rough offset split into regions (finish one) included -
   WO-3195 made the Offset rough lift over the finish's tab plan on every region
   (before it, Offset roughing and the split route cut through the tabs); a split
   finish and open chains refuse.
7. **Policy flags**: `keepout_in_planning` and `tabs_all_routes`, both OFF in
   `PARITY_POLICY`. Turning either on is a later order with a V13 before/after card.

## Not built here

The tab lift span that includes the tool radius (CF-067, inferred: confirm on a
fixture before the card), fixture recommendation, vise gates, the virtual support
workpiece and tab cut-off in the flipped setup (AP item 7 / GAP-008), and any
consumer: the first consumers to migrate are `pocket2d.ts` pocketDepthBands, the
adaptive engine's featureRunsAroundWorkholding and the contour builder's tab plan,
each in its own order with a P0 before/after.

## Proof

`src/tests/kernel/workholdingService.wo3004.test.ts` compares the service with the
engine's exported functions on unit fixtures and with the engine's own calls,
recorded while the P0 measuring-stick chains that carry workholding or tabs plan
through the app (`src/tests/evidence/WO-3004/parity.json`).

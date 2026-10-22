# Bounded tool and inventory service (WO-2932)

This is an additive headless data service. It imports only kernel files and
`src/types`. Production engines, stores, selection and feeds are unchanged.
The application composition root supplies the existing authorities:

```ts
import { TOOL_TYPE_META } from '../../lib/tool/toolMeta'
import { buildToolProfile } from '../../lib/tool/toolProfile'
import { createToolModel, createToolInventory, createToolCatalog } from './index'

const model = createToolModel({ types: TOOL_TYPE_META, buildToolProfile })
const catalog = createToolCatalog({
  catalogId: 'caller-supplied', catalogVersion: '1.0.0', licence: 'caller-specified',
  entries: callerCatalogTools,
})
const inventory = createToolInventory(userLibrary, [catalog], tool => model.classify(tool).standardType)
const candidates = inventory.tools({ scope: 'owned', types: ['flat_end_mill'], diameterRange: [3, 6] })
const description = model.describe(candidates[0].tool, userHolders)
```

The snippet belongs in a future composition adapter, not inside an engine.
The executable headless consumer in toolModelParity.wo2932.test.ts additionally
passes the retained records into the real toolLibraryToCsv exporter and compares
its bytes with the direct existing caller.

## Record and geometry rules

`ToolDefinition` carries all current Tool fields, including material-keyed recipes,
verbatim. It adds only optional owned, centreCutting, limits, catalogRef, lifecycle
and opaque evidence. It does not infer a limit from an rpm/feed/depth setting.
No persistence fields are added to existing Tool or project files.

The supplied canonical type table determines the 19 ids, groups and profile
families. A recognized imported fallback keeps its id, declaredTypeRaw and existing
profile; its typeStatus is fallback. An unrecognized raw id is other/unknown with
no claimed profile. No extra enum or legacy aliases override existing importers.

The profile is exactly the injected buildToolProfile result; this service contains
no profile, meshing or cutter-spec algorithm. ToolToCutterSpec remains the existing
engine's capability authority, including its unsupported-type errors. Tests compare
all four supported kinds against real profiles and analytic bottom-surface controls.
Profile-to-surface-kernel integration is future work; obtaining a profile here does
not grant a strategy permission to cut with it.

Holder resolution returns today's holder unchanged. An absent/unresolved holder or
absent lengthBelowHolder means not-checked. data-present only states that the two
inputs exist; it is not a clearance computation. Neck, shoulder, stickout, angles
and limits remain undefined when missing. The original record also retains the
exact distinction between an omitted property and an explicit undefined value.

## Inventory and identity rules

Library entries default to owned unless owned is explicitly false. Scope owned
returns these entries; catalog returns only separate catalog entries; both is the
union. Explicitly unowned library records are outside both sets. Catalog provenance
is authoritative even if incoming catalog data mistakenly carries owned:true;
that flag cannot promote an entry into the owned set. Version and licence come
from the caller; there are no fabricated production catalog entries.

Snapshots and query results are deeply frozen copies of plain structured data.
Neither caller mutation nor result mutation can change a catalog or query snapshot.
Filters use canonical mm, inclusive bounds and exact canonical ids (or other).
An empty type list matches nothing. Invalid ranges throw an API input error.
Ordering uses physical key, source, catalog id/version, library id, tool id/name,
then stable record content; it does not depend on locale or incoming list order.

physicalToolKey is a comparison key, never a tool id or a deduplication instruction.
All records retain ids, library membership, tool numbers and explicit selections.
The v1 key includes type/raw declaration, cutter lengths and angles, flute/thread
counts, material, coating and hand (absent hand = right). Identity excludes labels,
feeds, evidence, holder reference and installed stickout because those do not
identify a cutter. Unknown dimensions stay distinct from stated zero or defaults.
Identical incomplete keys are not proof that unknown geometry is confirmed equal.

Lengths default to mm; physicalToolKey(tool, 'inches') interprets only dimensional
fields as inches. Exact decimal strings and rational 25.4 normalize inch/mm input,
including exponents. Nothing is rounded to size classes: 6, 6.00001 and
6.000000000000001 remain distinct. Values computed with floating-point noise retain
that noise. This deliberately replaces A3-20's *inferred* 0.001 mm rounding, which
would silently merge distinct tools. Original records and feed units are untouched.

Evidence is opaque. Candidate, published-tested and locally-confirmed records and
active/retired lifecycle remain distinct and visible, never promoted or inherited.
An owned query is not an eligibility or default-selection query: it includes retired
records for inventory inspection. A future selection policy must check applicability
and retirement explicitly; this service produces no confirmed settings or selections.

## Integration handoff

First consumers to migrate in later orders:

- `src/tests/benchmark/alpha3Registry.ts:alpha3Tools` and
  `src/tests/benchmark/chainRunner.ts:toolFor`: compose an inventory from the exact
  current source records, retain explicit step toolIds and exact recipes, compare
  ids/recipes/profiles and all non-timing cells before and after. Do not replace
  synthetic benchmark fixture fields with guessed library values.
- `src/kernel/registry.ts` plus the later A3-15 feed/selection adapter: consume only
  explicitly selected tool descriptions initially. A new owned-selection policy
  needs its own scope, retirement/applicability tests and owner authorization.
- `src/components/modals/ToolLibraryModal.tsx` and the tool-library store slice may
  later display owned/catalog views, under their own UI/persistence work order.

Needed shared paths are those consumers, their exact tests and their composition
adapters; none is owned or migrated here. Before/after controls are current
ToolLibrary CSV bytes, real profiles/specs, explicit ids/feeds and the five-dialect
example G-code check. Rollback removes the consumer adapter and reads existing
Tool records directly; engine routing remains current with no new registrations.
This service is built; selection/UI/feeds/catalog rollout and whole A3-20 are not.

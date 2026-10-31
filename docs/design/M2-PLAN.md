# LienCAM redesign, M2: the implementation plan

Status: draft for the owner (WO-3095 M2), revision 3. Design source:
`docs/design/LIENCAM-DESIGN-SPEC.md`, `docs/design/control/CONTROL-LAYOUT.md`,
`docs/design/MISFIT-HOMES.md`, `docs/design/inventory/FEATURE-INVENTORY.md`.
Revision 2 folds in the code-structure review from the Rust feasibility study
(`/mnt/project-files/guides/ui-simplification-recommendations.md`, counts on
main 36d0e192). Revision 3 replaces the serial schedule with parallel waves
of small orders (section 4).

## 1. Goal and shape

Move the app to the new design language without a big-bang rewrite, and leave
standards behind so the same thing is built one way, in one place: a fix to a
shared part reaches every screen. The phases below say *what* gets built.
Section 4 says *how fast*: the work is cut into small orders with disjoint
file ownership and run as parallel waves, one worker thread per order, so
the schedule is set by the longest order in each wave, not by the sum.
Phase 1 is a **test-drive build** behind a **New UI** switch so the owner can
try the workflow early; the current UI stays the default until the flip.
Old screens are deleted as their replacements reach parity (ADR-0040: no
legacy before 1.0).

| Wave | What runs | Orders in parallel | Wall clock |
|---|---|---|---|
| 0 | Contracts: every shared interface and the checks, as stubs | 1 | a few hours |
| 1 | Foundations, store split, the test-drive shell, icons, tool profile data | 10 | about 1 day, ends with the test-drive build |
| 2 | Every workspace and window in the new language | 12 | 1 to 2 days after the owner's test-drive notes |
| 3 | Flip the default, delete the old shell, full gate | 1 | a few hours |

Total: about 3 to 4 working days of wall clock, with the test drive at the
end of day 1. The limit is no longer coding time; it is audit and landing
throughput and the owner's sign-offs, and section 4 says how those keep up.

Phases map to waves: Phase 0 (standards) is waves 0 and 1; Phase 1 (test
drive) is order W1-H; Phase 4 (icons) is W1-I; Phase 5 (data) is W1-J and
W2-12; Phases 2 and 3 (workspaces, windows) are wave 2; Phase 6 is wave 3.

## 2. Where the code is today

The shared pieces exist but are seldom used, so most screens build their own:

| Thing | Today | Shared part today |
|---|---|---|
| Dialogs | 43 bespoke dialog components, 32 files with their own overlay | `ConfirmModal`, 6 files |
| Number fields | 327 raw inputs in 84 files; 208 `toFixed`, 37 `parseFloat` | `NumericInput`, 43 files |
| Dropdowns | 231 native selects in 60 files | `ThemedListbox`, 4 files |
| Tooltips | 223 `title=` attributes | `ThemedTooltip`, 6 files |
| Keyboard | 48 files with their own keydown listener, 88 Escape checks | none |
| Styling | 1 788 inline styles, 161 raw hex values | tokens arrive in Phase 0 |
| UI reaching into CAM | 108 imports of `lib/cam`, 17 of `cam3d` from components | none |
| Operation parameters | Edited twice: New Operation dialog (11k lines) and Properties panel (7.5k lines) | none |
| Store | `store/index.ts`, 27k lines | none |
| Big files | 31 component files over 1 000 lines hold 95k of 163k component lines | none |

These are grep counts; they become the ratchet baseline (standard 13).

## 3. The standards (Phase 0): one way to do each thing

Each standard is a rule plus a check that fails the build, so it holds
without anyone remembering it.

**Parts and look**

1. **One component kit** in `src/components/kit/`: Card, Section, PropRow,
   Button, Segmented, Select, NumberField (with units), TextField, Toggle,
   Slider, Tooltip, Dialog, Window, Confirm, Notice, PromptBar, AnchoredValue,
   RibbonGroup, BrowserRow, Pill, ShowCard, ViewCube. Focus, Escape, keyboard
   navigation, theming and accessibility live inside the kit, never in screens.
   A kit gallery (a dev route) shows every part in every state and theme.
   *Check:* lint bans raw `<select>`, `<input type="number">`, `title=`
   tooltips, raw colours and inline colour or size styles outside the kit;
   each kit part has a screenshot test in three themes.
2. **One token source.** `src/theme/tokens.ts`, generated from the M1 tokens
   (themes, safety token, move colours, tool body colours, size classes), emits
   the CSS custom properties. *Check:* the lint in 1, and `contrast.mjs` in CI.
3. **Every action declares its kind**: `momentary`, `latched`, `choice` or
   `transport` (spec 7.1). Held, on and unavailable looks come from the kind.
   *Check:* the kit refuses a button without a kind.
4. **Icons with intent.** Generated from the M1 icon source, each with an
   intent row. *Check:* a new icon needs its row and a blind read.
5. **Words with budgets.** Every label in the four catalogues. *Check:* a
   render of each ribbon in each locale; over-budget labels use the small form.

**Behaviour in one place**

6. **One command registry.** Each command is declared once: id, label key,
   icon, workspace and group, kind, shortcut, and `availability()` returning
   ready or a reason. The ribbon, command search, shortcuts, tooltips and the
   unavailable state come from it. One **shortcut manager** and one **dialog
   stack** replace the 48 keydown listeners: Escape closes the top dialog and
   nothing else listens. *Check:* no ribbon button or shortcut outside the
   registry.
7. **One notice and refusal API.** Every operator message (info, warning,
   cannot-do-this, error) goes through the Notice part and one message
   catalogue. A command's unavailable reason comes only from `availability()`,
   so LIENCAM.md rule 11 holds in one place. *Check:* no operator text outside
   the catalogue.
8. **One units and format service.** `formatLength`, `parseLength`,
   `formatAngle`, `formatFeed` and the rest own mm or inch, precision and the
   locale's decimal mark. *Check:* no `toFixed` or `parseFloat` in components.
9. **Operation parameters described once (schema-driven).** Each operation
   type declares its parameters once: key, type, unit, range, default, label
   and help keys, group, and when it shows. The operation card, help, defaults
   and validation render from that one declaration, so adding a parameter is
   one entry in one file. Tool profile steps (Phase 5) use the same schema
   lists. *Check:* the operation card has no hand-written parameter field.
   This is the largest single simplification; Phase 0 pilots it on Pocket.

**Structure**

10. **Screens show, other code decides.** Components render data and call
    commands; they do no geometry or CAM math. Each screen gets a
    `useXxxViewModel()` hook that gathers what it shows, and tests target that
    hook. *Check:* an import boundary, the mirror of today's rule: components
    may import the kit, store selectors and commands, not `lib/cam`, `cam3d`,
    the kernel or wasm internals (today 125 such imports, ratcheted down).
11. **Store in domain slices.** `store/index.ts` splits into project, sketch,
    model, setups, operations, tools, machine and UI-preference slices with
    named selector hooks (`useOperation(id)`, `useActiveSetup()`); no raw store
    lambdas in components. Each workspace order moves its own slice, so there
    is no big-bang split. Store changes keep needing the Architect's grant.
12. **Size limits.** New UI files stay under about 800 lines; existing big
    files may not grow and are split when their screen moves to the kit.
13. **Ratchet counters.** `tools/ui-debt.json` holds the counts in section 2.
    *Check:* the gate recounts on every order and fails if any count rises, so
    progress is a number that only falls.
14. **Layout rules as tests.** `layout-check.mjs` becomes a Playwright suite:
    every workspace at the six target sizes in three themes, spec 5.1 rules 1
    to 8, including Control's "sizes never reorder modules".
15. **Pictures with every change.** A UI order lands with before and after
    pictures from the same build script.
16. **Delete on parity.** The order that ships a screen in the new UI deletes
    the old one. No screen exists in two versions longer than one order.

New features then follow spec section 13 and inherit every check.

Wave 0 fixes the interface of every standard before any lane starts; wave 1
fills them in parallel (section 4).

## 4. Waves and orders: the fast schedule

**Why it was slow.** Revision 2 sized the work as if one worker did it in
sequence. The project already runs 5 to 10 worker threads at once, and one
order takes hours from lease to READY FOR AUDIT. The plan is therefore cut
into orders that do not touch the same files, so they run side by side.

**How quality holds at speed.**

- *Contracts first.* Wave 0 writes the types, props and function signatures of
  every shared part, with working stubs. Every later order codes against them,
  so parallel orders cannot drift apart. Only the wave 0 owner changes a
  contract, through a one-line request on its PR.
- *Disjoint ownership.* Each order owns a list of paths. Two orders in the same
  wave never own the same file; the store split lands early in wave 1 so the
  workspace orders in wave 2 each own their own slice.
- *Checks do the reviewing.* Lint bans, the ratchet, the layout suite and
  screenshot tests from wave 0 run on every order. Each worker also runs one
  independent auditor before READY, so the Architect's audit is short.
- *Small orders.* No order is planned at more than about half a day of worker
  time; anything bigger is split before it is leased.

**Wave 0, the spine (1 order, a few hours).**

| Order | Owns | Delivers |
|---|---|---|
| W0 Contracts | `src/components/kit/types.ts`, `src/theme/`, `src/commands/types.ts`, `src/lib/units/types.ts`, `src/notices/types.ts`, `src/lib/opschema/types.ts`, `tools/ui-debt.json`, lint config, `src/ui2/` skeleton | Interfaces and stubs for kit parts, registry, notices, units and the parameter schema; tokens generated from M1; the New UI switch; ratchet baseline and check; lint rules set to warn on old code, fail on new |

**Wave 1 (10 orders in parallel, about 1 day).**

| Order | Owns | Delivers |
|---|---|---|
| W1-A Kit inputs | `kit/inputs/` | NumberField, TextField, Select, Segmented, Toggle, Slider |
| W1-B Kit surfaces | `kit/surfaces/` | Card, Section, PropRow, Pill, Tooltip, Dialog, Window, Confirm, dialog stack |
| W1-C Kit actions | `kit/actions/` | Button with the four action kinds, RibbonGroup, PromptBar, AnchoredValue, ShowCard |
| W1-D Units and notices | `lib/units/`, `notices/` | Units and format service; notice part, catalogue and refusal API |
| W1-E Commands | `commands/` | Registry, shortcut manager, command search |
| W1-F Parameter schema | `lib/opschema/` | Schema renderer, Pocket pilot |
| W1-G Store split | `store/` | Domain slices and named selector hooks; behaviour unchanged |
| W1-H Test-drive shell | `ui2/shell/` | App bar, tabs, ribbon, Browser and Properties cards around today's panels, View cube, Show card, themes, scale, Setup placement, Control frame |
| W1-I Icons | icon source, intent rows | The 19 remaining fails and NEAR pairs to a 0-fail blind read |
| W1-J Tool profile data | tool data model and its tests | Profile steps from the tip up, tapers exact in Simulate and collision |

The shell (W1-H) starts on the wave 0 stubs and picks up the real parts as
they land. The gallery and layout suite grow with each kit order. **End of
wave 1: the owner's test-drive build.**

**Wave 2 (12 orders in parallel, 1 to 2 days).** Started when the owner's
test-drive notes are in; each note goes into the order that owns that screen.

| Order | Delivers |
|---|---|
| W2-1 Setup | Place, Workholding, Nest mode, Setup and Import cards |
| W2-2 Toolpath card | One operation card from the schema; all operations converted |
| W2-3 Toolpath ribbon and Post | Operation grid, Post group, G-code in view, Show card |
| W2-4 Simulate | See-through tool, Show card |
| W2-5 Control | Modules, locked stops, Arrange, saved layouts, size rules |
| W2-6 Sketch | One Sketch for 2D and 3D; DXF and SVG import into sketch geometry; reference images; DXF export |
| W2-7 Model runtime | Model switcher, Inspect, history; split the workbench page into scene runtime and tools |
| W2-8 Model modes | Form, Relief and Drawing as modes |
| W2-9 Tool library | Tools and Holders windows with profile steps |
| W2-10 Machine | Machine window, gantry drawing, what needs fixing |
| W2-11 Settings and Home | Settings window, Home menu, start page |
| W2-12 Sketch as toolpath input | Operations take sketch curves and profiles |

Each order deletes the old screens it replaces and lowers its ratchet counts.

**Wave 3 (1 order, a few hours).** Flip New UI to the only UI, delete the old
shell, run the full gate slice.

**What sets the pace now.**

| Limit | Answer |
|---|---|
| Audit and landing | Checks and the worker's own auditor carry most of the review; the Architect lands each wave as a batch |
| The owner's sign-off | One test drive after wave 1 and one look at wave 2 as a whole, not a sign-off per workspace |
| Spend | Wave 1 and 2 run 10 to 12 threads at once; sonnet-sized orders (kit parts, windows, icons) use the smaller model |
| A contract turns out wrong | The wave 0 owner changes it once, every lane rebases; the stubs keep lanes unblocked meanwhile |

## 5. Phase 1: the test-drive build

Behind Settings > Appearance > **New UI** (off by default). It is a new shell
around today's working panels, so the owner tests the workflow, not finished
visuals:

- app bar, flat workspace tabs (Setup, Sketch, Model, Toolpath, Simulate,
  Control), ribbon from the registry with the first commands;
- floating Browser and Properties cards hosting today's tree and panels;
- strip, View cube at lower left with the View style flyout, Show card at
  bottom right;
- themes (Default, Amber, Light) and interface scale 75 to 150 %;
- Setup: Place group, gizmo and the Part card position and rotation fields;
- Control: today's modules in the new frame, action states, Jog top right.

Exit: the owner's test drive and a list of changes, which become Phase 2
orders.

## 6. Phase 2: workspaces

Wave 2 runs one or two orders per workspace at the same time. Each order builds the workspace from kit parts, a view-model
hook and its store slice; moves its misfits to their homes (`MISFIT-HOMES.md`);
deletes the old screens it replaces; and passes the gates with the ratchet
counts lower than before.

- **Setup:** Place and Workholding groups; Nest as a mode; Setup card; Import card.
- **Toolpath:** ribbon as the operation type grid; one operation card rendered
  from the parameter schema, replacing both the New Operation dialog and the
  Properties editor; Post as a group with the G-code in the view; Show card.
- **Simulate:** see-through tool, flutes green and shank, holder and spindle red;
  Show card.
- **Control:** modules, locked stops, Arrange mode, saved layouts, size rules.
- **Sketch:** one Sketch for 2D and 3D with every tool from both; DXF and SVG
  import with cleanup into native sketch geometry; reference images; DXF export.
- **Model:** model switcher; Form, Relief and Drawing as modes; Inspect group;
  feature history. The 24k-line workbench page splits into sketch tools, form
  tools and the scene runtime as it moves.

## 7. Phase 3: windows and Home

Tool library (Tools and Holders, profile steps), Machine (library, definition
areas with what needs fixing, the gantry drawing), Settings (app settings only),
and the Home menu with its start page. All are kit Windows.

## 8. Phase 4: icons to zero fails

Round 4 of the blind read had 26 fails. Seven of those icons have been redrawn
since (revolve, fillet, chamfer, face, pocket, trim, mirror), and draft and
measure were redrawn on the owner's notes. The remaining 19 (engrave and
V-carve, section, compare, deviation, zebra, the form tools, detail view, fit
arcs, collinear and the rest of the round-4 list) and the NEAR look-alike pairs
get one more pass. Exit: a fresh blind read with 0 fails.

## 9. Phase 5: data changes

- **Tool profile steps:** tools stored as steps from the tip up (lower Ø,
  upper Ø, length), like holder segments, using the parameter schema's list
  type, so tapers and reduced shanks are exact in the drawing, Simulate and
  collision checks (no old-format reader, per ADR-0040).
- **Sketch geometry as a toolpath input:** operations take sketch curves and
  profiles beside model faces and edges, picked the same way.
- **DWG import:** not in the app today; a separate order if wanted.

## 10. Phase 6: flip and delete

New UI becomes the only UI and the old shell is deleted; the old screens are
already gone by standard 16. The gate slice runs green on the flipped build.

## 11. Risks

| Risk | Answer |
|---|---|
| Two shells drift while both exist | Phase 1 hosts today's panels; each Phase 2 order deletes what it replaces; no feature work lands in the old shell after Phase 2 starts |
| The 27k-line store is touched by every workspace | Each workspace order moves only its own slice; store changes need the Architect's grant |
| The schema pilot does not fit every operation | Pilot on Pocket in Phase 0; Toolpath's order converts the rest and lists any exception |
| Visual or behaviour regressions | Kit screenshots, layout suite and ratchet run on every order |
| Icon pass stalls | It runs in wave 1 beside everything else; old icons stay until it passes |
| The test drive changes the plan | That is its job: Phase 2 orders are written after it |

## 12. Expected effect

The Rust feasibility study estimates a 30 to 40 % reduction in UI code (not
measured), mostly from the kit, the parameter schema and the units service.
The larger gain is that each thing exists once: a fix to the number field,
the dialog or a refusal message reaches every screen.

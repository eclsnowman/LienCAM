# Agent control of LienCAM (MCP) - design brief

Status: PROPOSED, with the operator's rulings of 2026-09-29 (below). the operator asked for this first step on 2026-09-29 ("Yes
please start the first step for this"). It is a brief for the architect, not an ADR: the ADR and the work orders are
the architect's to file.

## the operator's rulings (2026-09-29) - binding on this work

1. **Desktop only.** "Start with the electron desktop app only." The MCP server lives in the Electron app; the web
   build gets none.
2. **The agent changes the project.** "change the project". The agent edits the project itself; it does not only
   propose. Every change still lands in the visible tree as the same change a dialog makes, and can be undone.
   Machine motion stays out of reach (binding rule 1).
3. **CAM strategy first, modeling close behind.** "I want cam strategy and modeling. If we have to pick one start
   with CAM, but closely followed by the modeling." The first release leads with planning machining with the user's
   own tools; modeling tools follow straight after.

**And 2026-09-30:**

4. **Additive only.** "Just make sure this mcp addition doesn't break how we use it for internal development.
   Because I am fine with the current "go" implementation i have to work collaboratively with the machine session on
   my cnc. This is meant to add functionality, not remove things we need on our end."
   - Every `window` hook, the evidence scripts' dev imports and direct store writes, and the machine seat's way of
     driving the app (Electron with `--remote-debugging-port=9222`, Playwright over the debugging port, the app's own
     buttons, the operator's go) all stay as they are.
   - The MCP server and the command layer are new paths beside them.

## The goal, in the operator's words

"someone using our software to model something for them driven by an AI agent ... or having an ai agent be able
to develop a machining strategy for them with the tools they have defined."

An AI agent (Claude Desktop, Claude Code, Codex, Cursor - any MCP client) connects to a running LienCAM and works
in the user's project through named, typed tools. It never drives the screen.

## What MCP is (for the record)

The Model Context Protocol is a standard for a program to offer an AI agent tools. Each tool has a name, a typed
input schema and a description. The client lists the tools, the agent calls them, and the program answers with a
result or an error. Servers run locally (stdio or a localhost HTTP port) or remotely.

## What exists today (facts, 2026-09-29)

- Agents drive LienCAM only as developers do:
  - they read and edit src/;
  - or Playwright runs the web build and calls test hooks on `window`: `__solidsWorkbenchHooks` (the model DAG:
    `dag.insertNode`, `fullResync`, `getBodyHandle`, `client.measure`, `client.tessellate`), `__camStore`,
    `__formStore`.
  - src/tests/evidence/FORM/tutorials.mjs is a worked example. It built two parts by inserting the same DAG nodes
    the dialogs write, and checked every step against the app's state.
- Some of those hooks are dev-build only (`useFormSession.ts`: `if (import.meta.env.DEV) window.__formStore = ...`).
  A production LienCAM has no supported way in for an agent.
- The desktop app is Electron:
  - `electron/main.cjs` already runs IPC handlers (`ipcMain.handle('liencam:...')`) and spawns the machine bridge
    (`spawn(process.execPath, [serverPath, '--bridge', ...])`);
  - `electron/preload.cjs` bridges to the renderer.
- The model is a tree of plain data. Every feature is a DAG node with a typed payload: sketch, extrude, revolve,
  fillet, chamfer, hole, shell, pushPull, boolean, form cage, offset plane and more. Results are checkable: a
  feature's status and diagnostics, and a body's volume, faces and edges.
- Nothing MCP-related exists in the repo.

## Why it fits LienCAM

1. **CAM strategy with the user's own tools** (the headline). From the part, the stock, the user's tool library and
   machine limits, the agent proposes setups: operations, tools, stepovers, feeds and speeds. It simulates, checks
   for gouges and uncut material, and adjusts. Every choice can be checked, so an agent can iterate honestly.
2. **Modeling from a description.** The result is a real, editable tree, not a mesh.
3. **Explaining and fixing.** Why a feature failed and what would work; what an unknown project does.
4. **Batch work.** Part families from a table; regenerate toolpaths across variants.

## Binding rules proposed for the ADR

1. **No machine motion through MCP.** Modeling, CAM planning, simulation and G-code preview only. Sending a job,
   jogging, probing and anything on the Control or Probing screens stays a human action at the machine. No MCP tool
   may reach src/lib/machine/, pendant/ or the bridge's motion paths.
2. **The agent works in the user's visible project.** Every call becomes the same tree change a dialog would make.
   It appears in the tree and is undoable, and it goes through the same validation (LIENCAM.md rule 5 verdicts).
3. **The app's own words.** Tool names and parameters mirror the dialogs. A refusal returns the same message the
   operator would see (rule 11: no new refusal wording invented for agents).
4. **The agent edits directly** (the operator's ruling 2). No per-change confirm by default. Every change is one undoable
   step in the tree, named for what it did, so the user can review and undo it.
5. **Local only by default.** Localhost or stdio, off until the user turns it on in Settings, with a visible
   indicator while an agent is connected.

## Architecture (proposal)

- **A command layer in the renderer.** This is the real work, and it is worth having without MCP:
  - one module (for example src/lib/agent/commands.ts) with typed, validated commands built on the paths the
    dialogs already use;
  - it is the supported way for an agent to drive the app, added beside the `window` hooks (which stay: ruling 4);
  - the tutorial recorder runs on it as the proof, and other tests may use it when convenient.
- **An MCP server in Electron's main process:**
  - the MCP TypeScript SDK, speaking stdio (for a client that launches LienCAM) or localhost HTTP (for one that
    attaches to a running LienCAM);
  - it forwards each tool call to the renderer over IPC, through preload, and returns the command's result.
- **The web build:** no MCP server there (the operator's ruling 1). The command layer still serves tests.

## Phase 1 tool list: CAM strategy (the operator's ruling 3)

| Tool | Does |
|---|---|
| `project_summary` | The tree (features, sketches, planes, their status), bodies, setups, tools in use |
| `feature_details` | One node's payload and diagnostics, in dialog terms |
| `measure` | A body's volume, area, bounding box; a face or edge's size |
| `find_geometry` | Faces or edges by description (flat faces at z = 0, circular edges of radius 4) returning stable ids |
| `tool_library` | The user's tools and holders, with their limits |
| `machine_limits` | Travel, spindle range, feed limits (read-only) |
| `simulate_setup` | Run a setup's simulation; report gouges, uncut stock, time |
| `add_setup` / `edit_setup` | Stock, work offset and orientation for a setup |
| `add_operation` / `edit_operation` / `delete_operation` | Machining operations, with the user's tools and the dialogs' parameters |
| `generate_toolpaths` | Compute a setup's toolpaths; report failures in the app's own words |
| `export_gcode` | Post a setup to a G-code FILE on disk (never to the machine) |

## Phase 2 tool list: modeling (straight after)

| Tool | Does |
|---|---|
| `add_feature` / `edit_feature` / `delete_feature` | Sketches, extrude, revolve, fillet, chamfer, hole, shell, boolean, offset planes, with the dialogs' parameters |
| `form_*` | Form cages: start from a starter, symmetry, move points, faces and edges, crease, finish (tutorials.mjs shows the calls) |

## Command-layer inventory (work order 1, 2026-09-30)

This is the inventory work order 1 asked for. It lists every `window.__*` hook the app exposes, who uses each one,
the Phase 1 and Phase 2 commands they group into, and the dialog code path each command must share. No product
code was changed.

Method:
- Grep of `src/`, `electron/` and `tools/` at `4f513de8` (main, 2026-09-30 11:35 AM).
- `src/tests/evidence/FORM/tutorials.mjs`, which exists only on `form/subd` (`aea35201`). It was read from that
  branch, so it is not in the counts below.
- Line numbers are for that commit. `index.ts` means `src/store/index.ts`; `Page` means
  `src/components/model3d/SolidsWorkbenchPage.tsx`.

### Findings that shape the command layer

1. **Three hooks ship in production.** `__solidsWorkbenchHooks` (`Page:15805`) and `__cncViewport` / `__camDebug`
   (`Viewport.tsx:1440`) are not behind `import.meta.env.DEV`, so they are live in the Electron build.
   - `__solidsWorkbenchHooks` hands out the raw `dag`, `history` and `scheduler`.
   - `__cncViewport` is the whole `CNCViewport` instance.
   - Either one lets any script in the renderer change the model without undo or validation.
   - They are reachable only from inside the renderer: DevTools, or the debugging port the machine seat uses. They
     cannot be reached from an MCP client. They stay (ruling 4). The MCP server simply never calls them.
2. **Product code reads test hooks.** A command that needs one of these reads the source directly. The hook stays
   installed either way:
   - `src/lib/cam/modelBodyHoleRecognition.ts:60` reads `__solidsWorkbenchHooks` (`getBodyHandle`,
     `client.recognizeFeatures`, `snapshotsFor`) to recognise holes for CAM.
   - `index.ts:8429` reads `__solidsWorkbenchHooks.history.checkpoint()` to decide whether a delete can be undone.
   - `index.ts:2310` `getStockBoundsFromViewport` makes toolpath compute read auto-stock bounds from
     `__cncViewport` first (callers at 2493, 2515, 17504, 18858, 18920, 19433, 19467). A run with no viewport can
     get different stock bounds. A headless command, or the agent while the CAM view is closed, would hit this.
   - Other readers: `index.ts:396` `getViewportHandle`, `:578` (STL re-add), `:14091` (boolean mesh bbox), and
     about 14 components.
3. **The tests reach past `window` too.**
   - 236 evidence scripts `import('/src/...')` modules straight from the Vite dev server.
   - 185 files make 272 `setState(...)` calls. They write `project` 116 times, `machineLibrary` 82,
     `toolLibrary` 30, `viewer` 23 and `editingOpPayload` 7.
   - Those writes skip every dialog, every validator and history. That is fine for tests building a scene, and they
     stay (ruling 4).
   - It does mean none of these paths can be handed to an agent. The command layer is the separate, validated path
     for that.
4. **Most CAM validation lives only in components.** Only three places validate inside the store or a shared lib:
   - tools (`validateToolGeometry`, `src/lib/tool/toolValidation.ts`, run at `index.ts:13304` / `:13326`);
   - the Smart Height authority in `addOperation`;
   - the post engine (`src/lib/post/validate.ts`).

   Everything else lives only in the dialog components, and has to be extracted into shared functions before a
   command can share it:
   - setup (`SetupModal.tsx` `canSave` :1064 and `handleSave` :1083);
   - operation gates and payload assembly (`NewOperationModalBody.tsx` `canCreate` :3715, `handleCreate` :3843);
   - post staging (`PostProcessModal.tsx` `canExport` :802, `handleExport` :871);
   - simulation (`SimulationPanel.tsx` :971 / :1020).

   **This extraction is the real work of work order 2.**
5. **Modeling validation is the same story.**
   - Every feature dialog builds its payload and its `applyDisabled` / `invalid` rule inside the component:
     Extrude, Revolve, Boolean, Hole, Fillet, Chamfer, Shell and Loft.
   - The page adds a preview-fingerprint guard (for example `guardExtrudeApply` `Page:19182`).
   - The commit path itself is shared already: `createFeatureCommand` (`src/components/model3d/dialogs/createFeatureCommand.ts:25`)
     and `EditFeaturePayloadCommand` (`dialogs/EditFeaturePayloadCommand.ts:35`), followed by
     `handleDialogApplied` (`Page:17041`).
6. **There are two undo systems, and neither one names CAM steps.**
   - CAM: `pushHistory` (`index.ts:16410`) snapshots the whole `Project`, 50 deep, with no label. Changes made in
     the same turn merge into one step (`index.ts:7987`).
   - Modeling: `CommandHistory` (`src/doc/commands.ts:413`) stores `Command {label, do, undo}`. It also keeps a
     parallel touched-id stack (`touchedPastRef`), popped in lockstep by `handleUndo` (`Page:17339`).
   - Test code that calls `dag.insertNode` or `setPayload` directly writes no history.
   - Test code that calls `history.execute` directly desyncs the touched-id stack.
   - Binding rule 4 ("one undoable step, named for what it did") needs CAM history entries to carry a label.
7. **The worked example writes payloads no dialog writes.** `tutorials.mjs` `h.model()` inserts DAG nodes by
   hand:
   - Its `sketch` nodes use a legacy regions-style payload. The sketcher writes
     `{sketch, planeNodeId, externalRefs, dimensionDiagnostics}` (`Page:12280`).
   - Its `hole` node omits `seed`, `normal` and `placement`, which `HoleDialog.tsx:620` always writes.
   - None of its features enters undo history. Only the two Form Finishes, which it drives through the UI, are
     real undo steps.

   Moving the tutorials onto the command layer (work order 2b) proves the command writes what the dialog writes.
8. **Electron has no main→renderer request channel.**
   - `electron/main.cjs` has only renderer-initiated `ipcMain.handle` / `ipcMain.on`, and no `webContents.send`.
   - The server will need one new pair: main sends `liencam:agent-request {id, ...}`, and the renderer answers with
     `invoke('liencam:agent-response', id, result)`, behind the existing `event.sender` guard.
   - `liencam:save-file` (`main.cjs:1468`) always opens a Save dialog. `export_gcode` needs a variant with no
     dialog, confined to a folder the user chose.

### What is on `window` today

Counts are files that name the hook, from `src/tests/evidence` + `tools/` ("evidence") and from the rest of
`src/tests` ("tests").

| Hook | Set at | Build | Read / write | Evidence | Tests | Becomes |
|---|---|---|---|---|---|---|
| `__camStore` (whole `useCamStore`) | `src/lib/sketch/demoSeed.ts:154`, from `App.tsx:66` | DEV | write (all actions) | 297 | 9 | Phase 1 commands; machine members out of reach (below) |
| `__camUiPrefs` (`useUiPrefs`) | `demoSeed.ts:160` | DEV | write | 23 | 1 | Not a command (theme, panel widths); test helper only |
| `__seedDemoSketch`, `__seedConflict` | `demoSeed.ts:146` | DEV | write | 2 | 0 | Test fixture only |
| `__cncViewport` (the `CNCViewport` instance) | `Viewport.tsx:1442` | **prod** | read and write | 130 | 117 | Stays; `view_*` reads are built beside it (below) |
| `__camDebug` | `Viewport.tsx:1446` | **prod** | read and write | 8 | 0 | `seedToolAndSetup` → `add_tool` + `add_setup`; `setGeometryTransform` → `move_part`; the rest reads |
| `__solidsWorkbenchHooks` | `Page:15805` (deleted `:16425`) | **prod** | read and **raw write** (`dag`, `history`, `scheduler`, `client`) | 62 | 113 | Stays; Phase 2 commands plus `measure` / `find_geometry` are built beside it |
| `__formStore`, `__formOverlay`, `__formInteraction` | `src/components/model3d/form/useFormSession.ts:132` | DEV, while Form is open | store write; overlay read | 6 / 4 / 1 | 0 | `form_*` commands |
| `__reliefStore`, `__reliefSettled`, `__reliefTimings` | `src/components/model3d/relief/useReliefSession.ts:183` | DEV, while Relief is open | store write; others read | 6 / 3 / 1 | 0 / 2 / 0 | `add_feature relief`; timings stay test-only |
| `__sketchSessionStore` | `src/components/model3d/workbench/sketchSessionStore.ts:398` | DEV | read (object mutable) | 0 | 0 | Unused; stays |
| `__geo23MatrixProbe` | `Page:16401` | DEV | camera write | 33 | 0 | `view_*` (camera) |
| `__geo23AoBakes`, `__geo23EnvBakes` | `src/lib/viewport/lighting/vertexAO.ts:472`, `buildEnvironment.ts:80` | DEV | perf telemetry | 2 / 1 | 1 / 1 | Test-only |
| `__DEBUG_SCENE_IMPORT__` | `src/components/model3d/mountLab3DPage.ts:27` | DEV | boot replay | 1 | 1 | Test-only |
| `__lab3dTestHooks`, `__lab3dImportStats` | `src/components/model3d/Lab3DView.tsx:515` / `:585` | prod, lab page only | read | 0 | 0 / 2 | Out of scope (lab page) |
| `__sketch3dlabTestHooks` | `src/components/sketch3dlab/Sketch3dLabPage.tsx:157` | prod, lab page only | read | 0 | 4 | Out of scope (lab page) |
| `__ui4Hooks` | `src/components/model3d/demo/UI4Demo.tsx:340` | prod, demo page only | mixed | 0 | 1 | Out of scope (demo page) |
| `__meshlabSnapshot` | `src/components/meshlab/MeshLabPage.tsx:294` | prod, meshlab page only | read | 0 | 1 | Out of scope (lab page) |

These are not hooks, but they share the prefix:
- **Runtime singletons, internal, not commands:** `__liencamCam3dComputeGate` (`toolpathBatchScheduler.ts:39`),
  `__liencamCam3dComputeRuntime` (`index.ts:2551`), `__liencamToolpathBatchCompletion` (`index.ts:9175`).
- **Not globals:** `__liencamRightDragOrbitGate` is a marker on synthetic pointer events, and
  `__setProfileRecomputeGate` is a module export for one unit test.
- **Phantoms:** `__machineControlStore` (`WO-1289/capture.mjs:20`) and `__uiPrefsStore` (`WO-1828/capture.mjs:79`)
  are read by evidence scripts but set by nothing. Both scripts fall back to a dev import.
- **Script-owned:** about 90 `__wo*`, `__form*`, `__relief*` and `__gl*` names are set by the evidence scripts
  themselves (counters, probes, captions). They are not app hooks and need nothing from the command layer.

### Phase 1 commands: CAM strategy

Each command must call the dialog's path, not the store action beside it. Where the "Validation today" column says
**component**, that validation has to be extracted into a shared function (under `src/lib/cam/` or beside the
store) that both the dialog and the command call. A refusal from it must carry the words the dialog shows the
operator (binding rule 3, LIENCAM.md rule 11).

| Command | Store actions (`index.ts`) | Dialog path to share | Validation today | Tests today (bypass) | Undo |
|---|---|---|---|---|---|
| `project_summary`, `feature_details` | reads `project`, `toolLibrary`, `toolpathBatch`, `consoleEvents`; per-op `status`, `errorMessage`, `diagnostics`, `estimatedCutTimeMs` | What `DesignTree.tsx` / `PropertiesPanel.tsx` render. Freshness: `operationGenerationIsCurrent` (`src/lib/cam/generationFingerprint.ts:596`), `selectEnabledOperations` (`src/lib/cam/operationSuppression.ts:6`) | n/a (read) | `getState().project` at 394 sites | n/a |
| `tool_library` (read); `add_tool` / `edit_tool` | `addTool` 13302, `updateTool` 13318, `removeTool` 13355, `duplicateTool` 13404; holders `addHolder` 13426, `updateHolder` 13446, `removeHolder` 13453 | `ToolLibraryModal.tsx` `commitDraft` :393 (modal `tool-library`) | **store** (`validateToolGeometry`). Holders: **none**, not even in the component | `.addTool(` 42 calls go through the validator; **30 `setState({toolLibrary})` writes skip it** (for example `WO-226/capture.mjs:89`) | one step per action; holder edits push one step per field |
| `machine_limits` (read-only) | reads `project.machine` (`MachineConfig`, `src/types/index.ts:2052`), `controlMachine()` 9271 | `MachineLibraryModal.tsx:618` (modal `machine-config`), read side only | n/a | Tests **write** machines heavily: `setProjectMachine` 84, `addMachineToLibrary` 76, 82 `setState({machineLibrary})`. None of that becomes a command | none |
| `add_setup` / `edit_setup` / `delete_setup` | `addSetup` 17078, `updateSetup` 17089, `removeSetup` 17119; stock `addFixedStock` 16503, `updateFixedStock` 16587, `addAutoStock` 16928, `setStockFixtureOffset` 16530; workholding `makeVise` 15400, `placeClamp` 15466, `addWorkholdingInstance` 15346, `setGeometryWorkholding` 15310 | `SetupModal.tsx` `handleSave` :1083 (modals `new-setup` / `edit-setup`) | **component**: `canSave` :1064 (`fixtureStackError` :349, `projectedSetupHeights` :357, `allOffsetsUsed` :418, must-pick-stock, bore-pick, second-side/flip gates). `handleSave` also builds `originBinding` and `wcs` and auto-binds a single stock. `addSetup` accepts anything | `.addSetup(` 12 hand-built setups (`WO-257/capture.mjs:125`); **54 files write `setups` / `operations` through `setState`** | one step per action |
| `move_part` (placement for a setup) | `updateGeometryTransform` 15049, `updateModelItemPlacement` 15115 | `PropertiesPanel.tsx` `commitTransformAxis` :239 and `commitModelItemPlacementAxis` :263 (store first, then the viewport mirror) | store | `__cncViewport.setPartTransform` changes **only the picture**; `__camDebug.setGeometryTransform` goes through the store | one step |
| `add_operation` / `edit_operation` / `delete_operation` | `addOperation` 17171, `updateOperation` 17191, `removeOperation` 17263, `duplicateOperation` 23244, `reorderOperations` 17286 | `NewOperationModalBody.tsx` `handleCreate` :3843 (modals `new-operation` / `edit-operation`, button `op-create`). Delete: `DesignTree.tsx` `dispatchContextAction` :1634 → confirm → `removeOperation` | **component**: `canCreate` :3715 and the `*HeightValid` gates :3694-3712 (tool chosen, loops not empty, eligible paths, 3D part and height preview resolved, cutter supported). Payload assembly also lives here (`withRowHeightOverrides`, `withShankClearance`, `contourParamsForSave`). The store only runs `ensureOperationSmartHeightAuthority` (`src/lib/cam/smartHeights/authority.ts:144`) | Dialog driven for real (`op-create` clicked 62 times, `new-operation` opened 93 times). **`updateOperation` patches in 31 files skip the gates; `setState` injects `ready` operations with hand-built moves (`WO-1965/shoot.mjs:100`)** | one step for add, delete and authored edits (`isAuthoredOperationUpdate` 7957); result-only patches push none |
| `generate_toolpaths` | `computeOperationToolpath` 17657, `computeAllToolpaths` 23297, `runToolpathBatchQueue` (`toolpathBatchScheduler.ts:100`); cancel 17525 / 17542 / 17557 | `DesignTree.tsx:3734` (Regen All), :1641 and :3817 (one op); `useGlobalShortcuts.ts:94` | **store** (Smart Height authority, tool, enabled / degraded) | `computeOperationToolpath` 53 calls, `computeAllToolpaths` 10: already the UI path | none (results only) |
| `simulate_setup` | viewer switches only: `setStockSimEnabled` 23026, `setStockSimResolution` 23028 | `SimulationPanel.tsx` builds `VoxelSimulator` :971 / `HeightmapSimulator` :1020; `checkWorkholdingContact` (`src/lib/simulation/workholdingContact.ts`) at :754 | **component**. There is no store action and no headless path. No separate gouge or uncut-material verifier exists; gouge logic lives inside the engines (for example `src/lib/cam/holderClearance.ts`). Time comes from `estimatedCutTimeMs`, written at compute | `setState({viewer: {stockSimEnabled}})`, then a click on `mode-tab-simulation` | none |
| `export_gcode` (to a file) | `stageOperationsForEmission` 19584 | `PostProcessModal.tsx` `handleExport` :871 → `runFreshPost` :822 → `postProject` (`src/lib/post/postProject.ts:107`) → `downloadFile` :774 → `saveFile` (`src/lib/saveFile.ts:15`) → IPC `liencam:save-file` | Posting rules: **shared lib** (`src/lib/post/validate.ts`). Staging, `canExport` :802 and the combined-vs-separate file loop: **component** | `post-process` opened 44 times; **`postProject` imported directly 17 times, skipping `stageOperationsForEmission`** | none; the file write is outside the project |
| `undo` / `redo` | `undo` 16478, `redo` 16480 via `restoreSketchFromHistorySeam` 8103 | `TopToolbar.tsx:123` (keys), :238 / :248 (buttons) | n/a | `.undo(` 10, `.redo(` 1 | Entries have no label (`projectHistory: Project[]` 8332). They need one (finding 6) |

A reusable intent table already exists. `TreeMenuAction` (`src/lib/tree/treeContextMenu.ts:170`) is dispatched by
`DesignTree.tsx:1634` `dispatchContextAction`. It is a serializable union of op-edit / regenerate / duplicate /
rename / toggle-enabled / delete / move and setup-* / geo-*. The CAM delete, duplicate, rename and enable commands
should dispatch through it rather than beside it.

### Phase 2 commands: modeling

The commit paths are shared already. What stays inside each dialog is the payload assembly and the `applyDisabled`
rule. Those move into one pure builder per feature, `build<Feature>Payload(input) -> {payload} | {refusal}`, which
the dialog and the command both call.

| Command | Tests today | Dialog path to share | Validation today | Undo |
|---|---|---|---|---|
| `add_feature sketch` | `dag.insertNode(sketch)` + `fullResync` | `beginPackageSketch` `Page:12257` → `createFeatureCommand` :12331, or composite `'sketchOnFace'` :12313 | page (plane and entry logic). One path at :12336 inserts **without** undo | one step; per-gesture `SketchStepCommand` (`workbenchSketchDocumentPort.ts:85`) |
| `add_feature` / `edit_feature` extrude | `insertNode`, `setPayload`, `editEntryFor` | `ExtrudeDialog.tsx` `handleApply` :459 → create :554 / edit :522; guard `guardExtrudeApply` `Page:19182` | **component** `applyDisabled` :334 and payload. Shared: `validateFeatureExpression` (`workbench/featureDimension.ts:31`) | one step |
| revolve | same | `RevolveDialog.tsx:303` → :362 / :344; guard `Page:19510` | **component** `applyDisabled` :244 + page guard | one step |
| fillet, chamfer, shell | `insertNode` | dialog `handleApply` (`FilletDialog.tsx:138`, `ChamferDialog.tsx:126`, `ShellDialog.tsx`) → page `handleFilletPreviewApply` `Page:10507` / chamfer :10819 / shell :11145. Each adopts the previewed body inside `scheduler.adoptPreparedWithTransaction` | **component** `invalid` (Fillet :111, Shell ~:95), `editReferenceError` (`FilletDialog.tsx:64`); page checks preview fingerprint | one step |
| hole | `insertNode` | `HoleDialog.tsx:574` → :622 / :609; guard `Page:19893` | **component** (payload, `computePoints`) + page guard | one step |
| boolean | `insertNode` | `BooleanDialog.tsx:258` → :289 / :272 | **component** `invalid` | one step |
| pushPull | `insertNode`, `getPushPullTransactionState` | `handlePushPullCommit` `Page:15142` → `createDirectEditFeatureCommand` :15230 | page (fresh `editFeature` recheck; near-zero delta cancels) | one step |
| offset plane, axis, point | `insertNode(datum)` | `applyOffsetPlane` `Page:18603`, `applyAxis` ~:18323, `commitConstructDatum` ~:18440; builders in `src/components/model3d/sketch3d/datumPlane.ts:290`, `datumAxis.ts`, `datumConstruct.ts` | dialog `localError` (`OffsetPlaneDialog.tsx:99`) + page fingerprint | one step. **Undoes itself if replay fails**, the only path that does |
| `delete_feature` | `dag.removeNode` | `handleDelete` `Page:17762` | **shared** `planFeatureDelete` (`src/components/model3d/tree/featureDelete.ts:34`); genesis rows refused | one composite `'deleteFeature'` step |
| `form_*` (start from starter, symmetry, select, move, crease, finish) | tutorials: UI clicks plus `__formStore` reads; other scripts call `setStarterSegments`, `setSelection`, `beginMove` / `moveBy` / `endDrag`, `setSymmetry`, `newFromStarter` | store actions in `src/components/model3d/form/formStore.ts:415`; Finish at `useFormSession.ts:175` → create :189 / edit :186 | inside the store actions. **No replay check before Finish commits** | Form-local undo while Form is open (`Page:17340` routes there); **one model step per Finish** |
| relief | `__reliefStore` reads | `useReliefSession.ts:356` apply → pre-check `tryRelief` → :385 / :382 | kernel pre-check + store | one step |
| `measure`, `find_geometry` (read) | `client.measure` (distance, radius, angle, volume, area, length), `client.tessellate`, `getBodyFaceIds` / `EdgeIds`, `getBodyTopPoint`, `pickAt` | n/a. Note `client.measure` has **no bounding box**; tests derive one from tessellation | n/a | n/a |

Feature kinds: DAG kinds are in `src/doc/dag.ts:38` (sketch, datum, feature, body, import, meshImport, parameter).
Feature opTypes are in `src/components/model3d/bodyLineage.ts:7`: extrude, revolve, boolean, fillet, defeature,
chamfer, shell, draft, sweep, loft, hole, pushPull, resizeHole, form, relief. None of draft, sweep, loft, defeature or
resizeHole appears in the evidence scripts' inserts; they join Phase 2 on the same pattern.

**What a direct `dag.insertNode` / `setPayload` skips.** The only checks left are `FeatureDag.insertNode`'s own
(`src/doc/dag.ts:300`: genesis id, duplicate id, cycle, rolled-back producer). It skips:
- history;
- the touched-id stack;
- the rollback marker and the hidden flag;
- the dialog's rules and the preview fingerprint.

### View helpers (not project changes)

- **Reads the agent may use**, from `src/lib/viewport/CNCViewport.ts`: `worldToScreen` 5313, `getStockBounds` 7924
  and `getDepthFitRefusal` 4801.
- **Camera only:** `setCameraView` 4962, `fitAll` 4953 and the `__geo23MatrixProbe` pose calls. They change no
  project data. They are fine as `view_*` tools, but they are not needed for Phase 1.
- **Test tools, never agent commands:** `addSTL`, `setPartTransform`, `setPartWorkholding` (recolours only),
  `rebuildStock`, `renderToolpath` and `clearScene`. Each changes only the picture, not the store. They stay for
  tests.

### Out of reach, forever (binding rule 1)

No hook above imports `src/lib/machine/` or `pendant/`, and no product module puts a machine store on `window`.
Motion is reachable in three ways. The command layer and the MCP server must never offer any of them.

**This is about the agent path only.** The machine seat moves the machine at the operator's CNC on his go, through the
app's own buttons over the debugging port, and it keeps doing so unchanged (ruling 4). Nothing below removes,
gates or changes any of these paths for internal development.

1. **Machine members of `__camStore`.** No camStore action moves the machine, but these fields feed motion that is
   already live:

   | Member | How it reaches motion |
   |---|---|
   | `machineWorkOffsets`, `setMachineWorkOffset` 13138, `setMachineWorkOffsetLabel` 13157 | Written back to the controller when it reopens (`src/lib/machine/machineSession.ts:11805` `restoreWorkOffsetsAfterControllerReopen`) |
   | `machineDatumRevokedAxes`, `revokeMachineDatum` 13174, `clearMachineDatumRevocation` 13185 | Clearing one removes a "not homed" guard (`machineSession.ts:11436`) |
   | `machineLibrary`, `addMachineToLibrary` 13105, `updateMachineInLibrary` 13110, `removeMachineFromLibrary` 13197, `setDefaultMachineId` 13095 | `machineRecord()` (`machineSession.ts:10489`) reads these live, including spindle `directionInverted` and `spindleDrive` |
   | `project.machine`, `setProjectMachine` 13210, `updateMachine` 13297 | `controlMachine()` (`index.ts:9271`) falls back to them for rapid rate, max spindle RPM, home axes and safe Z |
   | `control`, `setControlMachineId` 13244, `setControlSessionMachine` 13249, `confirmControlSessionDefinition` 13260, `confirmControlSessionSpindleLinkDefinition` 13282, `updateControlSessionToolRecord` 13230 | They set the session machine that motion authority reads |
   | `setMachineChoiceRequired` 13100 | A UI gate only, but machine-scoped; not exposed |

   `machine_limits` returns a frozen copy of `project.machine`, and no command writes any of these.
2. **The machine stores and `src/lib/machine/`.** These are `machineControlStore.ts`, `machineActionsStore.ts`,
   `machineToolTableStore.ts`, `probeRoutineStore.ts` and `machineSession.ts`.
   - Evidence scripts reach them only through Vite-dev imports: 121 scripts import `/src/lib/machine` or
     `/src/store/machine*`.
   - The command layer imports none of them.
   - A lint rule (for example `no-restricted-imports` scoped to `src/lib/agent/` only) makes that mechanical.
   - The evidence scripts keep their imports.
   - `src/lib/gcode/appCommand.ts` is the machine G-code sender. Despite its name it is **not** a command-layer
     precedent.
3. **Electron.** Every one of these is machine-side, and the MCP server may call none of them:
   - `liencam:machine-bridge-status` (`main.cjs:1408`), `-ready` (:1426), `-remember` (:1445) and `-restart`
     (:1449);
   - `liencam:choose-machine-path` (:1453) and `liencam:set-job-wake-lock` (:1482);
   - the pendant-broker protocol routes `liencam://app/__liencam/pendant-broker/{start,stop}` (:1310);
   - the bridge spawns: the pendant broker at :391 and `liencam-bridge.exe` at :1092;
   - `__liencamBridgeLifecycleInstalled` (`useMachineDefinitionPanel.tsx:327`) is a once-flag for the Connect
     click. It stays out of the agent's path.

   The server's only file write is `export_gcode`'s, through a new channel that does no dialog and writes only
   inside the export folder.

### What work order 2 has to build first (from this inventory)

1. **Extract the component-only rules into shared, pure functions that return the dialog's own words.** The
   dialogs switch to them in the same change:
   - setup: `canSave` + `handleSave` assembly;
   - operation: `canCreate`, the height gates and payload assembly;
   - post: staging, `canExport` and the file loop;
   - simulation: a headless run.
2. **Stop product code reading hooks** (finding 2). Hole recognition and delete-undo import the workbench session
   directly. Stock bounds come from the store, not the viewport.
3. **Label CAM history entries** so each agent call is one step named for what it did (finding 6).
4. **Build `src/lib/agent/commands.ts`**:
   - an allow-list of the Phase 1 commands above;
   - no machine member, no `setState`, no raw `dag`;
   - exposed to Playwright in DEV and test builds as `window.__liencam`, beside `__camStore` and `__camDebug`.
5. **Remove nothing** (ruling 4):
   - Every hook stays installed as it is today, in the dev and production builds alike.
   - Every evidence script, and every machine-seat script, runs unchanged.
   - A dialog whose rules are extracted must look, refuse and save exactly as before.

## Work orders the architect could file

1. **Command-layer inventory:** every `window` hook the tests and evidence scripts use, grouped into commands, with
   the dialog path each one should share. No code. Done 2026-09-30: the inventory section above.
2. **Command layer v0:** the Phase 1 CAM commands (read, setup, operation, generate, export to file), with tests.
   Each command's own tests are the proof. Existing evidence scripts stay as they are (ruling 4).
2b. **Command layer v1:** the Phase 2 modeling commands. The tutorial recorder runs on them as the proof; the old
   recorder stays.
3. **The ADR:** the binding rules above, and where the server lives. Draft text: `docs/design/AGENT-MCP-ADR-DRAFT.md`.
4. **MCP server v0 (Electron):** Phase 1 tools, off by default, with a Settings switch and an indicator.
5. **An agent evaluation set:** a handful of prompts ("rough this pocket with my 6 mm end mill", "add four M5
   clearance holes to the plate") run against the server. It must keep passing.

## Open questions

None open with the operator; his three rulings are above. Left for the ADR: whether a per-change confirm is offered as a
user setting (the operator's default is direct edits), and how the agent's changes are grouped for one undo.

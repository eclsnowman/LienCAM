# 0055 - An AI agent works in the user's project through the command layer, never the machine

Date: 2026-09-30
Status: Accepted 2026-09-30 (the rulings are the operator's; the two defaults marked "(default, reversible)" are the architect's under rule 3)
Related: ADR-0040 (no legacy before 1.0), ADR-0041 (LienCAM speaks its own machine language; controllers are
backends)
Authority: Operator ruling 2026-09-29, three rulings on `docs/design/AGENT-MCP.md`:
1. "Start with the electron desktop app only."
2. "change the project"
3. "I want cam strategy and modeling. If we have to pick one start with CAM, but closely followed by the modeling."

And one ruling of 2026-09-30:
4. "Just make sure this mcp addition doesn't break how we use it for internal development. Because I am fine with
   the current "go" implementation i have to work collaboratively with the machine session on my cnc. This is meant
   to add functionality, not remove things we need on our end."

## Context

the operator wants two things. The first is "someone using our software to model something for them driven by an AI
agent". The second is "an ai agent be able to develop a machining strategy for them with the tools they have
defined". The Model Context Protocol (MCP) is the standard way for a program to offer an AI agent named, typed
tools. Claude Desktop, Claude Code, Codex and Cursor all speak it.

Today an agent can drive LienCAM only the way the test suite does. The inventory of 2026-09-30 (`AGENT-MCP.md`,
"Command-layer inventory") found five problems with that:

- **Hooks.** There are about 20 `window.__*` hooks.
  - `__camStore` hands out the whole CAM store (DEV only).
  - `__solidsWorkbenchHooks` hands out the raw feature DAG, history and scheduler.
  - `__cncViewport` hands out the whole viewport object.
  - The last two ship in production builds.
- **Imports and direct writes.** 236 evidence scripts import `/src/...` modules straight from the dev server.
  185 files write store state directly through 272 `setState` calls.
- **Validation lives in components.** Most of it sits inside dialog components (`SetupModal`,
  `NewOperationModalBody`, `PostProcessModal`, `SimulationPanel`, and the feature dialogs), so every hook path
  skips it.
- **Undo is uneven.** CAM undo entries carry no label. A direct DAG insert writes no undo step at all.
- **Motion is within reach.** `__camStore` reaches machine motion indirectly:
  - stored work offsets are written back to the controller when it reopens;
  - clearing a datum revocation removes a "not homed" guard;
  - the machine library and `project.machine` feed rapid rate, spindle RPM, home and safe Z to the live session.

## Decision

### 1. Desktop only (the operator's ruling 1)

The MCP server lives in the Electron main process (`electron/`). The web build has no MCP server.

The server speaks two transports:
- stdio, when an MCP client launches LienCAM;
- HTTP bound to `127.0.0.1`, when a client attaches to a running LienCAM.

It is off until the user turns it on in Settings. While a client is connected, the app shows a visible indicator
naming the client.

### 2. No machine motion through the MCP server, ever

**Scope.** This rule governs the MCP server and the command layer it calls, nothing else. It does not govern the
machine seat. That session drives the Electron app at the CNC over the Chromium debugging port, through the app's
own buttons, and moves the machine only on the operator's go (`docs/machine/MACHINE-SEAT-HANDOFF.md`,
`.claude/skills/machine-session/`). Decision 7 keeps it exactly as it is.

The server offers modeling, CAM planning, simulation and G-code export to a FILE, and nothing else. Sending a job,
jogging, probing, spindle control, the Control and Probing screens, and anything that runs the machine bridge stay
human actions at the machine.

This is not a user setting, and no Settings switch lifts it. Four mechanical checks enforce it:

1. **Allow-list.** The server can call only the commands the command layer exports. It exports nothing that writes
   `machineWorkOffsets`, `machineDatumRevokedAxes`, `machineLibrary`, `project.machine`, `control` or any
   `setControlSession*` member. `machine_limits` returns a frozen copy of `project.machine`.
2. **Import ban.** A lint rule (`no-restricted-imports`) on `src/lib/agent/` forbids importing:
   - `src/lib/machine/`;
   - `src/store/machine*`;
   - `src/store/probeRoutineStore`;
   - `src/lib/gcode/appCommand`;
   - `pendant/`.
3. **Main process.** The server code may not call the `liencam:machine-bridge-*`, `liencam:choose-machine-path` or
   `liencam:set-job-wake-lock` channels, the pendant-broker routes, or the bridge spawns. A test asserts this.
4. **Files only.** `export_gcode` writes a file inside the export folder the user chose when turning the server on.
   It never writes anywhere else, and never overwrites without saying so in its result.

### 3. One command layer, shared by dialogs, tests and the agent

`src/lib/agent/` holds typed commands. Each one goes through the same code path the matching dialog uses. For each
command, the dialog-path column of the inventory names that path.

The command layer rests on three rules:
- **Shared validation.** Where the dialog's rules live only inside the component, they are extracted into a pure
  shared function. The dialog and the command both call it, in the same change. There is one rule and one set of
  words.
- **No shortcuts.** A command never writes store state with `setState`, never touches the raw DAG, and never
  changes the viewport's scene.
- **Tests can use it too.** In DEV and test builds the same layer is also exposed to Playwright as
  `window.__liencam`, beside the existing hooks. Each command gets its own tests. The Form tutorial recorder is the
  first script to run on it, as the proof that a command writes what the dialog writes. Other scripts may move onto
  it when that is convenient; none has to.

The command layer is an addition. It replaces nothing (decision 7).

### 4. The agent edits the project directly (the operator's ruling 2)

The agent changes the user's visible project and does not only propose. Each change lands in the tree as the same
change a dialog makes, so the user can review it and undo it.

- **One call, one undo step.** Each successful tool call is exactly one undo step, labelled for what it did, for
  example "Agent: add Adaptive Clearing, 6 mm end mill". CAM history entries gain a label for this. Model history
  entries already carry one.
- **All or nothing.** A call that is refused or fails changes nothing and leaves no step.
- **No per-change confirm** **(default, reversible).** v0 has no per-change confirm and no user setting for one.
  the operator's default is direct edits, and undo is the review. If the operator wants a confirm mode later, it is a setting added
  on top of this layer.
- **No multi-call transactions** **(default, reversible).** One tool call is one step, and v0 has no transactions
  across calls. The agent can call `undo`. A change that has to be atomic becomes one command.

### 5. The app's own words

Tool names and parameters mirror the dialogs' fields and units. A refusal returns the same message the operator
would see from that dialog. No refusal wording is invented for agents.

LIENCAM.md rule 11 applies in full. A command refuses only what the software cannot do, and never refuses what the
dialog would accept. Results report what was done in the dialog's terms. Toolpath failures come back in the same
words the tree shows.

### 6. CAM strategy first, modeling close behind (the operator's ruling 3)

**Phase 1** is CAM strategy with the user's own tools:
- `project_summary`, `feature_details`, `measure`, `find_geometry`;
- `tool_library`, `machine_limits` (read);
- `add/edit/delete_setup`, `move_part`;
- `add/edit/delete_operation`;
- `generate_toolpaths`, `simulate_setup`;
- `export_gcode` (to a file);
- `undo` / `redo`.

**Phase 2** is modeling, and follows straight after:
- `add/edit/delete_feature` for sketch, extrude, revolve, fillet, chamfer, hole, shell, boolean, pushPull, datums
  and relief;
- the `form_*` cage commands.

### 7. Additive only: internal development keeps every tool it has (the operator's ruling 4)

The MCP server and the command layer add a way in. They take nothing away. All of the following stay exactly as
they are, in both the dev build and the production (Electron) build:

- **The machine seat's way of working.**
  - It launches Electron with `--remote-debugging-port=9222`.
  - It drives the app with Playwright over the debugging port, through the app's own buttons and `data-testid`s,
    and reads the DOM.
  - the operator's go governs every block of motion.
  - The Electron machine channels (`liencam:machine-bridge-*`, `liencam:choose-machine-path`,
    `liencam:set-job-wake-lock`), the pendant broker and the bridge spawns stay.

  The MCP server does not start unless it is switched on. When it is on, it does not use port 9222 or the bridge
  ports 8324 and 8325.
- **Every `window.__*` hook** stays, where and how it is installed today: `__camStore`, `__camDebug`,
  `__cncViewport`, `__solidsWorkbenchHooks`, the Form and Relief hooks and the rest. That includes the two that
  ship in production builds. They are reachable only from inside the renderer (DevTools, or the debugging port),
  never from an MCP client.
- **The evidence scripts' dev imports** (`import('/src/...')`, including the machine stores and
  `src/lib/machine/`) and their direct `setState` writes. Rehearsals and desk proofs keep using them.
- **The `data-testid`s and dialog behaviour** that scripts click. Extracting a dialog's rules into a shared
  function is a refactor: the dialog must look, refuse and save exactly as before, and its existing tests are
  the check.

The machine-motion ban in decision 2 stops the MCP server. It does not reach into any of the above. The import ban
in decision 2 applies to `src/lib/agent/` only, never to tests, evidence scripts or the machine seat's scripts.

Product code that reads a hook today can switch to a direct import when a command needs it (for example, stock
bounds that do not depend on the 3D view). The hook itself stays installed.

## Alternatives considered

- **Let the agent drive the screen** (clicks and screenshots). Rejected: it is fragile, slow and untyped, it
  breaks on every layout change, and it cannot report results in the app's terms. The brief's premise is that the
  agent "never drives the screen".
- **Expose the existing hooks or stores over MCP.** This would be fastest. Rejected: it skips most dialog
  validation, writes no undo, and reaches machine motion through the machine members of the CAM store.
- **Propose-only (the agent drafts, the user applies).** Rejected by the operator's ruling 2 ("change the project").
- **An MCP server in the web build, or a remote server.** Rejected by the operator's ruling 1, and by the local-only rule.
  A localhost port is what a desktop client needs.
- **A separate validation layer written for agents.** Rejected. It would diverge from the dialogs and give the
  operator and the agent different words for the same refusal (rule 11).
- **Replace the hooks and dev imports with the command layer** (the first draft of this ADR). Rejected by the operator's
  ruling 4: the tests, the evidence scripts and the machine seat depend on them, and the MCP work exists to add
  capability, not to take any away.
- **Let the user switch machine access on in Settings.** Rejected. A switch is a door that is sometimes left open.
  Motion stays a human action at the machine.

## Consequences

**Good:**
- One tested path serves the user, the tests and the agent.
- Nothing internal development uses is removed or changed: hooks, dev imports, the debugging-port launch, the
  machine seat's scripts.
- The extracted validators make the dialogs themselves simpler to test.

**Costs:**
- **Extraction lands before the tools.** Pulling the rules out of `SetupModal`, `NewOperationModalBody` (over
  10,000 lines), `PostProcessModal`, `SimulationPanel` and eight feature dialogs is the bulk of the work. It has to
  land before the MCP tools do.
- **Some commands run a preview first.** Fillet, chamfer and shell commit the body a preview already built, so
  those commands must run the preview and then commit. They are asynchronous and take as long as the dialog does.
- **Simulation needs a headless path.** None exists today.
- **Stock bounds move to the store.** Toolpath compute reads stock bounds from the viewport today. They must come
  from the store so a command gives the same answer with the CAM view closed.
- **Undo still follows the workspace.** CAM and modeling keep their two histories. An agent's step lands in the one
  for the workspace it changed, and the Undo button follows the active workspace as it does today.
- **Electron gains two things.** One main→renderer request channel (it has none today), and a save-file variant
  that shows no dialog and writes only inside the export folder.
- **No test churn is required.** 345 evidence scripts and 239 other test files name a hook, and they keep working
  unchanged.
- **Two ways in, by design.** The hooks can still reach state that no command allows, including the machine
  members. That is acceptable, because only someone with DevTools or the debugging port on the local machine can
  reach them. The MCP server cannot.

## References

- `docs/design/AGENT-MCP.md`: the brief, the operator's rulings, and the command-layer inventory (2026-09-30).
- `electron/main.cjs` (IPC block from :1408, bridge spawn :391 / :1092); `electron/preload.cjs`.
- `src/store/index.ts`: `pushHistory` 16410, and the machine members at 13095-13297.
- `src/lib/machine/machineSession.ts:10489`, `:11436`, `:11805`: where the CAM store's machine members reach
  motion.
- `src/components/model3d/dialogs/createFeatureCommand.ts`, `EditFeaturePayloadCommand.ts`; `src/doc/commands.ts`.
- `src/lib/tree/treeContextMenu.ts:170`: the existing serializable intent table for tree actions.
- LIENCAM.md rules 5 and 11.

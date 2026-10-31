# Architecture overview

This page is the pipeline from sketch to post in one read. The full reference is `docs/ARCHITECTURE.md` in the source tree; the [Code tour](Code-Tour) shows where each piece lives.

## The idea

LienCAM is a browser CAM application with no backend. Everything, including every toolpath, is computed on your own computer. Two decisions shape the whole code base:

- **Planning is separate from G-code.** An operation produces controller-neutral moves (`ToolpathMove[]`: where the tool goes, what kind of move it is, what feed). A separate post-processor turns those moves into the dialect your controller reads. Operation code never knows which controller you own.
- **The worker boundary is deterministic.** An operation receives a payload and returns moves. It does not reach outside itself. That makes operations testable on their own and keeps heavy computation off the screen thread.

## From sketch to post

1. **Geometry in.** You draw in Sketch, shape a solid in Model or Form, or import DXF, SVG, STL, STEP or IGES files. Imports are in `src/lib/import/`; the solid kernel is described in [Geometry kernel build](Geometry-Kernel-Build).
2. **Project state.** The project (parts, setups, stock, tools, operations) lives in one store in `src/store/`. The store resolves heights, builds the payload for each operation and sends it to a worker.
3. **Worker.** `src/lib/cam/toolpathWorker.ts` receives the message for a 2.5D operation, picks the operation by type and posts back the moves, or an error, or progress. 3D operations go to their own worker, `src/cam3d/worker/cam3dWorker.ts`.
4. **Operations.** Each 2.5D strategy (contour, pocket, drill, adaptive clearing and the rest) is a function in `src/lib/cam/` that turns a payload into moves; the 3D strategies (roughing, parallel, waterline, scallop, pencil, rest) live in `src/cam3d/` and run in their own worker, `src/cam3d/worker/`. They share subsystems for heights, feeds and speeds, entry moves and linking instead of each reimplementing them.
5. **Simulation.** The simulator in `src/lib/simulation/` replays the moves against the stock so you can see the result before you cut.
6. **Post.** `src/lib/post/` takes the moves and the machine definition and writes G-code for the chosen dialect (UCCNC, GRBL and grblHAL, LinuxCNC and others).
7. **Control.** For machines LienCAM can drive directly, `src/lib/machine/` sends the program and shows the controller's state.

## The five layers

| Layer | Folder | Job |
| --- | --- | --- |
| UI | `src/components/` | Draws panels and the viewport, reads input, dispatches actions |
| State | `src/store/` | Holds the project, builds worker payloads |
| Worker | `src/lib/cam/toolpathWorker.ts` (2.5D), `src/cam3d/worker/` (3D) | Routes each request to an operation |
| Operations | `src/lib/cam/` (2.5D), `src/cam3d/strategies/` (3D) | Payload in, moves out |
| Shared subsystems | `src/lib/cam/<subsystem>/` | Heights, feeds, entries and geometry used by every operation |

## Where to read next

- [Code tour](Code-Tour) for folder names.
- [Testing](Testing) before you change anything.
- The [Post-processors](Post-Processors) page for what the last step produces.

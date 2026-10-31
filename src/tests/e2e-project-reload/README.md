# WO-243 real-browser reload proof

Run from the repository root:

```powershell
node src/tests/e2e-project-reload/reload-smoke.mjs
```

The script follows the existing `e2e-sketch2d` pattern: it starts a private
Vite server, launches real headless Chromium, installs Chromium once if needed,
and kills the server process tree on exit. It creates a small in-memory
`.camproject` fixture with the same decisive facts as Operator's 3.1 MB file:

- one STEP geometry persisted with `loaded: true` and `hidden: false`;
- raw STEP bytes plus a digest-matching portable display payload;
- one operation whose geometry selection points at that STEP part.

The source STEP is the existing 15 KB `src/tests/geom/fixtures/no-attributes.step`;
Operator's downloaded project is never copied or committed.

The proof opens the fixture through the real hidden file input, verifies that
the initial File -> Open scene contains a visible Three.js mesh, waits until the
project is durably persisted, reloads the browser, and then checks both sides of
the original symptom: the tree/store row survived and the scene contains an
attached, visible mesh with vertices. It also proves the operation and its STEP
geometry selection survive, so the existing recompute path remains available.

`--capture-before` is a one-time diagnostic mode used to create `before.png`
against the known-broken revision. It expects the hydrated row to exist while
the scene mesh is absent. Normal runs write `after.png` and require the mesh.

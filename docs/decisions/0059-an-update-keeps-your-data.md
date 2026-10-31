# 0059 - An update keeps your data: user data survives every app update, even before 1.0

Date: 2026-10-17
Status: Accepted 2026-10-17 (WO-2883)
Related: ADR-0040 (no legacy project support before 1.0), ADR-0045 (Electron is the packaged desktop host),
ADR-0057 (your data always leaves with you)
Authority: WO-2883 point 4, the architect's scoping of the operator's ask. His words: "do we have away on the software
for it to update so the software can pull the latest version from releases as we release new versions?" (2026-10-09
~11:05 PM CT chat) and "Yes, get the update into alpha.3 and don't forget this time." (2026-10-16 ~4:10 PM CT chat).
The order reads: "an update never drops or resets the operator's settings, machine record, tool library, probing setup
or recent projects. Write the rule as an ADR beside ADR-0040."

## Context

From alpha.3 the desktop app downloads a newer published release, checks it against the release's SHA-256 sums and
installs it on the operator's word (WO-2883; electron/update/). Until now an update was something the operator did by
hand, rarely, after taking a backup. Once the app offers it at every start, an update is routine, and anything an
update loses is lost from every operator who clicks Install.

ADR-0040 says no old PROJECT FILE has to keep working before 1.0. It is sometimes read more widely than it says: as if
anything stored by an older build may be dropped. That reading is wrong, and an updater makes it dangerous. A project
file is a document the operator saved and can re-make; a format break costs him one re-save. His machine record, tool
library, probing setup and settings are his shop: hours at the machine to measure and prove. Losing them on update
means re-measuring a machine he already proved, and a wrong value quietly carried into that re-measurement is a crash,
not a nuisance.

Where the data lives decides what an update can break. The desktop app keeps it in two places, both under one folder:

- Electron's userData folder. Electron names it after `productName` (`LienCAM`): `%APPDATA%\LienCAM` on Windows,
  `~/.config/LienCAM` on Linux, `~/Library/Application Support/LienCAM` on macOS. `LIENCAM_USER_DATA_DIR` overrides it
  for tests and scratch profiles only (electron/main.cjs).
- The renderer's storage for the app origin. The window loads from the custom scheme `liencam://app`
  (`APP_SCHEME = 'liencam'`, `APP_HOST = 'app'` in electron/main.cjs). localStorage, IndexedDB and OPFS are keyed by
  that origin and stored inside the userData folder. Change the scheme or host and the new build opens an empty origin:
  every value is still on disk and none of it is reachable.

Nothing in the renderer can detect either break; the app would start clean and look healthy.

## Decision

1. **Before 1.0 a project FILE still need not survive a format change (ADR-0040 stands). USER DATA must survive every
   app update**: the update from any published release to any newer one keeps every stored value below, unchanged
   unless the new build deliberately migrates it (rule 4).
2. **The identity that locates user data never changes in an update.** Every release keeps:
   - `appId: com.liencam.desktop` (electron-builder.yml) - the Windows installer's identity and uninstall key;
   - `productName: LienCAM` (electron-builder.yml) - the userData folder name;
   - the app origin `liencam://app` (`APP_SCHEME`, `APP_HOST` in electron/main.cjs, and the
     `protocol.registerSchemesAsPrivileged` entry that makes it a standard, storage-capable origin);
   - the userData location itself: no `app.setPath('userData', ...)` in a shipped path other than the
     `LIENCAM_USER_DATA_DIR` test override, and no `app.setName` that renames it.
   Changing any of these is a data migration (rule 4) and needs its own ADR, never a side effect of another change.
3. **The installer never deletes app data.** The NSIS option `deleteAppDataOnUninstall` stays off (unset or `false`),
   since an update over an installed copy runs the previous version's uninstaller first. The AppImage route replaces
   only the AppImage file; the portable, tar.gz and macOS routes replace nothing. Nothing in the update route writes to, cleans or moves the userData folder. Its downloads
   go to the operating system's temp folder (`LienCAM-updates/<version>` under Electron's `temp` path, e.g.
   `%TEMP%\LienCAM-updates` on Windows), never under userData.
4. **A store-key change reads the old key and keeps its value.** A renamed key, a reshaped record or a new storage
   backend ships with a read of the old key that carries its value into the new one, and the old key is drained only
   after the new one is written (the pattern `PERSISTED_USER_DATA_REGISTRY` already uses: `legacyKeys`, and
   `activeProject` kept on its original spelling `cnc-cam-project`). A new field gets a default only where the stored
   record has no value for it. "No legacy before 1.0" is never a reason to skip this read.
5. **A test pins rules 2 and 3**: `src/tests/lib/update/keepsUserData.wo2883.test.ts` reads electron-builder.yml,
   package.json and electron/main.cjs and fails by name if `appId`, `productName`, the scheme or host, the userData path
   or `deleteAppDataOnUninstall` changes. Changing one deliberately means changing the test and this ADR together.
6. **The oracle is the measured diff, not the test.** Before a release that changes the update route or any store, an
   update runs from one local build to a newer local build (or a private test release) on a scratch copy of a real
   profile (`LIENCAM_USER_DATA_DIR` pointed at the copy), with a before/after diff of every stored value: every
   localStorage and OPFS leaf, the userData files below, and IndexedDB where the tool can read it. Every difference is
   named and explained, as the alpha.2 board check did. This is a MACHINE-TEST kit row for the machine seat; the
   unit test only guards the identity.

### What user data is (the inventory)

Seeded from the alpha.2 board check (2026-10-16, `src/tests/evidence/ALPHA2-BOARD-2026-10-16/README.md` prep step 2 and
`store-diff-base-vs-a2.json`): the operator's real store, read through his 13f87e514 launcher, the installed alpha.2,
and his launcher again - 45,221 OPFS and localStorage leaf values, 8 differences, all explained. That is the baseline
an update diff is judged against.

| Where | What | Kept across an update |
|---|---|---|
| OPFS, durable user space (`liencam-user-space--*`, collections in `PERSISTED_COLLECTIONS`, src/store/userSpaceStorage.ts) | preferences (`appSettings`); machines (`machineLibrary`, `control`, `machineWorkOffsets`, `machineDatumRevokedAxes`); tool libraries; holders; imported fonts; recipe templates; post profiles; cutting data; fixtures; probing routines; controller profiles and macros | every value |
| OPFS, active project generations (`cnc-cam-project` pointer, pointer-backup, previous generation) | the open project and its one-step recovery copy | the project and its recovery copy; the generation POINTER ids are rewritten on every load by every build (4 of the 8 alpha.2 differences) |
| localStorage (keys in `PERSISTED_USER_DATA_REGISTRY`, src/store/persistedKeys.ts) | UI preferences `liencam-ui-prefs`; program preview grid; saved posts `liencam.userPosts`; machine actions, macros and parks `liencam-machine-actions`; probe routine library `liencam-probe-routine-library`; legacy tool table `liencam-tool-table` (read-only); boot mirror; unload journal | every value; a new build may ADD a UI pref with its default (3 of the alpha.2 differences: `programListingColours`, `projectOpenDirectly`, `diagnosticHistoryRecording`); the saved camera's project id follows the open project (1 difference) |
| IndexedDB (app origin) | cached STEP bytes for B-rep reload | kept; a missing cache entry is the known harmless "B-rep reload failed ... cached STEP bytes are missing" line (operator 2026-10-07), not a loss. Not compared by the alpha.2 diff (tool limit) - owed in the WO-2883 diff |
| userData `machine-bridge-launch-settings.json` | the machine bridge and phone connection settings: UCCNC install root, profile, board, VFD definition, bridge port | every value |
| userData `recent-projects.json` | recent projects | every entry |
| userData `machine-bridge/` | the bridge built against this PC's UCCNC install, its build manifest and log | may be rebuilt by a newer build when the bridge sources change; never required to survive, never deleted by the installer |

A new kind of user data is added to this table, to `PERSISTED_USER_DATA_REGISTRY` or `PERSISTED_COLLECTIONS`, and to
the update diff in the same work order that adds it (the same rule ADR-0057 sets for its export).

## Alternatives considered

**Extend ADR-0040 to say "nothing stored need survive".** Rejected. It would make every update a factory reset of the
shop. The operator has one machine record proved over weeks of sessions; re-entering it from memory is the error we
exist to remove.

**Rely on the backup and restore (Settings > User Data) across updates.** Rejected as the mechanism, kept as the
habit. Restore works, but an update the operator clicks at start must not depend on him having taken a backup first,
and a restore after a silent wipe only helps if he notices the wipe.

**Move user data to a versioned folder per release and copy forward.** Rejected. It doubles the data on disk, makes
the copy step a new way to lose data, and breaks the portable build's sharing of `%APPDATA%\LienCAM` with an installed
copy, which the Install wiki page promises.

## Consequences

- Rename the product, the app id or the scheme only with a migration that moves the userData folder and the origin's
  storage, its own ADR, and a measured diff. Until then they are frozen.
- Reviews treat "this drops or resets a stored user value on update" as a PRODUCT defect from alpha.3 on; "this breaks
  an old project file" stays a NOTE under ADR-0040.
- The release gates owe the update diff row for any release that touches the update route or a store (added to the
  public-release skill's gate list by the order that next edits it).
- The WO-2883 update route creates and removes files only in its download folder under the OS temp folder, plus, on the AppImage route, the staged `<AppImage>.update` beside the AppImage it replaces; it never touches userData.

## References

- electron/main.cjs - `APP_SCHEME`, `APP_HOST`, `registerSchemesAsPrivileged`, `LIENCAM_USER_DATA_DIR`,
  `machineBridgeSettingsPath`, `machineBridgeDataDirectory`, `recentProjectsPath`.
- electron-builder.yml - `appId`, `productName`, the `nsis` block.
- electron/update/updater.cjs - the update route (WO-2883).
- src/store/persistedKeys.ts - `PERSISTED_USER_DATA_REGISTRY`; src/store/userSpaceStorage.ts - `PERSISTED_COLLECTIONS`.
- src/tests/lib/update/keepsUserData.wo2883.test.ts - the identity pin.
- src/tests/evidence/ALPHA2-BOARD-2026-10-16/ - the seed inventory and its diff.
- src/tests/evidence/WO-2883/proof-plan.json - the update journey (s1-s8) whose stored-value diff is this ADR's oracle.

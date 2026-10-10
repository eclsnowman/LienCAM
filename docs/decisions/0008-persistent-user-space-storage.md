# 0008 — Persistent user-space storage

Date: 2026-05-18
Status: Proposed

## Context

The current persistence stack is a two-layer arrangement: `localStorage` holds project metadata (the `project` slice under key `cnc-cam-project`) and IndexedDB holds binary geometry — raw STL `ArrayBuffer` values via `stlCache.ts` and computed 2D loop arrays via `geometry2dCache.ts`. This arrangement was chosen for practical reasons: localStorage is synchronous and JSON-friendly; IndexedDB handles large binary values. Neither was intended as the long-term answer for user-space storage.

`localStorage` has a browser-enforced capacity of approximately 5 MB. As the tool library and machine library grow with a real shop's tooling, and as the library-scope model (ADR 0007) takes effect — persisting library-scoped entities separately from any individual project — library data alone may approach or exceed this limit before any binary geometry is considered. localStorage is not a viable storage substrate for the library-scoped persistence that ADR 0007 requires.

The IndexedDB layer solves binary size but introduces its own fragility: IndexedDB is per-browser and per-origin. A project file that references geometry by ID depends on that ID existing in the current browser's IndexedDB. Transporting a project to a different browser, opening it in incognito mode, or clearing site data all silently break the geometry references. The project appears to load but renders without geometry. This is the cross-browser portability fragility documented in docs/UI-ARCHITECTURE.md §5.5.

Two browser APIs address these limitations without requiring a backend. The **Origin Private File System (OPFS)** provides browser-managed persistent file storage at the origin — durable across sessions, with capacity well above localStorage limits, and accessible without a user permission prompt. The **File System Access API** allows the user to explicitly designate directories or files in their local file system, producing user-visible, portable files at the cost of an explicit user permission on each new directory.

## Decision

Library-scoped and user-scoped persistent entities (defined in ADR 0007) use a two-layer storage mechanism:

**OPFS as the primary storage layer.** The tool library, machine library, and user preferences are stored in OPFS for day-to-day use. OPFS is durable across sessions, has no practical capacity limit for these use cases, and requires no permission prompt from the user. It replaces the current localStorage usage for library data and provides a more appropriate substrate than IndexedDB for structured, frequently-accessed library entities.

**File System Access API for explicit export and import.** When the user explicitly saves a `.camproject` file, exports a tool library, or imports from an external source, the File System Access API provides access to user-chosen locations in the local file system. This produces user-visible, portable files that the user can copy, share, or back up using normal file system operations. The File System Access API is the export/import path; OPFS is the day-to-day working layer.

**The storage layer is designed as substitutable.** The interface between the application and the storage layer does not encode OPFS directly. The same interface can be implemented later with a backend if requirements change — the door is deliberately left open without walking through it. This preserves the no-backend principle for this milestone while avoiding a structural lock-in that would require a rewrite if a backend becomes necessary.

**The existing IndexedDB binary geometry caches migrate to OPFS.** The `stlCache.ts` and `geometry2dCache.ts` IndexedDB caches are replaced by OPFS storage as part of this work. Additionally, per ADR 0007, binary geometry is embedded directly in `.camproject` files at save time, eliminating the ID-reference-only pattern that created the cross-browser fragility.

## Alternatives considered

**OPFS only — no File System Access API.** Use OPFS for everything, including saved project files. Rejected: OPFS is per-origin and not user-visible. A project saved only to OPFS is not portable — the user cannot copy it to a USB drive or share it with a colleague. The File System Access API provides the user-visible portability that project files require.

**File System Access API only — no OPFS.** Require explicit user permission for all persistent storage. Rejected: File System Access API permission prompts are per-directory and per-session on some browsers. Using it for daily tool library access would require repeated permission friction with no user benefit. OPFS is the right substrate for library data that the user should not need to think about.

**IndexedDB only — extend the status quo.** Keep the existing IndexedDB approach and expand its use to cover library-scoped entities. Rejected: IndexedDB does not solve the per-browser portability fragility that is the primary motivator. Extending it would deepen the dependency on a substrate that is already causing user pain.

**Backend for library storage.** Persist library-scoped entities to a server, accessible from any browser with a user account. Rejected: the no-backend architectural principle is in effect for this milestone. The substitutable storage interface leaves this as a viable future decision if requirements change.

## Consequences

**Positive:**
- Library-scoped data persists across sessions and across localStorage limits without user-visible file management friction.
- Cross-browser portability fragility is resolved: `.camproject` files embed binary geometry (per ADR 0007); OPFS replaces the per-browser IndexedDB as the day-to-day geometry cache.
- The substitutable storage interface positions the system for a future backend without requiring a rewrite at that point.
- Minimum browser support floor becomes explicit and testable (Safari 16.4+, Chrome and Edge current, Firefox current).

**Negative:**
- OPFS content is not user-visible — users cannot browse or back up the OPFS library directory through the OS file manager. Export via File System Access API is the only user-accessible path out of OPFS.
- IndexedDB migration requires one-time migration logic executed on first run after the update. Edge cases (partially migrated state, interrupted migration) must be handled.
- File System Access API browser support varies: Chrome and Edge support it fully; Firefox and Safari support is limited as of 2026. The export path requires a download-as-file fallback for unsupported browsers.

## Open consequences

**Safari OPFS minimum.** OPFS support reached Safari via Safari 16.4 (released March 2023). This ADR establishes Safari 16.4 as the minimum browser support floor. Whether to enforce this with a browser capability check at startup or silently degrade to a limited-storage mode is an implementation decision.

**IndexedDB migration.** The existing `stlCache.ts` (raw STL binaries) and `geometry2dCache.ts` (computed 2D loops) IndexedDB entries must be migrated to OPFS on first run after this ADR is implemented. The expected pattern is: migrate entries, verify success, then delete from IndexedDB — with fallback to a "geometry not found; re-import source file" state if migration fails for a given entry. Migration logic must be idempotent and one-time.

**File System Access API fallback.** On browsers where File System Access API is unsupported (notably Firefox as of 2026), the export path must fall back to a standard browser download (triggering a file-save dialog via `<a download>`). This fallback cannot support "save to a previously chosen directory" workflows but preserves basic export capability on all browsers.

## References

- docs/UI-ARCHITECTURE.md §3.1 — current localStorage persistence scope
- docs/UI-ARCHITECTURE.md §5.5 — IndexedDB cache fragility; the motivating problem
- docs/UI-ARCHITECTURE.md §13 — persistence architecture (under review)
- ADR 0007 — persistence and library architecture; defines what is stored and the three-scope model
- ADR 0009 — first-run wizard; writes to user-scoped storage via this layer

# UI M2 Wave 1 - start now (architect, 2026-10-28 10:55 PM CT)

Start these 8 lanes now, one Project thread each. The orders are on main at ef26eab54c (queue/WO-3278..3288).

- WO-3278 W1-A kit inputs (src/components/kit/inputs/)
- WO-3279 W1-B kit surfaces (src/components/kit/surfaces/)
- WO-3280 W1-C kit actions (src/components/kit/actions/)
- WO-3281 W1-D units + notices (src/lib/units/, src/notices/)
- WO-3282 W1-E commands + dialog stack (src/commands/)
- WO-3283 W1-F parameter schema (src/lib/opschema/, renderer in src/components/opschema/)
- WO-3285 W1-H test-drive shell + kit gallery + Playwright layout suite (src/ui2/shell/, src/ui2/gallery/, src/tests/ui2-layout/)
- WO-3286 W1-I icons (new set in src/components/icons/ui2/; old icons untouched)

Method, for every lane:
- Branch wo/WO-<n> from origin/wo/WO-3275, not main. WO-3275 is in its final audit and its contracts are stable. Open a draft PR against main.
- Code against the WO-3275 contracts. Map: src/tests/evidence/WO-3275/CONTEXT.md.
- Never edit a contract file or another lane's paths. Put a one-line request in the Worker result instead.
- When WO-3275 lands, merge origin/main into the branch before READY.
- Test first. Write feature-proof.json. One independent auditor pass. READY FOR AUDIT in the PR.

Not yet:
- WO-3284 (store split) and WO-3287 (tool profile steps) wait for the alpha.3.2 freeze.
- WO-3288 (Settings row) waits for WO-3275 to land.

Reply on PR #119 with the thread-to-order mapping once the lanes are running.

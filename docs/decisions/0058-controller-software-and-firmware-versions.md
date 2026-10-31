# 0058 - Controller software and firmware versions: know them, never flash, refuse only what cannot run

Date: 2026-10-15
Status: Accepted 2026-10-15 (the operator's rulings D1-D4; binding on every work order that touches a controller backend)
Related: ADR-0041 (controllers are backends), LIENCAM.md rule 11, docs/machine/CONTROLLER-VERSIONS-PLAN.md (the plan and its evidence)
Authority: the operator, 2026-10-15, to the machine seat, word for word:

> We have no control over what software version a user has installed and what firmware version is loaded on their
> controller. We can likely have minimum versions. But we need to be able to handle future updates and version
> differences.

and on the card "Controller versions: take the 4 recommended rules?" (Q-CONTROLLER-VERSIONS-TAKE-THE-4-R-1792102017694),
typed to the machine seat and relayed verbatim: "D1 yes. D2 yes. D3 yes. D4 yes."

## Context

The UCCNC bridge drives the board through whatever UC100.dll the configured UCCNC install carries. With none
configured, the desktop app picks the highest-numbered `C:\UCCNC*`, so installing a newer UCCNC silently changes the
DLL (plan F1). The versions are read only after `Open` and never checked (F2). Only one combination is proven on a real
board: AXBB-E (type 19), firmware 1005, hardware 1, DLL 2190 (UCCNC 1.2115) (F6). Opening a board with a DLL whose
embedded firmware differs is believed to reflash it (F7, unproven; vendor forum evidence only).

## Decision

1. **LienCAM never updates controller firmware (D1).** Firmware is changed with the vendor's own software. LienCAM's
   job is to notice, before `Open`, when a connection could cause a flash, and to say so.
2. **An untested combination connects (D2).** It is not refused. The bridge says once, on the console, which board,
   firmware, hardware, API and DLL versions it is running and that the combination is untested.
3. **A minimum version exists only for "cannot run" (D3).** A version is refused only when the software cannot work
   with it, for example a wrapper missing a call the bridge needs; the refusal names the call and the version.
   "Not tested yet" is never a refusal (rule 11).
4. **A changed DLL waits for the operator's word, and the second Connect press is that word (D4).** When the DLL the
   bridge would use differs from the one this board (by serial) last connected with, the bridge does not `Open`; it
   writes one console line naming both versions, what may happen to the firmware, and how to go back. Pressing
   Connect again uses the new DLL. No new UI. With no record (a new user or a new board) it opens normally.
5. **Changing the DLL is an operator act,** never a side effect of installing a new UCCNC: with several installs and
   none configured, the desktop app stops picking the newest.
6. **No nags (the operator, 2026-10-15, on the firmware-update card: "no nags in the software now. I don't like a
   million nag popups in any software I use").** The lines in points 2 and 4 are each ONE console line per event:
   never a popup or dialog, never repeated for the same event.
7. **Every assumption about DLL or firmware behaviour has a named check,** so qualifying a new version is running a
   list. The same identity model (backend, board, firmware, API, reported before motion) applies to every backend
   (ADR-0041).

## Consequences

- Work, in order (plan section 3): V1 WO-2842 (read and log versions; padded Versio struct), V2 desk research (can the
  firmware be read before `Open`; what starts a flash), V3 compatibility record (proven and cannot-run rows only),
  V4 DLL pinning per board serial with the second-press consent, V5 the behaviour-check list, V6 a clear message for a
  failed update with no `Open` retry loop.
- Until V4 lands: no bridge that can reach the operator's board points at any install other than the proven one.

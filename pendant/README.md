# LienCAM phone pendant

**Status: ALPHA - tested on one machine.**

The phone pendant is a touch screen for a phone: jog, safe Z, HOLD and RESET, a live DRO, overrides, spindle,
work offsets and probing routines. The phone never talks to the controller. It talks to a small relay on the PC,
and the open LienCAM desktop carries out every command, so the pendant works with whatever controller the desktop
is connected to.

## Using it (everyone)

In LienCAM open Control > Pendant, choose Enable remote control, then scan the QR code or open the address on a
phone on the same network. The full walkthrough is the wiki page "Phone pendant" (docs/wiki/Phone-Pendant.md).
You do not start any server by hand: the desktop app starts and stops the relay when you enable and disable the
pendant.

## How it fits together (contributors)

- `server.mjs --bridge` - the relay (default port 8324). It serves `app/` to the phone and forwards authenticated
  JSON between the paired phone and the desktop. It never sends a machine command itself. The desktop app starts it
  (`electron/main.cjs`, `startPendant`).
- `app/` - the phone page (`index.html`, `app.js`, `app.css`, probing planner and diagrams).
- Desktop side, in `src/`: `components/machine/PendantPanel.tsx` (pairing popover), `lib/machine/pendantBridge*`,
  `lib/machine/pendantBrokerHost.ts` and `lib/machine/pendantMachine.ts` (turns a phone command into a controller
  action).
- `uccnc-bridge/` - the Windows bridge to the UC100 controller; it is separate from the pendant.
- A phone must present the temporary session code; disconnecting the desktop disables the paired phone session.

## Developing against it

Without the desktop, the standalone simulated pendant is still available for UI work:

```powershell
node pendant/server.mjs          # standalone simulator, http://localhost:8324
node pendant/test-pendant.mjs    # simulator tests
node pendant/server.mjs --bridge # relay only, as the desktop starts it
node pendant/test-bridge.mjs     # relay tests
```

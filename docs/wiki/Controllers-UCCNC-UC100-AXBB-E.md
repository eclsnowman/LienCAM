# Controllers: UCCNC, UC100, AXBB-E

**Status: ALPHA - one machine proven.**

Use this Windows-only route to jog, probe and run jobs through a UC100 or AXBB-E. To export G-code for UCCNC instead, use [Post-Processors](Post-Processors).

## What you need

- The LienCAM Windows desktop app ([Install on Windows](Install-on-Windows)).
- UCCNC installed on the same PC, with your controller working in UCCNC first.

## First connection

LienCAM does not contain, copy or distribute any of the controller vendor's software. The small connection program that talks to the UC100 library is **compiled on your own PC, against your own UCCNC install**, the first time you need it. We never distribute that piece.

It finds folders starting with `C:\UCCNC` and builds and starts the connection automatically.

If the Machine page cannot find UCCNC, use **Install folder > Browse**, then **Build machine connection**. Choosing another install or installing updated connection source rebuilds it automatically. For build errors, see [Troubleshooting](Troubleshooting#uccnc-the-connection-did-not-build).

## Connect

1. Set up your machine definition with its Controller set to UCCNC ([Set up your machine](Set-Up-Your-Machine)). A UCCNC `.pro` profile can be imported into the definition; a review shows every value before anything is written.
2. Open the Control tab, stay on Main, choose the Machine bridge connection in the Machine panel, and press Connect.
3. The first time you connect, and again after installing a new LienCAM version, the console says "The bridge holds no definition - nothing configured; apply one." and nothing moves. On the Machine page press **Apply to Machine**, check the values it reads back, then press **Restart bridge** and Connect again.
4. **Home the machine** before you jog or run anything.

To restart the connection, use Restart bridge on the Machine page. A restart loses the machine's position, so travel protection is not reliable until you home again: home immediately after every restart.

## What LienCAM does through this route

Jogging, work offsets, running a posted program with hold, resume and overrides, probing routines, the tool setter and the guided tool change (M6). Probing and these helpers are themselves marked alpha. See the Control and Probing pages in the sidebar for the screens.

## Send a test report

> **What has been tested on real hardware.** I've tested LienCAM on my own router, which runs UCCNC with an
> AXBB-E controller. I don't own a GRBL, grblHAL or LinuxCNC machine, so those routes have only been tested
> against simulators (grbl-sim and the LinuxCNC simulator), not on real hardware yet. If you run one of those
> machines, your test reports are exactly what we need - and once people have confirmed them on real machines,
> this note comes off.

Post in [GitHub Discussions](https://github.com/eclsnowman/LienCAM/discussions) with your controller and software version, the bottom-console text, whether you ran in the air or cutting, and what happened.

Always read posted G-code before you run it, and keep a hand near the E-STOP. LienCAM's software stop is not a substitute for your machine's own hardware E-STOP.

See also: [Known limitations](Known-Limitations), [Troubleshooting](Troubleshooting), [Reporting a bug](Reporting-a-Bug).

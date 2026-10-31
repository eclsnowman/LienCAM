# Known limitations

LienCAM is in alpha. This page is the plain list of what is not proven or not there yet.

## What has been tested on real hardware

> **What has been tested on real hardware.** I've tested LienCAM on my own router, which runs UCCNC with an
> AXBB-E controller. I don't own a GRBL, grblHAL or LinuxCNC machine, so those routes have only been tested
> against simulators (grbl-sim and the LinuxCNC simulator), not on real hardware yet. If you run one of those
> machines, your test reports are exactly what we need - and once people have confirmed them on real machines,
> this note comes off.

To send a test report, post in [GitHub Discussions](https://github.com/eclsnowman/LienCAM/discussions) with the text from the bottom console attached. When at least two independent users have reported a successful real-machine run on a controller family, the note for that family comes off and its status moves from EXPERIMENTAL to ALPHA.

## The list

- [UCCNC control](Controllers-UCCNC-UC100-AXBB-E) is proven on one Windows machine and on an AXBB-E with firmware 1005 with Fedora 44 x86-64 (October 22, 2026), including the Modbus spindle. Linux defaults to the native bridge on x86-64 and ARM64; ARM64 hardware remains unproven. USB UC100 and other native board/firmware combinations are unsupported. Wine is parked because Modbus spindle control can hang it; explicit opt-in is `LIENCAM_BRIDGE_WINE=1` with a configured `WINEPREFIX`. See [Linux setup](Install-on-Linux).
- [LinuxCNC control](Controllers-LinuxCNC) is proven on the LinuxCNC 2.9.4 simulator only; [GRBL and grblHAL](Controllers-GRBL-and-grblHAL) are tested against grbl-sim only.
- Machine fixes made close to a release may have been proven only on a simulator; each release is checked with a short in-air run on the author's own machine before it ships.
- A UCCNC bridge restart loses position. After **Restart bridge**, home before jogging or running a job.
- Linux/mac installers remain unsigned and need real package validation. Launcher tests use a stubbed process; the Linux default route still awaits its O61b board readback. See [Install on Windows](Install-on-Windows), [Install on Linux](Install-on-Linux) and [Install on macOS](Install-on-macOS).

## Status of the rest

- Form (SubD organic modelling), relief from an image, 3D operations, and probing routines, the tool setter, guided tool change, Z surface map, rotated work offsets, pause-move-resume and the phone pendant are ALPHA: they work, expect gaps.
- The mesh lab and nesting are EXPERIMENTAL.
- Project files from one alpha may need re-saving in the next; nothing is promised to keep working before 1.0.

Always read posted G-code before you run it on a real machine, and keep a hand near the E-STOP.

If something goes wrong, see [Reporting a bug](Reporting-a-Bug).

- Apple Silicon native AXBB-E firmware 1005 control is **alpha, untested on macOS**. Intel Mac native control, USB UC100 and other board/firmware combinations are unsupported. No Wine/demo fallback is used on Mac. Mac scheduling, local-network/firewall prompts, discovery and unsigned nested-runtime launch remain unqualified; no Mac + board readback exists. See [Install on macOS](Install-on-macOS).

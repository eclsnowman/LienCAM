# Controllers: GRBL and grblHAL

**Status: EXPERIMENTAL - not hardware-verified.**

LienCAM can send programs to GRBL and grblHAL from the browser or desktop app. Direct control has only been tested against a simulator.

Posting G-code for these controllers is a separate, supported feature: see [Post-Processors](Post-Processors). You can always post a file and send it with the sender you already use.

## What you need

- A browser or the desktop app that supports Web Serial (a Chromium-based browser). If Connect is unavailable, the browser is the limitation, and the app says so.
- A GRBL 1.1 or grblHAL board connected by USB.
- Your machine defined with its Controller set to GRBL or grblHAL ([Set up your machine](Set-Up-Your-Machine)). The example machines include several GRBL-based routers.

## Connect

1. Open the Control tab and press Connect. Pick the board's serial port in the browser prompt; the browser remembers ports you have allowed, so next time it is one click.
2. The baud rate starts at the standard GRBL speed. Change it only if your board is configured differently.
3. Watch the status readout. Idle means ready, Alarm means the controller is locked (a fresh power-up or a limit hit), Hold means a feed hold is active.
4. From Alarm: run the homing cycle (`$H`) if your machine has homing switches, or clear the alarm lock (`$X`) after you have confirmed the position is safe. LienCAM does not force homing; it follows what the controller reports.

GRBL tool changes use an `M0` pause for a manual change. See [Post-Processors](Post-Processors) for dialect details.

## Send a test report

> **What has been tested on real hardware.** I've tested LienCAM on my own router, which runs UCCNC with an
> AXBB-E controller. I don't own a GRBL, grblHAL or LinuxCNC machine, so those routes have only been tested
> against simulators (grbl-sim and the LinuxCNC simulator), not on real hardware yet. If you run one of those
> machines, your test reports are exactly what we need - and once people have confirmed them on real machines,
> this note comes off.

Post in [GitHub Discussions](https://github.com/eclsnowman/LienCAM/discussions) with your controller and software version, the bottom-console text, whether you ran in the air or cutting, and what happened.

For a first run, keep the spindle off and the machine in the air, with a hand near the E-STOP.

See also: [Known limitations](Known-Limitations), [Troubleshooting](Troubleshooting), [Reporting a bug](Reporting-a-Bug).

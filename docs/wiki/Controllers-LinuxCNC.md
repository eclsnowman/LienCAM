# Controllers: LinuxCNC

**Status: EXPERIMENTAL - simulator only.**

LienCAM can run a program on LinuxCNC through a small gateway program on the LinuxCNC PC. That link has been verified against the LinuxCNC 2.9.4 simulator. It has not been run on a real LinuxCNC machine yet.

Posting G-code for LinuxCNC is a separate, supported feature: see [Post-Processors](Post-Processors).

## 1. On the LinuxCNC PC

1. Get `gateway.py` from the LienCAM release download (or from `pendant/linuxcnc-gateway` in the repository) and copy it to the LinuxCNC PC. It needs only Python 3.9 or newer (the `python3` that ships with LinuxCNC) and LinuxCNC's own Python module.
2. Start LinuxCNC first. The gateway needs it running.
3. LienCAM on the same PC: run `python3 gateway.py`. LienCAM on another PC: run `python3 gateway.py --host 0.0.0.0` so it accepts connections from your network.
4. It listens on port 8327 (`--port` changes it; `--program-dir` chooses where it writes programs, by default `~/liencam-programs`). It prints one line when it is listening; leave that terminal open.
5. On a network, both PCs must be on the same network, and port 8327 must be open in the LinuxCNC PC's firewall if it has one.

## 2. In LienCAM

Use the LienCAM desktop app, or LienCAM opened on the LinuxCNC PC itself. The hosted browser demo cannot reach the gateway: it is an https page, the gateway is a plain `ws://` connection, and the gateway refuses web pages from other addresses.

1. Pick or add your machine in the Machine Library and set its Controller to LinuxCNC.
2. On Control > Machine > Definition, open the Controller tab. In "LinuxCNC PC address" type the LinuxCNC PC's address as `host` or `host:port` (for example `192.0.2.10` or `192.0.2.10:8327`). Leave it blank when LinuxCNC is on this PC.
3. On Control > Main, choose "LinuxCNC gateway" as the connection and click Connect.
4. When connected, the Controller area shows what LinuxCNC itself reported: its version, the INI file, the joints, the spindle and whether the link is read-only.

## What is different from UCCNC and GRBL

- LinuxCNC owns the spindle, homing and tool changes. A tool change is LinuxCNC's own `M6`.
- Probing runs through LinuxCNC's `G38` probe move.
- If a network session goes silent (a pulled cable, a sleeping PC), the gateway drops it and the program stops.

See [Post-Processors](Post-Processors) for file and dialect details.

## Send a test report

> **What has been tested on real hardware.** I've tested LienCAM on my own router, which runs UCCNC with an
> AXBB-E controller. I don't own a GRBL, grblHAL or LinuxCNC machine, so those routes have only been tested
> against simulators (grbl-sim and the LinuxCNC simulator), not on real hardware yet. If you run one of those
> machines, your test reports are exactly what we need - and once people have confirmed them on real machines,
> this note comes off.

Post in [GitHub Discussions](https://github.com/eclsnowman/LienCAM/discussions) with your controller and software version, the bottom-console text, whether you ran in the air or cutting, and what happened.

For a first run, keep the spindle off and the machine in the air, with a hand near the E-STOP.

See also: [Known limitations](Known-Limitations), [Troubleshooting](Troubleshooting), [Reporting a bug](Reporting-a-Bug).

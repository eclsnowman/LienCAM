# 0060 - Linux UCCNC route A runs the existing bridge under Wine

Date: 2026-10-17
Status: Accepted 2026-10-16 (the operator's 8:45 PM CT answer to
Q-LINUX-UCCNC-MAY-THE-HOME-MADE-DR: "A and B both public in alpha.3").
Related: WO-2894, WO-2895 (native route B), WO-2896 (held-Stop FRO fix),
ADR-0058 (controller DLL and firmware identity).

On x86-64 Linux, Electron starts the unchanged prebuilt Windows bridge with
`wine`, using an explicitly configured, existing absolute `WINEPREFIX`. The
Linux release stages `pendant/uccnc-bridge/bin/liencam-bridge.exe` from the
Windows bridge build before packaging. Linux alone includes that executable;
Windows retains its existing compile-from-source route. No vendor DLL or
machine-specific configuration is included. The package build does not produce
the executable itself: release staging must supply the matching bridge build.

The app copies the executable and board tables to writable user data because
the bridge prepares the operator's DLLs beside its executable. The operator
supplies their UCCNC install, including Profiles, UC100.dll and FTD2XX DLL.
Linux discovery checks only the configured install or a single install in that
prefix's drive_c; multiple installs require an explicit choice, preserving
ADR-0058's DLL-selection rule. Absolute Linux install/profile/VFD paths become
Wine Z: paths; relative profile names and explicit Windows drive paths remain
usable. No simulator or alternate probing/motion method is substituted.

Every Wine child's exit runs `wineserver -k` followed by `wineserver -w` with
that child's original prefix. A replacement waits for cleanup, including on
explicit restart and crash respawn. Electron waits during normal shutdown.
Cleanup failure is reported and prevents a replacement from racing the old
server. Use a dedicated prefix: cleanup affects all Wine processes in it.
Firmware-update exit 11 keeps the existing no-respawn rule.

ARM and USB boards are outside route A. Route B covers native Linux/ARM work.
WO-2896 is a release dependency for the Wine FRO race after a held Stop.
The handoff reports DLL 2190 discovery, e-stop, Stop/Reset and 20.7 ms polling;
the launcher regression uses process stubs and is not hardware proof. Windows
bridge build/desk-kit evidence, machine-seat readback, and a real Linux package
run remain release verification obligations. This order changes transport
hosting, not the bridge's approved motion or controller algorithms. No new
motion card is required for the explicitly ordered route.

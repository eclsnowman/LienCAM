# Install on Linux

> **Untested and unsigned.** Apart from one x86-64 PC driving an AXBB-E (see below), the Linux builds have not been run on real hardware yet. Please report what you find.

## What you need

- A 64-bit Linux desktop with a graphics driver that supports WebGL2.
- About 8 GB of RAM.

## Which file to download

**Current release:** [0.37.0-alpha.3.3](../releases/tag/v0.37.0-alpha.3.3).
The Linux board test below was run before this release; it is not a new board test of alpha.3.3.

From the project's [Releases page](../releases) (x86-64 PCs use the `x86_64`/`x64` files; ARM64 computers use the `arm64`/`aarch64` ones; `.deb` and `.rpm` packages are also listed there):

- `LienCAM-<version>-linux-x86_64.AppImage` - one file, no install. Make it executable and run it:

```
chmod +x LienCAM-*-linux-x86_64.AppImage
./LienCAM-*-linux-x86_64.AppImage
```

- `LienCAM-<version>-linux-x64.tar.gz` - unpack it anywhere and run the `liencam` program inside.

If the AppImage refuses to start with an error about `libfuse.so.2`, install the FUSE 2 library: `sudo dnf install fuse-libs` on Fedora, `sudo apt install libfuse2` on Debian or Ubuntu (`libfuse2t64` on Ubuntu 24.04). Or run it with `--appimage-extract-and-run`, or use the tar.gz.

## Running a machine from Linux

Designing, simulating and posting G-code work the same as on Windows.

UCCNC AXBB-E control uses the native Linux bridge on x86-64 and ARM64.
To select it, alpha.3.1 needs `LIENCAM_BRIDGE_NATIVE=1`; alpha.3.2 uses it by default.
Wine is parked: its controller checks passed, but Modbus spindle control
hung the bridge. To opt in explicitly on x86-64 only, set `LIENCAM_BRIDGE_WINE=1`
and `WINEPREFIX` to an existing dedicated UCCNC Wine prefix with Wine/.NET and
your licensed UCCNC vendor DLLs installed. Keep other Wine applications in a
separate prefix: bridge cleanup stops that prefix's Wine processes.

### Native Linux bridge

This bridge runs directly on x86-64 and ARM64 Linux, without Wine or vendor DLLs.
It supports the AXBB-E with firmware 1005 only. It has no firmware
update path and refuses firmware it has not validated. Other controller
models and USB UC100 are unsupported by this bridge.

**Proven on a real board (October 22, 2026):** Fedora 44 x86-64 with the native Linux bridge,
an AXBB-E (firmware 1005) on a real router: Connect, Apply to
Machine, E-STOP and clear, Stop/Reset during a move, Home All, jogs, Feed Hold
and resume, a short program, and the spindle over Modbus (VFD) all worked.
One machine so far, so the native bridge is ALPHA. USB UC100 is not covered.

Before you connect from Linux:

- AppImage: install `fuse-libs` (Fedora) or `libfuse2` (Debian/Ubuntu).
- Network (alpha.3.2): in the desktop app's Machine panel, open Controller, choose the wired
  port connected to the AXBB-E and press **Set up controller network**. It uses
  10.10.10.20/24 by default and reconnects automatically after a cable or power
  drop. The AXBB-E has a fixed address (10.10.10.11) and no DHCP server;
  this sets addressing only, with no traffic monitoring. If the controller still
  answers a previous computer, power-cycle it or choose another free host
  address. Setup shows exact terminal commands if NetworkManager refuses.
- Spindle over a USB serial adapter: set the spindle serial port to the Linux
  device (for example `/dev/ttyUSB0`), and make sure your user can open it
  (Fedora/Debian: `sudo usermod -aG dialout $USER`, then log in again).

For terminal setup on NetworkManager, replace `enp1s0` with the controller's
wired port (`nmcli device status` lists ports). The same profile is updated on
repeat runs; priority 999 puts it above the default DHCP profile. Desktop polkit
usually permits this without sudo; if authorization is refused, an administrator
can run these same commands with `sudo nmcli`.

```sh
port=enp1s0
profile="liencam-controller-$port"
if nmcli connection show id "$profile" >/dev/null 2>&1; then
  nmcli connection modify id "$profile" connection.interface-name "$port" ipv4.method manual ipv4.addresses 10.10.10.20/24 ipv4.never-default yes ipv6.method disabled connection.autoconnect yes connection.autoconnect-priority 999
else
  nmcli connection add type ethernet ifname "$port" con-name "$profile" ipv4.method manual ipv4.addresses 10.10.10.20/24 ipv4.never-default yes ipv6.method disabled connection.autoconnect yes connection.autoconnect-priority 999
fi
nmcli connection up id "$profile" ifname "$port"
sudo usermod -aG dialout "$USER"  # Only for a serial spindle adapter; log out and log in again.
```

In alpha.3.2, Connect uses the packaged native bridge for your CPU without an environment
variable; alpha.3.1 needs the setting above. Choose a Linux folder containing your UCCNC `Profiles` folder and
select your `.pro` profile; this imports the profile without loading UC100.dll
or FTD2XX.dll. Native paths stay Linux paths. A saved machine definition can
also configure the bridge. The app keeps the complete native runtime in its
writable user-data `machine-bridge-native` folder.

A missing native bundle or startup failure is reported in one line without
switching to Wine or starting a simulator.
An explicit `LIENCAM_BRIDGE_EXECUTABLE` override still selects that executable:
a Windows `.exe` uses Wine; a native executable runs directly. For a separately
unpacked native bridge bundle, point the override to its `liencam-bridge`
executable and keep all accompanying runtime files together.

For LinuxCNC and GRBL see the Controllers pages; both are experimental.

You can also run LienCAM in a browser on Linux: [Run in your browser](Run-in-your-browser).


Release note (alpha.3.2): Linux now uses the native bridge by default; Wine is parked behind explicit opt-in. Fresh Huanyang definitions propose `/dev/ttyUSB0`, and the spindle picker lists local Linux serial devices before a link is held. Existing saved port choices are preserved.

If something goes wrong, see [Reporting a bug](Reporting-a-Bug).

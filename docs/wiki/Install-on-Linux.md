# Install on Linux

> **Untested and unsigned.** Apart from one x86-64 PC driving an AXBB-E (see below), the Linux builds have not been run on real hardware yet. Please report what you find.

## What you need

- A 64-bit Linux desktop with a graphics driver that supports WebGL2.
- About 8 GB of RAM.

## Which file to download

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

UCCNC Ethernet boards are supported on **x86-64 Linux through Wine** (route A).
Install 64-bit Wine and the .NET Framework runtime required by the Windows
bridge in a dedicated Wine prefix. Both `wine` and `wineserver` must be on PATH.
Use your own licensed UCCNC installation in that prefix, including its Profiles
folder, UC100.dll and FTD2XX DLL; LienCAM does not redistribute the vendor DLLs.
The bridge executable is included in the Linux package. No compiler or UCCNC
API wrapper source is needed on the Linux computer.

Start LienCAM with `WINEPREFIX` set to the absolute path of that existing prefix.
For example, from a Linux terminal:

```sh
WINEPREFIX="$HOME/.local/share/liencam-uccnc" ./LienCAM-<version>-linux-x86_64.AppImage
```

On Fedora the packaged wine-mono needs the MinGW `iconv.dll`: install `mingw64-win-iconv` (`sudo dnf install mingw64-win-iconv`). LienCAM adds its folder to the bridge's Wine search path by itself; if the console still says "iconv.dll ... not found" or "Could not load Mono", that package is missing.

On the Machine page choose the UCCNC install folder using its Linux path (for
example `/home/operator/.local/share/liencam-uccnc/drive_c/UCCNC12115`). With
exactly one UCCNC install in the prefix's `drive_c`, LienCAM finds it. With several,
choose one explicitly; LienCAM never chooses a newer DLL for you. Connect starts
the bridge under Wine. The app keeps a writable copy in its user-data
`machine-bridge` folder and cleans up that Wine prefix on bridge exit, restart
and app shutdown. Keep other Wine applications in a different prefix, since
cleanup stops all Wine processes in the selected prefix.

Use the DLL matched to the controller's firmware. The recorded hardware pairing
is AXBB-E firmware 1005, hardware 1, DLL 2190 (UCCNC 1.2115). A mismatched vendor
DLL can initiate a firmware update inside Open; never use Connect to experiment
with a mismatched DLL. The existing bridge's version handling and firmware-update
reporting also apply under Wine.

Route A does not provide USB controller support or ARM execution. ARM uses the
native-driver route B below. Known limitation: under Wine, spindle control over
Modbus (VFD) can hang the bridge. If your spindle runs from a VFD, use route B.

### Native .NET driver (route B)

Route B runs the bridge natively on x86-64 and ARM64 Linux, without Wine or
vendor DLLs. It supports the AXBB-E with firmware 1005 only. It has no firmware
update path and refuses firmware it has not validated. Other controller
models and USB UC100 are unsupported by this route.

**Proven on a real board (October 22, 2026):** Fedora 44 x86-64, LienCAM
0.37.0-alpha.3, an AXBB-E (firmware 1005) on a real router: Connect, Apply to
Machine, E-STOP and clear, Stop/Reset during a move, Home All, jogs, Feed Hold
and resume, a short program, and the spindle over Modbus (VFD) all worked.
One machine so far, so the route is ALPHA. USB UC100 is not covered.

Before you connect from Linux:

- AppImage: install `fuse-libs` (Fedora) or `libfuse2` (Debian/Ubuntu).
- Network: the AXBB-E has a fixed address (in the 10.10.10.x range by default) and no DHCP
  server, so the wired port needs its own fixed address in that range (any
  free 10.10.10.x other than the controller's, with /24). On NetworkManager:
  `nmcli connection add type ethernet ifname <port> con-name axbb ipv4.method manual ipv4.addresses <address>/24 ipv6.method disabled connection.autoconnect yes connection.autoconnect-priority 10`
  then `nmcli connection up axbb`. If another computer used the same address
  on this controller before, pick a different one or power-cycle the
  controller (it remembers the previous computer for that address).
- Spindle over a USB serial adapter: set the spindle serial port to the Linux
  device (for example `/dev/ttyUSB0`), and make sure your user can open it
  (Fedora/Debian: `sudo usermod -aG dialout $USER`, then log in again).

In this release the native bridge is still opt-in: start LienCAM with
`LIENCAM_BRIDGE_NATIVE=1`. Without it, Linux uses the Wine route above.

With that opt-in, in a package containing the native bridge for your CPU,
Connect chooses it before Wine. Choose a Linux folder containing your UCCNC `Profiles` folder
and select your `.pro` profile; this route imports that profile without
loading UC100.dll or FTD2XX.dll. Native paths stay Linux paths. A saved machine
definition can also configure the bridge. The app keeps the complete native
runtime in its writable user-data `machine-bridge-native` folder.

Without the opt-in, or if a matching native bundle is absent, x86-64 Linux uses
route A above. A native
startup failure is reported without changing routes or starting a simulator.
An explicit `LIENCAM_BRIDGE_EXECUTABLE` override still selects that executable:
a Windows `.exe` uses Wine; a native executable runs directly. For a separately
unpacked native bridge bundle, point the override to its `liencam-bridge`
executable and keep all accompanying runtime files together.

For LinuxCNC and GRBL see the Controllers pages; both are experimental.

You can also run LienCAM in a browser on Linux: [Run in your browser](Run-in-your-browser).

If something goes wrong, see [Reporting a bug](Reporting-a-Bug).

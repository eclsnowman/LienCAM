# Install on Linux

> **Untested and unsigned.** The Linux builds have not been run on real hardware yet. Please report what you find.

## What you need

- A 64-bit Linux desktop with a graphics driver that supports WebGL2.
- About 8 GB of RAM.

## Two ways to get it

From the project's [Releases page](../releases):

- `LienCAM-<version>-linux-x86_64.AppImage` - one file, no install. Make it executable and run it:

```
chmod +x LienCAM-*-linux-x86_64.AppImage
./LienCAM-*-linux-x86_64.AppImage
```

- `LienCAM-<version>-linux-x64.tar.gz` - unpack it anywhere and run the `liencam` program inside.

If the AppImage refuses to start, your system may lack FUSE; run it with `--appimage-extract-and-run`, or use the tar.gz.

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
native-driver route B below. **Release dependency: WO-2896** fixes the
Wine feed-rate override race after a held Stop; route A's release requires that
fix. The handoff reports discovery, e-stop, Stop/Reset and 20.7 ms polling under
Wine; this launcher change still needs machine-seat board readback and a real
Linux package run. It does not establish a new hardware qualification.

### Native .NET driver (route B)

Route B runs the bridge natively on x86-64 and ARM64 Linux, without Wine or
vendor DLLs. It supports the AXBB-E with firmware 1005 only. It has no firmware
update path and refuses firmware it has not validated. Other controller
models and USB UC100 are unsupported by this route.

**Qualification pending:** the native driver has desk and fake-board evidence;
it has not been read back from a real AXBB-E. Public route-B release requires
the real-board check at the machine, motors disabled first. Do not
take a successful build or fake-board test as hardware qualification.

The native bridge is opt-in until it is proven on a real board: Linux uses the
Wine route by default, and uses the native bridge only when you start LienCAM
with `LIENCAM_BRIDGE_NATIVE=1`.

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

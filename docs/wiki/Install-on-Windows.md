# Install on Windows

Windows is the platform LienCAM is built and tested on. The desktop app is in alpha.

## What you need

- Windows 10 or 11, 64-bit.
- A graphics card and driver that support WebGL2 (any recent integrated or dedicated GPU does).
- About 8 GB of RAM. Big 3D models and the simulation use a lot of memory.

## Two ways to get it

Download from the project's [Releases page](../releases) on GitHub. Each release lists two Windows files:

- `LienCAM-<version>-win-x64-setup.exe` - the installer. Choose installation for anyone who uses this computer or only for you. It adds a desktop and Start menu shortcut named LienCAM.
- `LienCAM-<version>-win-x64-portable.exe` - the portable build. Nothing is installed; keep the program anywhere (including a USB stick) and double-click it. Settings and saved app data stay in `%APPDATA%\LienCAM` on that PC, shared with an installed copy. A USB stick carries the program, not your settings. Use the backup and restore steps below to move your setup to another PC.

## The "Windows protected your PC" warning

The installer is not code-signed yet (a certificate costs money and this is a hobby project), so Windows SmartScreen shows a blue warning the first time. This is expected.

1. On the blue window, click **More info**.
2. Click **Run anyway**.
3. On **Choose Installation Options**, select **Anyone who uses this computer** (administrator permission required) or **Only for me** (no administrator needed), then **Install**. There is no folder chooser.

Only do this for a file you downloaded from the project's own Releases page. Each release lists a SHA-256 checksum; compare it with the file if you want to be sure.

## First start

Open LienCAM from the Start menu (or double-click the portable file). On first start LienCAM offers **Try an example**: pick Full Suite or a starter-kit part, or choose **Start with an empty project**. Next: [First part in 15 minutes](First-part-in-15-minutes).

To run a real machine you also need your controller software. LienCAM drives UCCNC with a UC100 or AXBB-E controller; see [Controllers: UCCNC, UC100, AXBB-E](Controllers-UCCNC-UC100-AXBB-E). If you only want to design, simulate and post G-code, you do not need any of that.

## Updating or moving to another PC

At startup, the desktop app mentions a newer release in the console with its link; it never installs anything by itself.

Before updating, open **Settings > User Data > Download backup** and keep the file somewhere safe. Close LienCAM, run the newer installer over your existing installation, then open it from its shortcut. Your machines, tools, settings, work offsets and other saved shop data stay in place.

For a fresh install or rebuilt PC, use **Settings > User Data > Inspect backup... > Confirm restore**. After the reload finishes loading, your setup comes back, including saved recipe templates, cutting data, fixtures and machine-connection launch settings. Start LienCAM from its installed shortcut; no hand-edited .bat file is needed.

For UCCNC, install the controller's own software, copy its .pro profile and handle any Windows Security exclusion separately. The backup carries the connection settings but does not install UCCNC, copy the .pro or grant an antivirus exclusion. Follow [Moving LienCAM to a new or rebuilt PC](Control#moving-to-a-new-pc) for the exact steps.

If something goes wrong, see [Reporting a bug](Reporting-a-Bug).

# Install on Linux

> **Untested and unsigned.** The Linux builds have not been run on real hardware yet. Please report what you find.

## What you need

- A 64-bit Linux desktop with a graphics driver that supports WebGL2.
- About 8 GB of RAM.

## Two ways to get it

From the project's Releases page:

- `LienCAM-<version>-linux-x86_64.AppImage` - one file, no install. Make it executable and run it:

```
chmod +x LienCAM-*-linux-x86_64.AppImage
./LienCAM-*-linux-x86_64.AppImage
```

- `LienCAM-<version>-linux-x64.tar.gz` - unpack it anywhere and run the `liencam` program inside.

If the AppImage refuses to start, your system may lack FUSE; run it with `--appimage-extract-and-run`, or use the tar.gz.

## Running a machine from Linux

Designing, simulating and posting G-code work the same as on Windows. UCCNC control requires Windows. For LinuxCNC and GRBL see the Controllers pages; both are experimental.

You can also run LienCAM in a browser on Linux: [Run in your browser](Run-in-your-browser).

If something goes wrong, see [Reporting a bug](Reporting-a-Bug).

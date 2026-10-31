# Install on macOS

> **Untested.** The macOS build has not been run on a real Mac yet. It is unsigned and not notarized; please report what you find.

## What you need

- A Mac with a graphics system that supports WebGL2 (any recent Mac).
- About 8 GB of RAM.

## Install

1. From the project's [Releases page](../releases), download `LienCAM-<version>-mac-arm64.dmg`. It is built for Apple silicon (M1 and later). On an Intel Mac, download the separate `LienCAM-<version>-mac-x64.dmg` installer; native AXBB-E control is unsupported on Intel.
2. Open the dmg and drag LienCAM into Applications.

## The Gatekeeper prompt

Because the app is unsigned, macOS says it cannot verify it, or that it is from an unidentified developer. To open it anyway:

On macOS 15 (Sequoia) or later:

1. Try to open LienCAM once from Applications; macOS refuses it.
2. Open **System Settings -> Privacy & Security**, scroll to the message about LienCAM, click **Open Anyway** and confirm. You only need to do this once.

On older macOS:

1. In Finder, open Applications, then **right-click** (or Control-click) LienCAM and choose **Open**.
2. In the dialog click **Open** again. You only need to do this once.
3. If macOS still refuses, use **System Settings -> Privacy & Security -> Open Anyway** as above.

Only do this for a file you downloaded from the project's own Releases page.

## Running a machine from a Mac

Designing, simulating and posting G-code work as on Windows. The Apple Silicon installer includes a native AXBB-E firmware 1005 bridge: **alpha, untested on macOS**. It supports neither USB UC100 nor other board/firmware combinations. Intel Mac native control is unsupported. A missing native bundle reports an error; the Mac route does not substitute Wine or a demo.

No Mac + controller readback has been captured. Linux hardware proof does not qualify Mac scheduling, discovery, I/O or motion. The native poll thread requests managed highest priority; Linux real-time scheduling is not available through this route.

The bridge executable and app are unsigned and not notarized. A downloaded app's nested bridge launch still needs qualification; the installer opening does not establish that the bridge can load its runtime. macOS may ask for local-network or firewall permission during discovery. Exact prompts and allow/deny recovery are untested. Report launch/discovery errors using [Reporting a bug](Reporting-a-Bug). You can also use the [browser version](Run-in-your-browser) for design and posting.

If something goes wrong, see [Reporting a bug](Reporting-a-Bug).

# Install on macOS

> **Untested.** The macOS build has not been run on a real Mac yet. It is unsigned and not notarized; please report what you find.

## What you need

- A Mac with a graphics system that supports WebGL2 (any recent Mac).
- About 8 GB of RAM.

## Install

1. From the project's Releases page, download the `.dmg` file. It is built for Apple silicon (M1 and later). On an Intel Mac, use the [browser version](Run-in-your-browser) or [build it from source](Build-from-source).
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

Designing, simulating and posting G-code work as on Windows. UCCNC is a Windows program, so driving a UCCNC machine from a Mac is not possible today. You can also use the browser version: [Run in your browser](Run-in-your-browser).

If something goes wrong, see [Reporting a bug](Reporting-a-Bug).

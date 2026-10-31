# ADR-0045: Electron is the packaged desktop host

Date: 2026-08-27
Status: accepted
Parent: ADR-0041 (controllers are backends)
Authority: Operator ruling 2026-08-25 - "I hate edge with the power of 1000 suns. I
would rather refactor the entire codebase into a compilable language than rely
on edge. This needs to be able to run on Mac, Linux, and Windows. OS Agnostic.
The code will be open source, but releases need to be packages. The user
downloads a package, runs to install or unzip it. And runs one shortcut to
start. Thats it." the operator accepted that UCCNC is the Windows-only exception. On
2026-08-27 he authorized the implementation: "Go with Electron."

## Decision

LienCAM releases use Electron as the desktop host. Electron packages the
existing React/Three.js browser application with its own pinned Chromium. It
does not use Edge or WebView2, and it does not require a frontend rewrite.

The main process owns the application window and any native machine bridge as
one process tree. The renderer is sandboxed, has Node integration disabled,
and receives only a narrow preload API. Static production assets are served
from the package over the privileged `liencam://app` origin. That handler sets
the MIME types and COOP/COEP headers required by the CAM WASM kernels.

`electron-builder` produces these release shapes:

- Windows: an NSIS installer with a LienCAM shortcut, and a portable EXE.
- Linux: an AppImage target and a tar.gz that can be unpacked and run.
- macOS: DMG and zip targets.

The package is the program. A user does not start Node, npm, a dev server, or a
bridge separately. Electron includes a Node runtime as an implementation cost,
but the sandboxed application renderer does not receive Node access.

## Why the ranking changed

The first WO-958 recommendation ranked a small C# WebView2 host first because
UCCNC was assumed to make the whole product permanently Windows-only. the operator
reversed that premise: the CAM product must run on Windows, Linux, and macOS,
and it must not depend on Edge. Cross-platform packaging is now a requirement,
not unused overhead.

The resulting ranking is:

1. **Electron.** It keeps the current frontend, bundles the same Chromium on
   every target, avoids Edge/WebView2, has mature packaging, and can supervise
   a native sidecar.
2. **Tauri, Wails, Photino, and Neutralino.** They can make smaller packages,
   but their Windows renderer is the native WebView2 runtime. Tauri also adds
   Rust and Wails adds Go. They fail the no-Edge requirement before their size
   advantage can matter.
3. **C# plus WebView2.** It fits the existing C# bridge and would be small, but
   it is Windows-only and is explicitly an Edge dependency.
4. **A C++ rewrite.** Rejected. Rewriting the React/Three.js UI and re-hosting
   the browser WASM stack is disproportionate packaging work. Electron meets
   the stated requirement without that cost.

This ranking can be revisited if a cross-platform host with a bundled,
non-Edge browser becomes materially better. A host that merely wraps the OS
webview does not meet the present decision.

## Controller boundary

Cross-platform applies to LienCAM, not to every controller vendor:

| capability | Windows | Linux | macOS |
| --- | --- | --- | --- |
| CAM application | yes | yes | yes |
| GRBL over Web Serial | yes | yes | yes |
| UCCNC / UC100 / AXBB bridge | yes | no | no |

UCCNC's API and driver are Windows-only. Electron cannot change that, and this
decision does not promise otherwise. The packaged host can supervise the
compiled C# bridge on Windows and stop it with the app. Linux and macOS use
controller backends available on those platforms. Running UCCNC remotely or
through Wine is a separate security and hardware project, not part of this
decision.

## Spike evidence

WO-958 exercised packaged Electron 44.0.0 / Chromium 152.0.7977.54 on Windows
and Ubuntu 24.04 under WSL. Both packaged targets proved all of the following:

- `crossOriginIsolated` was true on `liencam://app`.
- The packaged OCCT kernel computed a 2 x 3 x 4 solid volume of 24.
- The packaged Manifold kernel computed a 2 x 3 x 4 solid volume of 24.
- The packaged Clipper2 kernel computed a 10 mm disk area of 313.3337936.
- The production UI loaded `Feature Tour v0.31 (2026-07-25)`, generated its
  real Face operation to `ready`, and rendered the toolpath.
- The host started one harmless bridge fixture, preserved it across the page
  transition, and stopped its PID when Electron closed.

The durable results and inspected captures are in
`src/tests/evidence/WO-958/packaged-windows.json`,
`packaged-windows-kernels.png`, `packaged-windows-toolpath.png`, and their
`packaged-linux-*` counterparts. The bridge proof deliberately used a harmless
fixture. No controller was contacted, so it is not a hardware-readback claim.

The Windows NSIS and portable artifacts and the Linux tar.gz were also built.
The Linux unpacked package was the artifact actually run under WSL. macOS is a
configured target but was not executed on this Windows machine.

## Consequences

Benefits:

- The user starts one LienCAM application; host and bridge lifecycles are
  internal.
- Releases do not depend on Edge, WebView2, a system Node installation, or a
  locally installed CAM toolchain.
- The browser application and WASM kernels remain the product implementation.
- The same desktop architecture can be packaged for all three required OSes.

Costs and follow-up:

- Chromium and Node make the compressed Windows spike about 154 MB and the
  Linux tar.gz about 168 MB. This is accepted in exchange for a pinned browser
  and an installable program.
- Electron security updates become release work. The main process and preload
  must stay narrow, sandboxed, and patched.
- Release CI still needs platform-native macOS validation, code signing,
  notarization, real icons, metadata, and clean-machine installer testing.
- An updater must be selected and threat-modelled later. Do not hand-roll one.
- Shipping the real UCCNC bridge and licensed vendor DLL discovery remains a
  Windows controller integration task. The host supervision seam is proven;
  board communication is not.


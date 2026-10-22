# Native AXBB-E transport (WO-2895)

The owner approved public Linux routes A and B on 2026-10-16, card
Q-LINUX-UCCNC-MAY-THE-HOME-MADE-DR: "A and B both public in alpha.3".

Import the owner-staged UCCNC-Linux commit 9b549af implementation and its
recorded-oracle differential tests under the project Apache-2.0 licence.
It is a clean-room implementation written against observed UDP protocol
behaviour and decompiled-call behaviour. No vendor implementation, wrapper,
DLL, firmware image or decompile dump is included. The fake-board templates
and oracle corpus are observations of protocol traffic, not vendor source.
provenance.json records the hashes of the original handoff source; the only
initial test adaptation is the repository-root marker in FrameCodecTests.cs.
The source is imported unchanged, including the firmware refusal, the rc 10
move-ring overflow, and the documented differences from DLL 2190. No machine
sequence or approved method is redesigned in this order.

Build the existing bridge with UC100NET on .NET 10 and System.IO.Ports.
Keep the Windows csc file list, wrapper and vendor-DLL route unchanged.
The native build imports the same .pro profile without resolving vendor DLLs.
Publish self-contained linux-x64 and linux-arm64 bundles. Electron selects the
matching native bundle when available, otherwise the existing Wine route;
an explicit LIENCAM_BRIDGE_EXECUTABLE continues to select that executable.
Once a native route is selected, failure never switches controller methods.

Qualification is desk/fake-board only. Uc100Net has never contacted the owner's
AXBB-E. Public route-B release requires the owner's real-board T3, motors disabled
first: discovery/Open/status readback, jog, probe contact, e-stop, queued
records during e-stop, soft-limit trip and buffer underrun. The architect
owns the OWED-CHECKS row and ALPHA release check. The canonical release
workflow builds draft assets; publication still requires the real-board T3.
Machine-seat review is still owed.

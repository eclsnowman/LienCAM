# Uc100Net: native Linux AXBB-E transport

Apache-2.0. Provenance and limitations: ADR-0001-native-axbb-e.md.
This is route B; it supports AXBB-E firmware 1005 only. It contains no
firmware updater and refuses unvalidated firmware. It is not qualified on
real hardware yet. No USB UC100 or other Ethernet board support is claimed.

Build/publish from the LienCAM root with .NET SDK 10:

```sh
dotnet publish pendant/uccnc-bridge/uccnc-bridge-net.csproj -c Release -r linux-x64 --self-contained true -o pendant/uc100net/publish/linux-x64
dotnet publish pendant/uccnc-bridge/uccnc-bridge-net.csproj -c Release -r linux-arm64 --self-contained true -o pendant/uc100net/publish/linux-arm64
```

Stage the appropriate entire publish folder, including runtime libraries,
under resources/pendant/uccnc-bridge/native/linux-x64 (or linux-arm64).
The bridge needs a writable folder for runtime records; Electron stages the
bundle in its user-data machine-bridge-native folder. Never ship vendor DLLs
or a machine configuration. A .pro file comes from the operator.

The imported differential tests compare against DLL 2190's recorded frames,
not a freshly loaded vendor DLL. fixtures/oracle-2190.tar.gz includes only
JSONL wire observations and call markers/events, no vendor binaries. Extract
it here before running src/Uc100Net.Tests/Uc100Net.Tests.csproj. Network tests
need an isolated network with 10.10.10.10 (host) and 10.10.10.11 (fake), plus
python on PATH. Never run the fake-board exercises on a hardware network.
The tests inherited several early-return SKIPPED paths; inspect detailed
output for SKIPPED before claiming oracle coverage. Replay input stays in the
owner's read-only handoff, not in a release asset.

## Apple Silicon macOS: alpha, untested on macOS

The same native AXBB-E firmware 1005 transport can be cross-published:

```powershell
dotnet publish pendant/uccnc-bridge/uccnc-bridge-net.csproj -c Release -r osx-arm64 --self-contained true -o pendant/uc100net/publish/osx-arm64
```

Package the ENTIRE osx-arm64 folder, including boards and .NET libraries,
under resources/pendant/uccnc-bridge/native/osx-arm64. The Apple Silicon
launcher selects this route and stages it in writable user-data under
machine-bridge-native/osx-arm64. It never uses Wine or an automatic demo
fallback. Intel Mac native control is unsupported; its installer remains
available for design, simulation and posting.

Linux O61 hardware proof is recorded in the WO-2897 assignment; it does not
qualify macOS. No Mac controller readback is available. The poll thread
requests managed ThreadPriority.Highest; macOS has no Linux SCHED_FIFO
setup here. The current diagnostic string is a request, not proof of actual
scheduling, refill timing or underflow behavior. No transport/motion code
changes for Mac.

The app and nested native executable are unsigned and not notarized.
Downloaded/quarantined app launch, runtime loading and executable permission
checks on a real Mac remain owed. Local-network/firewall permission prompts
may affect discovery; exact prompt wording and allow/deny recovery have not
been observed. Do not claim Linux fake-network oracle runs are Mac tests:
the current isolated harness uses Linux network interfaces and cannot run
unchanged on macOS. Mac fake-board replay/oracle and physical Mac + board
qualification remain separate evidence owed before removing the label.

#!/bin/sh
# Run inside fake-bench.Dockerfile's image with --network none, NET_ADMIN and
# SYS_NICE, the lane mounted at /repo and its .NET 10 installation at /dotnet.
# Only an isolated dummy NIC exists. No packet can reach a real board.
set -eu
ip link add oracle0 type dummy
ip addr add 10.10.10.10/24 dev oracle0
ip addr add 10.10.10.11/24 dev oracle0
ip link set oracle0 up
ip route add 255.255.255.255 dev oracle0 src 10.10.10.10
export DOTNET_ROOT=/dotnet DOTNET_CLI_HOME=/tmp UC100NET_INTERFACES=10.10.10.10 UC100NET_EXPECT_FIFO=1
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
cd /repo/pendant/uc100net
tar -xzf fixtures/oracle-2190.tar.gz
result=0
/dotnet/dotnet vstest src/Uc100Net.Tests/bin/Release/net10.0/Uc100Net.Tests.dll '/Logger:console;verbosity=detailed' /Logger:trx /ResultsDirectory:/repo/src/tests/evidence/WO-2895/oracle-results "$@" > /tmp/wo2895-oracle.log 2>&1 || result=$?
cat /tmp/wo2895-oracle.log
if grep -q 'SKIPPED:' /tmp/wo2895-oracle.log; then
  echo 'Oracle coverage is incomplete: an imported test returned without exercising its assertion.'
  exit 2
fi
exit "$result"

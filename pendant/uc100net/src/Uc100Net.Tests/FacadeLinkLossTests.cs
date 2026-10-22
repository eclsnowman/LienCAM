using System.Diagnostics;
using System.Reflection;
using Uc100Net.Compat;
using Xunit.Abstractions;

namespace Uc100Net.Tests;

// WO-2895, architect 10-17 4:24 AM CT. Oracle: staged docs/ORACLE.md
// records GetStatus rc 1 after loss and no spontaneous recovery; RE-FINDINGS
// section 3 records the not-open latch after five failed exchanges.
[Collection(OracleNetwork.Name)]
public class FacadeLinkLossTests(ITestOutputHelper output)
{
    static Board ActiveBoard => (Board)typeof(UC100).GetField("board", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;

    static void Signal(Process fake, string signal)
    {
        using var p = Process.Start("/bin/sh", ["-c", "kill \"$1\" \"$2\"", "kill", signal, fake.Id.ToString()])!;
        p.WaitForExit();
        Assert.Equal(0, p.ExitCode);
    }

    void WithLostBoard(Action<Process, Board> check, bool estop = false)
    {
        // This test deliberately stops its own synthetic peer. Refuse all
        // host networks, including the real controller's subnet.
        Assert.True(OperatingSystem.IsLinux());
        Assert.Equal(new[] { "lo", "oracle0" }, Directory.GetDirectories("/sys/class/net").Select(Path.GetFileName).Order().ToArray());
        string root = Vectors.RepoRoot;
        Directory.CreateDirectory(Path.Combine(root, "work", "link-loss"));
        string estopFile = Path.Combine(root, "work", "link-loss", $"{Guid.NewGuid():N}.estop");
        using var fake = OracleDifferentialTests.StartFake(root, Path.Combine(root, "work", "link-loss", $"{Guid.NewGuid():N}.jsonl"), 60, "--estop-file", estopFile);
        try
        {
            Thread.Sleep(1000);
            Assert.False(fake.HasExited);
            UC100.ResetProcessState();
            UC100.Interfaces = [OracleDifferentialTests.Local];
            int count = 0, type = 0, serial = 0;
            Assert.Equal(0, UC100.ListDevices(ref count));
            Assert.Equal(1, count);
            Assert.Equal(0, UC100.DeviceInfo(1, ref type, ref serial));
            Assert.Equal((19, 0x0BEEF0), (type, serial));
            Assert.Equal(0, UC100.Open(1));
            var board = ActiveBoard;
            Assert.True(SpinWait.SpinUntil(() => board.LastStatus is not null, 2000));
            if (estop)
            {
                File.WriteAllText(estopFile, "physical estop on synthetic peer");
                Assert.True(SpinWait.SpinUntil(() => board.LastStatus?.Estop == true, 2000));
            }
            var status = new UC100.Stat();
            Assert.Equal(estop ? 7 : 0, UC100.GetStatus(ref status));
            Signal(fake, "-STOP");
            Assert.True(SpinWait.SpinUntil(() => board.LinkLost, 3000), "five dropped polls must latch loss");
            Assert.False(board.IsOpen);
            output.WriteLine($"fake serial 0BEEF0: link lost after {board.Polls} polls; cached estop={estop}");
            check(fake, board);
        }
        finally
        {
            UC100.ResetProcessState();
            if (!fake.HasExited) { fake.Kill(); fake.WaitForExit(5000); }
            File.Delete(estopFile);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Lost_link_never_reports_cached_success_or_estop(bool estop) => WithLostBoard((_, _) =>
    {
        var status = new UC100.Stat { CurrentID = 12345 };
        Assert.Equal(1, UC100.GetStatus(ref status));
        Assert.Equal(12345, status.CurrentID); // not-open reads leave the caller's output alone
    }, estop);

    [Fact]
    public void Lost_link_rejects_every_queue_route_without_adding_moves() => WithLostBoard((_, board) =>
    {
        int before = board.Puffer;
        var results = new Dictionary<string, int>
        {
            ["line"] = UC100.AddLinearMove(1, 0, 0, 0, 0, 0, 1, 101),
            ["nullable line"] = UC100.AddLinearMoveP(1, null, null, null, null, null, 1, 102),
            ["arc"] = UC100.AddCircularMove(1, 1, 0, 0, 1, 0, true, 1, 0, 103, 104),
            ["nullable arc"] = UC100.AddCircularMoveP(1, 1, null, 0, 1, 0, true, 1, 0, 104, 105),
            ["relative"] = UC100.AddLinearMoveRel(0, 1, 1, 10, false),
            ["dwell"] = UC100.AddDwell(100, 106),
            ["zero dwell"] = UC100.AddDwell(0, 107),
            ["dummy"] = UC100.AddDummyMove(108),
        };
        foreach (var result in results) output.WriteLine($"{result.Key}: rc {result.Value}");
        Assert.All(results, result => Assert.Equal(1, result.Value));
        Assert.Equal(before, board.Puffer);
    });

    [Fact]
    public void Lost_link_does_not_report_cached_readbacks_or_accept_direct_motion() => WithLostBoard((_, _) =>
    {
        double x = 12345, y = 0, z = 0, a = 0, b = 0, c = 0, value = 0;
        long bits = 12345;
        bool flag = false;
        var version = new UC100.Versio();
        var results = new Dictionary<string, int>
        {
            ["position"] = UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c),
            ["input"] = UC100.GetInput(ref bits), ["output"] = UC100.GetOutput(ref bits),
            ["version"] = UC100.GetVersio(ref version),
            ["hold"] = UC100.GetFeedHold(ref flag), ["FRO"] = UC100.GetFRO(ref value),
            ["JRO"] = UC100.GetJRO(ref value), ["SRO"] = UC100.GetSRO(ref value),
            ["offline"] = UC100.GetOffline(ref flag), ["spindle"] = UC100.GetSpindleSpeed(ref value),
            ["probe state"] = UC100.GetProbeState(ref flag),
            ["probe position"] = UC100.GetProbePosition(ref x, ref y, ref z, ref a, ref b, ref c),
            ["jog"] = UC100.JogOnSpeed(0, false, 10), ["home"] = UC100.HomeOn(0, 1, 1, false),
            ["probe"] = UC100.ProbeStart(0, 1, 1, 109),
            ["spindle on"] = UC100.SpindleOn(false), ["output on"] = UC100.SetOutputBit(1),
            ["set position"] = UC100.SetAxisPosition(0, 0, 0, 0, 0, 0),
        };
        foreach (var result in results) output.WriteLine($"{result.Key}: rc {result.Value}");
        Assert.All(results, result => Assert.Equal(1, result.Value));
    });

    [Fact]
    public void Lost_link_axis_setting_preserves_the_recorded_DLL_exception() => WithLostBoard((_, _) =>
    {
        var axis = new UC100.AxisSetting { Axis = 0 };
        Assert.Equal(0, UC100.GetAxisSetting(ref axis)); // stored settings remain readable
        Assert.Equal(14, UC100.SetAxisSetting(ref axis)); // handoff ORACLE.md, not the generic rc 1
    });

    [Fact]
    public void Returned_peer_stays_not_open_until_explicit_reopen() => WithLostBoard((fake, board) =>
    {
        Signal(fake, "-CONT");
        Thread.Sleep(250);
        var status = new UC100.Stat();
        Assert.Equal(1, UC100.GetStatus(ref status));
        Assert.Equal(1, UC100.AddDummyMove(999));
        Assert.Null(board.PollOnce()); // even an explicit tick cannot revive/stream the stale session
        Assert.True(board.LinkLost);
        Assert.Equal(0, UC100.Close());
        Assert.Equal(0, UC100.Open(1));
        var reopened = ActiveBoard;
        Assert.NotSame(board, reopened);
        Assert.True(SpinWait.SpinUntil(() => reopened.LastStatus is not null, 2000));
        Assert.Equal(0, UC100.GetStatus(ref status));
        Assert.True(status.Idle);
        Assert.Equal(0, status.Puffer);
        Assert.Equal(0, reopened.RecordsSent);
        Assert.Equal(0, UC100.AddDummyMove(1000));
        Assert.True(SpinWait.SpinUntil(() => { UC100.GetStatus(ref status); return status.CurrentID == 1000 && status.Idle; }, 2000));
        output.WriteLine("explicit Close/Open: fresh status rc 0, no old moves, new dummy completed");
    });
}

using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Text.Json;
using Xunit.Abstractions;

namespace Uc100Net.Tests;

/// <summary>
/// Every test that starts tools/fake_board.py on 10.10.10.11. xUnit runs test
/// classes in parallel; two fakes cannot bind the same address, so these run
/// one at a time.
/// </summary>
[CollectionDefinition(Name)]
public sealed class OracleNetwork { public const string Name = "UC-Oracle network"; }

/// <summary>
/// Uc100Net against tools/fake_board.py on the private UC-Oracle switch,
/// compared frame by frame with what the real UC100.dll 2190 sent in the
/// oracle runs (work/oracle/*.jsonl). Skips unless 10.10.10.10 is a local
/// address, python is on PATH and the oracle logs exist.
/// </summary>
[Collection(OracleNetwork.Name)]
public class OracleDifferentialTests(ITestOutputHelper output)
{
    internal static readonly IPAddress Local = IPAddress.Parse("10.10.10.10");
    internal static readonly IPAddress Broadcast = IPAddress.Parse("10.10.10.255");

    internal static bool OracleNetworkPresent() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Any(a => a.Address.Equals(Local));

    static List<(byte Cmd, byte[] Plain)> SessionFrames(string jsonl) =>
        File.ReadLines(jsonl)
            .Select(l => JsonDocument.Parse(l).RootElement)
            .Where(r => r.GetProperty("port").GetInt32() == 4912)
            .Select(r => Convert.FromHexString(r.GetProperty("plain").GetString()!))
            .Select(p => (p[3], p))
            .ToList();

    static int lastFakePid = -1;

    /// <summary>
    /// Start tools/fake_board.py at High priority: on a busy host a starved
    /// fake answers late and the stream falls behind (docs/ORACLE.md). A fake
    /// an earlier test left running still holds 10.10.10.11 (seen once in the
    /// Linux container: the next fake failed with "address already in use"),
    /// so it is killed first.
    /// </summary>
    internal static Process StartFake(string root, string log, int seconds, params string[] extra)
    {
        // By pid: the tests dispose their Process objects. Only a python process
        // still running under that pid counts (pids get reused).
        if (lastFakePid > 0)
        try
        {
            using var left = Process.GetProcessById(lastFakePid);
            if (!left.HasExited && left.ProcessName.Contains("python", StringComparison.OrdinalIgnoreCase))
            {
                Console.Error.WriteLine($"StartFake: killing a fake board left running (pid {lastFakePid})");
                left.Kill();
                left.WaitForExit(5000);
            }
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException) { }   // it exited (Linux reports that late)
        var fake = Process.Start(new ProcessStartInfo("python",
            ["-I", Path.Combine(root, "tools", "fake_board.py"), "--log", log, "--duration", seconds.ToString(), .. extra])
        { RedirectStandardOutput = true, UseShellExecute = false })!;
        lastFakePid = fake.Id;
        try { fake.PriorityClass = ProcessPriorityClass.High; } catch (Exception) { }   // best effort (Linux needs privileges)
        return fake;
    }

    /// <summary>Payload only: nonce and checksum differ per frame by design.</summary>
    static string Payload(byte[] plain) => Convert.ToHexString(plain.AsSpan(6, plain.Length - 8));

    static List<byte[]> Records(IEnumerable<(byte Cmd, byte[] Plain)> frames) =>
        frames.Where(f => f.Cmd == (byte)Command.Motion)
              .SelectMany(f => Enumerable.Range(0, f.Plain[6])
                  .Select(i => f.Plain.AsSpan(7 + Board.RecordLength * i, Board.RecordLength).ToArray()))
              .ToList();

    /// <summary>
    /// Uc100Net on its own: plan the oracle program (square + arc) with
    /// <see cref="Planner"/> at the oracle's settings, stream it through
    /// <see cref="Board"/> into the fake, and compare the positions the fake
    /// received with the records the DLL sent for the same program: the
    /// anti-dive command record byte-identical, positions to 1e-9 mm.
    /// </summary>
    [Fact]
    public void Uc100Net_plans_and_streams_the_program_like_the_DLL()
    {
        string root = Vectors.RepoRoot;
        string oracle = Path.Combine(root, "work", "oracle");
        string program = Path.Combine(oracle, "program2.jsonl");
        if (!OracleNetworkPresent() || !File.Exists(program))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network and work/oracle/program2.jsonl");
            return;
        }
        var dll = Records(SessionFrames(program));

        double f = 1000.0 / 60;
        double[] P(double x, double y) => [x, y, 0, 0, 0, 0];
        var planner = new Planner([1000, 1000, 1000, 1000, 1000, 1000], [150, 10000.0 / 60, 8000.0 / 60, 1e9, 1e9, 1e9],
            new TrajSettings(ConstantVel: true, StopAngle: 89, CornerError: 0.03, LinearErr: 0.03));
        var samples = planner.PlanRecords(new double[6],
        [
            new Planner.Line(P(10, 0), f), new Planner.Line(P(10, 10), f), new Planner.Line(P(0, 10), f),
            new Planner.Line(P(0, 0), f), new Planner.Line(P(20, 0), f), new Planner.Arc([0, 0, 0], 10, 0, true, f),
        ]);

        string log = Path.Combine(oracle, "uc100net-planned.jsonl");
        using var fake = StartFake(root, log, 10);
        Thread.Sleep(1200);
        var found = Discovery.Scan(Local, Broadcast, TimeSpan.FromMilliseconds(500));
        Assert.Single(found);
        using (var board = new Board(found[0], Local) { BufferSeconds = 0.1 })
        {
            board.Open();
            foreach (var r in samples) board.EnqueueRecord(r);
            var sw = Stopwatch.StartNew();
            while (board.PendingRecords > 0 && sw.Elapsed < TimeSpan.FromSeconds(8)) Thread.Sleep(50);
            Thread.Sleep(300);
            output.WriteLine($"planned {samples.Count} samples, sent {board.RecordsSent} in {sw.Elapsed.TotalSeconds:F2} s, " +
                             $"{board.MotionFrameFailures} frame failures");
            Assert.Equal(0, board.PendingRecords);
            Assert.False(board.LinkLost);
        }
        fake.WaitForExit(20000);

        var received = Records(SessionFrames(log));
        Assert.Equal(dll.Count, received.Count);
        double worst = 0;
        for (int i = 0; i < dll.Count; i++)
        {
            Assert.Equal(MotionRecord.IsCommand(dll[i]), MotionRecord.IsCommand(received[i]));
            if (MotionRecord.IsCommand(dll[i])) { Assert.Equal(dll[i], received[i]); continue; }
            for (int a = 0; a < 6; a++)
                worst = Math.Max(worst, Math.Abs(BitConverter.ToDouble(dll[i], 8 * a) - BitConverter.ToDouble(received[i], 8 * a)));
        }
        output.WriteLine($"{received.Count} records received (command records identical), max position difference from the DLL's {worst:E2} mm");
        Assert.True(worst < 1e-9);
    }

    /// <summary>
    /// Live planning through Board (docs/STREAMING.md step 5): a 100 mm line at
    /// 50 mm/s on an attached Planner.Stream, feed hold after 0.6 s, release
    /// 1 s later. The timing is real, so instead of exact samples this checks
    /// what the fake received: it ends exactly on 100, never exceeds 50 mm/s
    /// or 1000 mm/s^2 (no jump anywhere), holds still for most of a second
    /// mid-line, and the anti-dive records read 0 while held and 25 after.
    /// </summary>
    [Fact]
    public void Feed_hold_through_Board_is_smooth_and_lands_on_target()
    {
        string root = Vectors.RepoRoot;
        string oracle = Path.Combine(root, "work", "oracle");
        if (!OracleNetworkPresent())
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network");
            return;
        }
        string log = Path.Combine(oracle, "uc100net-feedhold.jsonl");
        using var fake = StartFake(root, log, 10);
        Thread.Sleep(1200);
        var found = Discovery.Scan(Local, Broadcast, TimeSpan.FromMilliseconds(500));
        Assert.Single(found);
        var planner = new Planner([1000, 1000, 1000, 1000, 1000, 1000], [150, 10000.0 / 60, 8000.0 / 60, 1e9, 1e9, 1e9],
            new TrajSettings(ConstantVel: true, StopAngle: 89, CornerError: 0.03, LinearErr: 0.03));
        using (var board = new Board(found[0], Local) { BufferSeconds = 0.1 })
        {
            board.Open();
            board.AttachStream(new Planner.Stream(planner, new double[6]));
            board.AddMove(new Planner.Line([100, 0, 0, 0, 0, 0], 50));
            Thread.Sleep(600);
            board.FeedHold(true);
            Thread.Sleep(1000);
            board.FeedHold(false);
            var sw = Stopwatch.StartNew();
            while (!(board.MotionDone && board.LastStatus?.BufferFill <= 1) && sw.Elapsed < TimeSpan.FromSeconds(6)) Thread.Sleep(50);
            output.WriteLine($"sent {board.RecordsSent} records, {board.MotionFrameFailures} frame failures");
            Assert.True(board.MotionDone);
            Assert.False(board.LinkLost);
        }
        fake.WaitForExit(20000);

        var records = Records(SessionFrames(log));
        var x = records.Where(r => !MotionRecord.IsCommand(r)).Select(r => BitConverter.ToDouble(r, 0)).ToList();
        var antiDive = records.Where(r => MotionRecord.IsCommand(r) && r[32] == MotionRecord.AntiDiveType)
                              .Select(r => BitConverter.ToDouble(r, 40)).ToList();
        double tau = Planner.SamplePeriod, vMax = 0, dvMax = 0;
        for (int i = 1; i < x.Count; i++)
        {
            double v = (x[i] - x[i - 1]) / tau;
            vMax = Math.Max(vMax, Math.Abs(v));
            if (i > 1) dvMax = Math.Max(dvMax, Math.Abs(v - (x[i - 1] - x[i - 2]) / tau));
        }
        int longestHold = 0, run = 0;
        double holdAt = double.NaN;
        for (int i = 1; i < x.Count; i++)
        {
            run = x[i] == x[i - 1] ? run + 1 : 0;
            if (run > longestHold) { longestHold = run; holdAt = x[i]; }
        }
        output.WriteLine($"{x.Count} positions, end {x[^1]:R}, max speed {vMax:F6} mm/s, max speed step {dvMax:F6} mm/s " +
                         $"(limit {1000 * tau:F6}), longest hold {longestHold} samples at x = {holdAt:F4}, anti-dive [{string.Join(", ", antiDive)}]");
        Assert.True(Math.Abs(x[^1] - 100) < 1e-9);
        Assert.True(vMax <= 50 + 1e-9);
        Assert.True(dvMax <= 1000 * tau + 1e-9);
        Assert.True(longestHold >= 500 && holdAt is > 10 and < 90);
        Assert.Equal([25.0, 0.0, 25.0], antiDive);
    }

    /// <summary>
    /// Stream the DLL's own records for the oracle program (square + arc, 4,380
    /// records) through Uc100Net into the fake board: the fake must receive the
    /// identical sequence, with no frame over 30 records and the buffer never
    /// over capacity.
    /// </summary>
    [Fact]
    public void Uc100Net_streams_the_DLL_program_intact()
    {
        string root = Vectors.RepoRoot;
        string oracle = Path.Combine(root, "work", "oracle");
        string program = Path.Combine(oracle, "program2.jsonl");
        if (!OracleNetworkPresent() || !File.Exists(program))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network and work/oracle/program2.jsonl");
            return;
        }
        var dll = Records(SessionFrames(program));
        Assert.Equal(4380, dll.Count);

        string log = Path.Combine(oracle, "uc100net-stream.jsonl");
        using var fake = StartFake(root, log, 10);
        Thread.Sleep(1200);
        var found = Discovery.Scan(Local, Broadcast, TimeSpan.FromMilliseconds(500));
        Assert.Single(found);
        using (var board = new Board(found[0], Local) { BufferSeconds = 0.1 })
        {
            board.Open();
            foreach (var r in dll) board.EnqueueRecord(r);
            var sw = Stopwatch.StartNew();
            while (board.PendingRecords > 0 && sw.Elapsed < TimeSpan.FromSeconds(8)) Thread.Sleep(50);
            Thread.Sleep(300);
            output.WriteLine($"sent {board.RecordsSent} records in {sw.Elapsed.TotalSeconds:F2} s, " +
                             $"{board.MotionFrameFailures} frame failures, last fill {board.LastStatus?.BufferFill}");
            Assert.Equal(0, board.PendingRecords);
            Assert.False(board.LinkLost);
        }
        fake.WaitForExit(20000);

        var ours = SessionFrames(log);
        var received = Records(ours);
        Assert.Equal(dll.Count, received.Count);
        for (int i = 0; i < dll.Count; i++)
            Assert.True(dll[i].AsSpan().SequenceEqual(received[i]), $"record {i} differs");
        int maxPerFrame = ours.Where(f => f.Cmd == (byte)Command.Motion).Max(f => (int)f.Plain[6]);
        Assert.True(maxPerFrame <= Board.MaxRecordsPerFrame);
        int maxFill = File.ReadLines(log).Select(l => JsonDocument.Parse(l).RootElement)
            .Select(r => r.GetProperty("note").GetString() ?? "")
            .Where(n => n.StartsWith("fill ")).Max(n => int.Parse(n[5..]));
        output.WriteLine($"max records per frame {maxPerFrame}, max board fill {maxFill} (capacity 88)");
        Assert.True(maxFill <= 88 + 1);
    }

    [Fact]
    public void Uc100Net_sends_what_the_DLL_sends()
    {
        string root = Vectors.RepoRoot;
        string oracle = Path.Combine(root, "work", "oracle");
        string[] needed = ["open1.jsonl", "jog.jsonl", "home.jsonl"];
        if (!OracleNetworkPresent() || needed.Any(f => !File.Exists(Path.Combine(oracle, f))))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network (10.10.10.10) and work/oracle/{open1,jog,home}.jsonl");
            return;
        }
        string log = Path.Combine(oracle, "uc100net-diff.jsonl");
        using var fake = StartFake(root, log, 6);
        Thread.Sleep(1200);

        var found = Discovery.Scan(Local, Broadcast, TimeSpan.FromMilliseconds(500));
        Assert.Single(found);
        output.WriteLine($"found {found[0].Address} serial 0x{found[0].SerialNumber:X} fw {found[0].Firmware}");
        using (var board = new Board(found[0], Local))
        {
            board.Open();
            Thread.Sleep(300);
            Assert.True(board.LastStatus?.Ready);
            // Configure() for X, as the DLL's SetAxisSetting sends it.
            board.Settings.SetAxis(0, board.Settings.Axes[0] with { Enable = true, StepPer = 400, MaxVel = 150, MaxAccel = 1000, HomePin = 1 });
            Assert.True(board.SendSettings());
            Assert.True(board.Jog(0, -15.0));
            Thread.Sleep(300);
            Assert.True(board.LastStatus?.Jog);
            Assert.True(board.JogStop(0));
            Assert.True(board.Home(2, 25.0, 25.0 / 6.0));
            Thread.Sleep(300);
            Assert.True(board.LastStatus?.Homing);
            Assert.True(board.Stop());
            Assert.False(board.LinkLost);
            output.WriteLine($"polls {board.Polls}");
        }
        fake.WaitForExit(15000);
        output.WriteLine(fake.StandardOutput.ReadToEnd());

        var ours = SessionFrames(log);
        var dllOpen = SessionFrames(Path.Combine(oracle, "open1.jsonl"));
        // The Open sequence: settings block, 0x0a, 0x01, Stop.
        var ourOpen = ours.Where(f => f.Cmd != (byte)Command.Status).Take(4).ToList();
        var theirOpen = dllOpen.Where(f => f.Cmd != (byte)Command.Status).Take(4).ToList();
        Assert.Equal(theirOpen.Select(f => f.Cmd), ourOpen.Select(f => f.Cmd));
        Assert.Equal(theirOpen.Select(f => Payload(f.Plain)), ourOpen.Select(f => Payload(f.Plain)));
        // The status poll.
        Assert.Equal(Payload(dllOpen.First(f => f.Cmd == (byte)Command.Status).Plain),
                     Payload(ours.First(f => f.Cmd == (byte)Command.Status).Plain));
        // Settings after configuring X: the DLL's second 0x0D and first 0x09 in planes.jsonl.
        string planes = Path.Combine(oracle, "planes.jsonl");
        if (File.Exists(planes))
        {
            var dllFrames = SessionFrames(planes);
            foreach (var (cmd, index) in new[] { (Command.Settings, 1), (Command.AxisBlock, 0) })
            {
                string theirs = Payload(dllFrames.Where(f => f.Cmd == (byte)cmd).ElementAt(index).Plain);
                string mine = Payload(ours.Where(f => f.Cmd == (byte)cmd).ElementAt(index).Plain);
                output.WriteLine($"{cmd} after configuring X: {(theirs == mine ? "identical" : "DIFFERENT")} ({mine.Length / 2} bytes)");
                Assert.Equal(theirs, mine);
            }
        }
        // Jog, jog stop and home: same payloads as the DLL's JogOnSpeed(0, true, 10)
        // (= -15 units/s), JogOnSpeed(0, true, 0) and HomeOn(2, 25, 25/6, false).
        foreach (var (cmd, file) in new[] { (Command.Jog, "jog.jsonl"), (Command.JogStop, "jog.jsonl"), (Command.Home, "home.jsonl") })
        {
            string theirs = Payload(SessionFrames(Path.Combine(oracle, file)).First(f => f.Cmd == (byte)cmd).Plain);
            string mine = Payload(ours.First(f => f.Cmd == (byte)cmd).Plain);
            output.WriteLine($"{cmd}: DLL {theirs} / Uc100Net {mine}");
            Assert.Equal(theirs, mine);
        }
    }
}

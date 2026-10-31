using System.Diagnostics;
using System.Text.Json;
using Xunit.Abstractions;
using static Uc100Net.Planner;

namespace Uc100Net.Tests;

/// <summary>
/// Stat fields (docs/STREAMING.md, "Status"): the programs of OracleDriver
/// StatScenario() run through Board and Planner.Stream into the fake, and
/// Board's CurrentId / Puffer / Idle are sampled as the DLL's GetStatus was
/// (work/oracle/stat-status.jsonl). Real time on both sides, so this compares
/// what does not depend on poll timing: the order of the CurrentID values,
/// the order of the Puffer values, and where the machine was when CurrentID
/// changed (within one status poll of travel). Skips without the UC-Oracle
/// network or the stat corpus.
/// </summary>
[Collection(OracleNetwork.Name)]
public class StatusDifferentialTests(ITestOutputHelper output)
{
    record Sample(double Wall, double X, double Y, bool Idle, int Puffer, int CurrentId);

    static double Now() => DateTime.UtcNow.Subtract(DateTime.UnixEpoch).TotalSeconds;

    /// <summary>The DLL's GetStatus log, split by the scenario's markers.</summary>
    static Dictionary<string, List<Sample>> DllPrograms(string dir)
    {
        var marks = File.ReadLines(Path.Combine(dir, "stat-markers.jsonl")).Select(l => JsonDocument.Parse(l).RootElement)
            .Select(e => (Name: e.GetProperty("experiment").GetString()!, Wall: e.GetProperty("wall").GetDouble())).ToList();
        var all = File.ReadLines(Path.Combine(dir, "stat-status.jsonl")).Select(l => JsonDocument.Parse(l).RootElement).Select(e =>
        {
            var f = e.GetProperty("stat").GetString()!.Split(' ').Select(kv => kv.Split('=', 2)).ToDictionary(kv => kv[0], kv => kv[1]);
            return new Sample(e.GetProperty("wall").GetDouble(), e.GetProperty("x").GetDouble(), e.GetProperty("y").GetDouble(),
                bool.Parse(f["Idle"]), int.Parse(f["Puffer"]), int.Parse(f["CurrentID"]));
        }).ToList();
        var programs = new Dictionary<string, List<Sample>>();
        for (int i = 0; i + 1 < marks.Count; i++)
            if (marks[i].Name.EndsWith(" start"))
                programs[marks[i].Name[..^6]] = [.. all.Where(s => s.Wall > marks[i].Wall && s.Wall <= marks[i + 1].Wall)];
        return programs;
    }

    static List<int> Distinct(IEnumerable<int> values)
    {
        var list = new List<int>();
        foreach (int v in values) if (list.Count == 0 || list[^1] != v) list.Add(v);
        return list;
    }

    /// <summary>True when every element of <paramref name="part"/> appears in <paramref name="whole"/>, in order.</summary>
    static bool IsSubsequence(List<int> part, List<int> whole)
    {
        int i = 0;
        foreach (int v in whole) if (i < part.Count && part[i] == v) i++;
        return i == part.Count;
    }

    /// <summary>Where the machine was at each change of CurrentID.</summary>
    static List<(int Id, double X, double Y)> Switches(List<Sample> samples) =>
        [.. samples.Where((s, i) => i > 0 && s.CurrentId != samples[i - 1].CurrentId).Select(s => (s.CurrentId, s.X, s.Y))];

    [Fact]
    public void CurrentId_Puffer_and_Idle_follow_the_DLL()
    {
        string root = Vectors.RepoRoot, dir = Path.Combine(root, "work", "oracle");
        if (!OracleDifferentialTests.OracleNetworkPresent() || !File.Exists(Path.Combine(dir, "stat-status.jsonl")))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network and the stat corpus");
            return;
        }
        var dll = DllPrograms(dir);
        using var fake = OracleDifferentialTests.StartFake(root, Path.Combine(dir, "uc100net-stat.jsonl"), 40);
        Thread.Sleep(1200);
        var found = Discovery.Scan(OracleDifferentialTests.Local, OracleDifferentialTests.Broadcast, TimeSpan.FromMilliseconds(500));
        Assert.Single(found);
        var planner = new Planner([1000, 1000, 1000, 1000, 1000, 1000], [150, 10000.0 / 60, 8000.0 / 60, 1e9, 1e9, 1e9],
            new TrajSettings(ConstantVel: true, StopAngle: 89, CornerError: 0.03, LinearErr: 0.03));
        double f = 1000.0 / 60, fast = 100;
        static double[] P(double x, double y) => [x, y, 0, 0, 0, 0];
        var ours = new Dictionary<string, List<Sample>>();
        var idsOf = new Dictionary<string, List<int>>();   // each program's IDs in order
        var failures = new List<string>();
        using (var board = new Board(found[0], OracleDifferentialTests.Local) { BufferSeconds = 0.1 })
        {
            board.Open();
            board.AttachStream(new Planner.Stream(planner, new double[6]));

            // Sample while the program runs (it may sleep between its calls), until idle.
            List<Sample> Run(Action adds, Action? then = null)
            {
                adds();
                Action program = then ?? (() => { });
                var samples = new List<Sample>();
                void Take()
                {
                    var st = board.LastStatus;
                    var s = new Sample(Now(), st is null ? 0 : st.PositionSteps[0] / 400.0, st is null ? 0 : st.PositionSteps[1] / 400.0,
                        board.Idle, board.Puffer, board.CurrentId);
                    if (samples.Count == 0 || samples[^1] with { Wall = s.Wall } != s) samples.Add(s);
                }
                var task = Task.Run(program);
                var sw = Stopwatch.StartNew();
                while (!(task.IsCompleted && board.Idle && sw.ElapsedMilliseconds > 300) && sw.ElapsedMilliseconds < 10000)
                {
                    Take();
                    Thread.Sleep(2);
                }
                Take();
                task.Wait();
                return samples;
            }

            idsOf["ids"] = [201, 202, 203, 204, 205, 206];
            ours["ids"] = Run(() =>
            {
                board.AddMove(new Line(P(10, 0), f), 201);
                board.AddMove(new Line(P(10 + 10 * Math.Cos(Math.PI / 6), 10 * Math.Sin(Math.PI / 6)), f), 202);
                board.AddMove(new Line(P(10, 10), f), 203);
                board.AddMove(new Dwell(0.25), 204);
                board.AddMove(new Dummy(), 205);
                board.AddMove(new Line(P(0, 0), fast), 206);
            });
            idsOf["merge"] = [601, 602, 603, 604];
            ours["merge"] = Run(() =>
            {
                board.AddMove(new Line(P(10, 0), f), 601); board.AddMove(new Line(P(20, 0), f), 602);
                board.AddMove(new Line(P(30, 0), f), 603); board.AddMove(new Line(P(30, 10), f), 604);
            });
            idsOf["merge return"] = [605];
            ours["merge return"] = Run(() => board.AddMove(new Line(P(0, 0), fast), 605));
            idsOf["stop"] = [301, 302, 303];
            ours["stop"] = Run(() =>
            {
                board.AddMove(new Line(P(50, 0), 50), 301); board.AddMove(new Line(P(50, 50), 50), 302); board.AddMove(new Line(P(0, 50), 50), 303);
            }, () =>
            {
                Thread.Sleep(600);
                Assert.True(board.Stop());
            });
            idsOf["stop return"] = [304];
            ours["stop return"] = Run(() => board.AddMove(new Line(P(0, 0), fast), 304));
            idsOf["hold"] = [401];
            ours["hold"] = Run(() => board.AddMove(new Line(P(100, 0), 50), 401), () =>
            {
                Thread.Sleep(500); board.FeedHold(true);
                Thread.Sleep(500); board.FeedHold(false);
            });
            idsOf["hold return"] = [402];
            ours["hold return"] = Run(() => board.AddMove(new Line(P(0, 0), fast), 402));
            idsOf["reopen before"] = [501];
            ours["reopen before"] = Run(() => board.AddMove(new Line(P(10, 0), f), 501));
            board.Close();
            int kept = board.CurrentId;
            board.Open();
            Thread.Sleep(300);
            output.WriteLine($"CurrentId before Close {kept}, after Open {board.CurrentId}");
            if (board.CurrentId != 501) failures.Add($"CurrentId after Close / Open is {board.CurrentId}, the DLL keeps 501");
            Assert.False(board.LinkLost);
        }
        fake.WaitForExit(60000);

        foreach (var (name, mine) in ours)
        {
            var theirs = dll[name];
            var idsD = Distinct(theirs.Select(s => s.CurrentId)); var idsO = Distinct(mine.Select(s => s.CurrentId));
            var pD = Distinct(theirs.Select(s => s.Puffer)); var pO = Distinct(mine.Select(s => s.Puffer));
            var swD = Switches(theirs); var swO = Switches(mine);
            output.WriteLine($"{name}: CurrentID dll [{string.Join(" ", idsD)}] ours [{string.Join(" ", idsO)}]; " +
                             $"Puffer dll [{string.Join(" ", pD)}] ours [{string.Join(" ", pO)}]");
            for (int i = 0; i < Math.Max(swD.Count, swO.Count); i++)
                output.WriteLine($"   switch {i}: dll {(i < swD.Count ? $"{swD[i].Id} at {swD[i].X:F3},{swD[i].Y:F3}" : "-")}" +
                                 $" | ours {(i < swO.Count ? $"{swO[i].Id} at {swO[i].X:F3},{swO[i].Y:F3}" : "-")}");
            // A status poll every 31.7 ms can miss a short move (a dummy move is
            // one 1.28 ms sample) on either side, and the first value is the one
            // carried over from the program before. So: after that first value,
            // the DLL's IDs appear in ours in order, ours follow the program, and
            // Puffer counts down from the same value to 0 on both sides.
            if (!IsSubsequence([.. idsD.Skip(1)], idsO) || !IsSubsequence([.. idsO.Skip(1)], idsOf[name])) failures.Add($"{name}: CurrentID order");
            if (pD[0] != pO[0] || pD[^1] != pO[^1] || pO.Zip(pO.Skip(1)).Any(z => z.Second > z.First)) failures.Add($"{name}: Puffer");
            // One status poll (31.7 ms) at up to 100 mm/s is 3.2 mm; both sides sample a poll late at most.
            // After a Stop the start point depends on when Stop landed, so no places to compare.
            if (name != "stop return" && swD.Count == swO.Count && swD.Zip(swO).Any(z => Math.Abs(z.First.X - z.Second.X) + Math.Abs(z.First.Y - z.Second.Y) > 3.5))
                failures.Add($"{name}: CurrentID changes at a different place");
            if (!mine[^1].Idle) failures.Add($"{name}: not Idle at the end");
        }
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }
}

using System.Text.Json;
using static Uc100Net.Planner;

namespace Uc100Net.Tests;

/// <summary>
/// OracleDriver Realtime2() (docs/STREAMING.md): FRO changes and feed holds
/// during a blend, with moves queued, on arcs and near the end of a move,
/// and the decelerating stops. The DLL's change samples are not logged; for
/// each change in turn the search tries every sample in a window before the
/// first record where the DLL departs from the plan without it, and keeps
/// the one that reproduces the DLL furthest.
/// </summary>
public partial class PlannerTests
{
    sealed record Change(string Name, Action<Planner.Stream> Apply);

    /// <summary>Stream records with each change applied after the given number of position samples.</summary>
    static List<byte[]> RunStream(Func<Planner.Stream> make, IReadOnlyList<Change> changes, IReadOnlyList<int> after)
    {
        var stream = make();
        var ours = new List<byte[]>();
        int samples = 0;
        for (int i = 0; i < after.Count; i++)
        {
            while (samples < after[i] && stream.Next() is byte[] r) { ours.Add(r); if (!MotionRecord.IsCommand(r)) samples++; }
            changes[i].Apply(stream);
        }
        for (int guard = 0; guard < 200000 && stream.Next() is byte[] r; guard++) ours.Add(r);
        return ours;
    }

    /// <summary>Index of the first record that differs (count included), or -1 when identical.</summary>
    static int Diverge(List<byte[]> dll, List<byte[]> ours)
    {
        int n = Math.Min(dll.Count, ours.Count);
        for (int i = 0; i < n; i++)
            if (!Same(dll[i], ours[i])) return i;
        return dll.Count == ours.Count ? -1 : n;
    }

    static bool Same(byte[] dll, byte[] ours)
    {
        if (MotionRecord.IsCommand(dll) || MotionRecord.IsCommand(ours)) return MotionRecord.SameCommand(dll, ours);
        for (int a = 0; a < 6; a++)
            if (Math.Abs(BitConverter.ToDouble(dll, 8 * a) - BitConverter.ToDouble(ours, 8 * a)) > 1e-9) return false;
        return true;
    }

    /// <summary><see cref="Diverge"/> of <see cref="RunStream"/>, stopping at the first difference.</summary>
    static int DivergeRun(Func<Planner.Stream> make, IReadOnlyList<Change> changes, IReadOnlyList<int> after, List<byte[]> dll)
    {
        var stream = make();
        int n = 0, samples = 0, c = 0;
        while (true)
        {
            while (c < after.Count && samples >= after[c]) changes[c++].Apply(stream);
            if (stream.Next() is not byte[] r) break;
            if (n >= dll.Count || !Same(dll[n], r)) return n;
            n++;
            if (!MotionRecord.IsCommand(r)) samples++;
        }
        return n == dll.Count ? -1 : n;
    }

    static int SamplesBefore(List<byte[]> records, int index) =>
        records.Take(index).Count(r => !MotionRecord.IsCommand(r));

    /// <summary>
    /// For each change in order, the sample count after which applying it
    /// reproduces the DLL furthest. Returns the samples, and the final
    /// divergence (-1 = identical).
    /// </summary>
    static (int[] After, int Diverge) FindChanges(Func<Planner.Stream> make, List<byte[]> dll, IReadOnlyList<Change> changes, int window = 200)
    {
        var after = new List<int>();
        int d = DivergeRun(make, changes, after, dll);
        for (int c = 0; c < changes.Count && d >= 0; c++)
        {
            int hi = SamplesBefore(dll, d), best = -1, bestD = d;
            for (int k = Math.Max(after.Count > 0 ? after[^1] : 0, hi - window); k <= hi; k++)
            {
                int dk = DivergeRun(make, changes, [.. after, k], dll);
                if (dk < 0) { best = k; bestD = -1; break; }
                if (dk > bestD) { best = k; bestD = dk; }
            }
            if (best < 0) break;
            after.Add(best);
            d = bestD;
        }
        return ([.. after], d);
    }

    /// <summary>Every motion record in a frame log with the wall time of its frame (parsed once; DllRecords reads the file per call).</summary>
    static List<(double Wall, byte[] Record)> AllRecords(string jsonl)
    {
        var list = new List<(double, byte[])>();
        using var reader = new StreamReader(new FileStream(jsonl, FileMode.Open, FileAccess.Read, FileShare.ReadWrite));
        for (string? line; (line = reader.ReadLine()) != null; )
        {
            var r = JsonDocument.Parse(line).RootElement;
            if (r.GetProperty("port").GetInt32() != 4912 || r.GetProperty("cmd").GetInt32() != 2) continue;
            double wall = r.TryGetProperty("wall", out var w) ? w.GetDouble() : 0;
            byte[] p = Convert.FromHexString(r.GetProperty("plain").GetString()!);
            for (int i = 0; i < p[6]; i++) list.Add((wall, p.AsSpan(7 + 48 * i, 48).ToArray()));
        }
        return list;
    }

    static List<byte[]> Between(List<(double Wall, byte[] Record)> all, double from, double to) =>
        [.. all.Where(x => x.Wall > from && x.Wall <= to).Select(x => x.Record)];

    static List<(string Name, double Wall)> Markers(string path) =>
        [.. File.ReadLines(path).Select(l => JsonDocument.Parse(l).RootElement)
            .Select(e => (e.GetProperty("experiment").GetString()!, e.GetProperty("wall").GetDouble()))];

    /// <summary>The programs of Realtime2(), by name, with their moves and changes.</summary>
    static IEnumerable<(string Name, Move[] Moves, Change[] Changes)> Realtime2Programs(IEnumerable<string> names)
    {
        double d5 = 5 * Math.PI / 180;
        var b5 = P(100 + 100 * Math.Cos(d5), 100 * Math.Sin(d5));
        Change Fro(double f) => new($"SetFRO {f}", s => s.SetFro(f));
        Change Hold(bool on) => new($"FeedHold {on}", s => s.FeedHold(on));
        foreach (string name in names)
        {
            string[] w = name.Split(' ');
            if (name.StartsWith("blend fro "))
                yield return (name, [new Line(P(100, 0), 50), new Line(b5, 50)], [Fro(50)]);
            else if (name.StartsWith("blend hold "))
                yield return (name, [new Line(P(100, 0), 50), new Line(b5, 50)], [Hold(true), Hold(false)]);
            else if (name.StartsWith("queued fro "))
                yield return (name, [new Line(P(50, 0), 50), new Line(P(50, 50), 50),
                    new Line(P(50 - 50 * Math.Sin(Math.PI / 6), 50 + 50 * Math.Cos(Math.PI / 6)), 50)], [Fro(double.Parse(w[2]))]);
            else if (name == "queued blend fro 50")
                yield return (name, [new Line(P(50, 0), 50), new Line(Turn(50, 0, 30, 50), 50)], [Fro(50)]);
            else if (name == "arc fro")
                yield return (name, [new Line(P(20, 0), 50), new Arc([20, 0, 0], 0, 0, true, 50)], [Fro(50), Fro(100)]);
            else if (name == "arc hold")
                yield return (name, [new Line(P(20, 0), 50), new Arc([20, 0, 0], 0, 0, true, 50)], [Hold(true), Hold(false)]);
            else if (name == "arc fro 150 cap")
                yield return (name, [new Line(P(5, 0), 60), new Arc([5, 0, 0], 0, 0, true, 60)], [Fro(150)]);
            else if (name.StartsWith("end hold "))
                yield return (name, [new Line(P(100, 0), 50)], [Hold(true), Hold(false)]);
            else if (name.StartsWith("end fro "))
                yield return (name, [new Line(P(100, 0), 50)], [Fro(double.Parse(w[2]))]);
            else if (name == "stop decel")
                yield return (name, [new Line(P(100, 0), 50)], [new("StopWithDecel", st => st.StopWithDecel())]);
            else if (name == "stop decel queued")
                yield return (name, [new Line(P(100, 0), 50), new Line(b5, 50)], [new("StopWithDecel", st => st.StopWithDecel())]);
            else if (name == "stop end of segment")
                yield return (name, [new Line(P(30, 0), 50), new Line(P(30, 30), 50), new Line(P(0, 30), 50)],
                    [new("StopEndOfSegment", st => st.StopEndOfSegment())]);
        }
    }

    /// <summary>
    /// Every Realtime2() program: the change samples found (they fall on the
    /// DLL generator's passes, about every 12 samples) must make Planner.Stream
    /// reproduce the DLL record for record. A change listed as "none" came
    /// after the motion it could affect had ended.
    /// </summary>
    [Fact]
    public void Realtime2_changes_while_running_match_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "realtime2.jsonl"), marks = Path.Combine(dir, "realtime2-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: realtime2 corpus missing"); return; }
        var m = Markers(marks);
        var all = AllRecords(frames);
        var names = m.Where(x => x.Name.EndsWith(" start") && !x.Name.Contains("return")).Select(x => x.Name[..^6]);
        var programs = Realtime2Programs(names).ToList();
        Assert.Equal(54, programs.Count);
        // Each search replays the stream a few hundred times: run the programs in parallel.
        var reports = new (string Text, bool Ok)[programs.Count];
        Parallel.For(0, programs.Count, p =>
        {
            var (name, moves, changes) = programs[p];
            int i = m.FindIndex(x => x.Name == name + " start");
            var dll = Between(all, m[i].Wall, m[i + 1].Wall);
            var before = Between(all, 0, m[i].Wall).LastOrDefault(r => MotionRecord.IsCommand(r) && r[32] == MotionRecord.AntiDiveType);
            double lastFeed = before is null ? 0 : BitConverter.ToDouble(before, 40) * 10000 / (50.0 * 100);   // the return ran at FRO 100
            Planner.Stream Make()
            {
                var s = new Planner.Stream(new Planner(Accel, Vel, Oracle) { LastFeed = lastFeed }, Origin);
                foreach (var mv in moves) s.Add(mv);
                return s;
            }
            var (after, d) = FindChanges(Make, dll, changes);
            string at = string.Join(", ", changes.Select((c, j) => $"{c.Name} @ {(j < after.Length ? after[j].ToString() : "none")}"));
            var text = new System.Text.StringBuilder($"{name}: {dll.Count} records; {at}; " +
                (d < 0 ? "MATCH" : $"diverges at record {d} (sample {SamplesBefore(dll, d)})"));
            if (d >= 0)
            {
                var ours = RunStream(Make, changes, after);
                string Show(List<byte[]> l, int x) => x >= l.Count ? "none" : MotionRecord.IsCommand(l[x]) ? $"cmd {l[x][32]}"
                    : string.Join(" ", Doubles(l[x]).Take(3).Select(v => v.ToString("F9")));
                for (int x = Math.Max(0, d - 2); x <= d + 1; x++) text.Append($"\n   {x}: dll {Show(dll, x)} | ours {Show(ours, x)}");
            }
            reports[p] = (text.ToString(), d < 0);
        });
        foreach (var r in reports) output.WriteLine(r.Text);
        var failures = programs.Where((_, p) => !reports[p].Ok).Select(x => x.Name).ToList();
        Assert.True(failures.Count == 0, $"{failures.Count} programs differ: " + string.Join(", ", failures));
    }
}

public partial class PlannerTests
{
    /// <summary>
    /// OracleDriver Calls(): AddLinearMoveRel(axis, step, count, percent, dir)
    /// as the bridge uses it is a line of step x count along the axis
    /// (negative when dir) at percent of the axis MaxVel.
    /// </summary>
    [Fact]
    public void AddLinearMoveRel_is_a_line_at_a_percentage_of_MaxVel()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "calls.jsonl"), marks = Path.Combine(dir, "calls-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: calls corpus missing"); return; }
        var m = Markers(marks);
        var all = AllRecords(frames);
        var cases = new (string Name, double[] From, double[] To, double Feed)[]
        {
            ("rel x +2 at 50", P(0, 0), P(2, 0), 0.50 * 150),
            ("rel x -2 at 20", P(2, 0), P(0, 0), 0.20 * 150),
            ("rel y +1 x3 at 50", P(0, 0), P(0, 3), 0.50 * 10000.0 / 60),
        };
        var failures = new List<string>();
        foreach (var (name, from, to, feed) in cases)
        {
            int i = m.FindIndex(x => x.Name == name + " start");
            var before = Between(all, 0, m[i].Wall).LastOrDefault(r => MotionRecord.IsCommand(r) && r[32] == MotionRecord.AntiDiveType);
            var planner = new Planner(Accel, Vel, Oracle) { LastFeed = before is null ? 0 : BitConverter.ToDouble(before, 40) * 2 };
            if (Check(name, Between(all, m[i].Wall, m[i + 1].Wall), planner.PlanRecords(from, [new Line(to, feed)])) is string f)
                failures.Add(f);
        }
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }
}

public partial class PlannerTests
{
    /// <summary>Path speed of each position sample (mm/s), command records skipped.</summary>
    static List<double> SampleSpeeds(List<byte[]> records)
    {
        var pos = records.Where(r => !MotionRecord.IsCommand(r)).Select(Doubles).ToList();
        return [.. Enumerable.Range(1, pos.Count - 1).Select(k =>
            Math.Sqrt(Enumerable.Range(0, 6).Sum(a => Math.Pow(pos[k][a] - pos[k - 1][a], 2))) / SamplePeriod)];
    }

    /// <summary>
    /// OracleDriver Inferred(): StopWithDeccel and StopEndOfSegment swept over
    /// L1's deceleration while L2 (5 deg) blends in; then B / C moves (MaxVel
    /// 30, MaxAccel 500) and a move in inch mode (the DLL plans in mm: X 1
    /// inch at 1 inch/s is 25.4 mm at 25.4 mm/s).
    /// </summary>
    [Fact]
    public void Stops_during_a_blend_BC_axes_and_inch_mode_match_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "inferred.jsonl"), marks = Path.Combine(dir, "inferred-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: inferred corpus missing"); return; }
        var m = Markers(marks);
        var all = AllRecords(frames);
        double d5 = 5 * Math.PI / 180;
        var b5 = P(100 + 100 * Math.Cos(d5), 100 * Math.Sin(d5));
        var b5up = (double[])b5.Clone(); b5up[1] += 50;
        double LastFeed(int i)
        {
            var before = Between(all, 0, m[i].Wall).LastOrDefault(r => MotionRecord.IsCommand(r) && r[32] == MotionRecord.AntiDiveType);
            return before is null ? 0 : BitConverter.ToDouble(before, 40) * 2;
        }
        var failures = new List<string>();
        for (int d = 1900; d <= 2020; d += 15)
            foreach (var (name, moves, change) in new (string, Move[], Change)[]
            {
                ($"blend decel stop {d}", [new Line(P(100, 0), 50), new Line(b5, 50)], new("StopWithDecel", s => s.StopWithDecel())),
                ($"blend end of segment {d}", [new Line(P(100, 0), 50), new Line(b5, 50), new Line(b5up, 50)],
                    new("StopEndOfSegment", s => s.StopEndOfSegment())),
            })
            {
                int i = m.FindIndex(x => x.Name == name + " start");
                var dll = Between(all, m[i].Wall, m[i + 1].Wall);
                double lastFeed = LastFeed(i);
                Planner.Stream Make()
                {
                    var s = new Planner.Stream(new Planner(Accel, Vel, Oracle) { LastFeed = lastFeed }, Origin);
                    foreach (var mv in moves) s.Add(mv);
                    return s;
                }
                var (after, dv) = FindChanges(Make, dll, [change]);
                output.WriteLine($"{name}: {dll.Count} records; {change.Name} @ {(after.Length > 0 ? after[0].ToString() : "none")}; " +
                                 (dv < 0 ? "MATCH" : $"diverges at record {dv}"));
                if (dv < 0) continue;
                // DELIBERATE DIFFERENCE: StopWithDeccel while L1 and L2 overlap makes
                // the DLL's path jump in one sample (a speed spike) before it
                // decelerates; Uc100Net ramps both moves down smoothly instead. So
                // here the DLL must show the jump, and ours must stop smoothly.
                var v = SampleSpeeds(dll);
                int spike = Enumerable.Range(1, v.Count - 2).FirstOrDefault(k => v[k] > 1.3 * Math.Max(v[k - 1], v[k + 1]) && v[k] > 5);
                var ours = RunStream(Make, [change], [Math.Max(0, spike - 1)]);
                var w = SampleSpeeds(ours);
                double worstStep = Enumerable.Range(1, w.Count - 1).Max(k => Math.Abs(w[k] - w[k - 1])) / SamplePeriod;
                output.WriteLine($"   DLL jumps at sample {spike} ({v[spike]:F1} mm/s between {v[spike - 1]:F1} and {v[spike + 1]:F1}); " +
                                 $"ours: {w.Count} samples, worst speed change {worstStep:F0} mm/s^2, ends at {w[^1]:F3} mm/s");
                if (change.Name != "StopWithDecel" || spike == 0 || worstStep > 1100 || w[^1] > 1) failures.Add(name);
            }

        double[] accelBC = [1000, 1000, 1000, 1000, 500, 500], velBC = [150, 10000.0 / 60, 8000.0 / 60, 1e9, 30, 30];
        foreach (var (name, target, feed) in new (string, double[], double)[]
        {
            ("b only", [0, 0, 0, 0, 90, 0], F),
            ("xbc", [10, 0, 0, 0, 45, 30], F),
            ("bc fast", [0, 0, 0, 0, 0, 0], 100),
            ("inch x1", [25.4, 0, 0, 0, 0, 0], 25.4),
            ("inch return", [0, 0, 0, 0, 0, 0], 25.4),
        })
        {
            int i = m.FindIndex(x => x.Name == name + " start");
            var dll = Between(all, m[i].Wall, m[i + 1].Wall);
            var from = Doubles(Between(all, 0, m[i].Wall).Last(r => !MotionRecord.IsCommand(r)));
            var planner = new Planner(accelBC, velBC, Oracle) { LastFeed = LastFeed(i) };
            if (Check(name, dll, planner.PlanRecords(from, [new Line(target, feed)])) is string f) failures.Add(f);
        }
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }
}

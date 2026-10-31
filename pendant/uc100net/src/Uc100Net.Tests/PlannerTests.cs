using System.Text.Json;
using Xunit.Abstractions;
using static Uc100Net.Planner;

namespace Uc100Net.Tests;

/// <summary>
/// Planner against the position samples UC100.dll 2190 produced for the same
/// programs through the oracle (tools/oracle/OracleDriver.cs: Program(),
/// Arcs() and Corners(); axes at 400 steps/unit, MaxAccel 1000,
/// MaxVel 9000/10000/8000 mm/min; ConstantVel, StopAngle 89, CornerError
/// 0.03, LinearErr 0.03 as Configure() sets them; Corners2() then changes
/// CornerError and StopAngle). Skips without the oracle logs.
/// </summary>
public partial class PlannerTests(ITestOutputHelper output)
{
    static readonly double F = 1000.0 / 60.0;
    static readonly double[] Accel = [1000, 1000, 1000, 1000, 1000, 1000];
    static readonly double[] Vel = [150, 10000.0 / 60, 8000.0 / 60, 1e9, 1e9, 1e9];
    static readonly double[] Origin = new double[6];
    static readonly TrajSettings Oracle = new(ConstantVel: true, StopAngle: 89, CornerError: 0.03, LinearErr: 0.03);

    static double[] P(double x, double y) => [x, y, 0, 0, 0, 0];

    /// <summary>Every 48-byte motion record the DLL sent between two wall-clock times, command records included.</summary>
    static List<byte[]> DllRecords(string jsonl, double fromWall = 0, double toWall = double.MaxValue)
    {
        var list = new List<byte[]>();
        foreach (string line in File.ReadLines(jsonl))
        {
            var r = JsonDocument.Parse(line).RootElement;
            if (r.GetProperty("port").GetInt32() != 4912 || r.GetProperty("cmd").GetInt32() != 2) continue;
            if (r.TryGetProperty("wall", out var w) && (w.GetDouble() <= fromWall || w.GetDouble() > toWall)) continue;
            byte[] p = Convert.FromHexString(r.GetProperty("plain").GetString()!);
            for (int i = 0; i < p[6]; i++) list.Add(p.AsSpan(7 + 48 * i, 48).ToArray());
        }
        return list;
    }

    static double[] Doubles(byte[] record) => [.. Enumerable.Range(0, 6).Select(a => BitConverter.ToDouble(record, 8 * a))];

    /// <summary>
    /// Logs the comparison; returns a failure description, or null when it
    /// matches: same record count, command records byte-identical and in the
    /// same places, positions within 1e-9 mm.
    /// </summary>
    string? Check(string name, List<byte[]> dll, List<byte[]> ours)
    {
        int n = Math.Min(dll.Count, ours.Count), first = -1, commands = 0;
        double worst = 0;
        for (int i = 0; i < n; i++)
        {
            bool cd = MotionRecord.IsCommand(dll[i]), co = MotionRecord.IsCommand(ours[i]);
            if (cd || co)
            {
                if (!MotionRecord.SameCommand(dll[i], ours[i]) && first < 0) first = i;
                if (cd) commands++;
                continue;
            }
            double[] a = Doubles(dll[i]), b = Doubles(ours[i]);
            for (int x = 0; x < 6; x++)
            {
                double e = Math.Abs(a[x] - b[x]);
                if (e > 1e-9 && first < 0) first = i;
                worst = Math.Max(worst, e);
            }
        }
        output.WriteLine($"{name}: {dll.Count} records (ours {ours.Count}), {commands} command, max error {worst:E2} mm" +
                         (first >= 0 ? $", first diverges at record {first}" : ""));
        return dll.Count == ours.Count && first < 0 ? null : $"{name}: {dll.Count} vs {ours.Count} records, first diverges at {first}";
    }

    void Compare(string name, List<byte[]> dll, List<byte[]> ours)
    {
        string? failure = Check(name, dll, ours);
        Assert.True(failure is null, failure);
    }

    [Fact]
    public void Anti_dive_record_layout_matches_the_DLL()
    {
        // program2's first record: feed 1000 mm/min at THCAntiDiveVel 50%.
        Assert.Equal("0000000000001038" + new string('0', 48) + "0200000000000000" + "abaaaaaaaaaa2040",
                     Convert.ToHexString(MotionRecord.AntiDive(50 * F * 100 / 10000)).ToLowerInvariant());
    }

    [Fact]
    public void Square_and_arc_program_matches_the_DLL()
    {
        string path = Path.Combine(Vectors.RepoRoot, "work", "oracle", "program2.jsonl");
        if (!File.Exists(path)) { output.WriteLine("SKIPPED: work/oracle/program2.jsonl missing"); return; }
        var program = new Move[]
        {
            new Line(P(10, 0), F), new Line(P(10, 10), F), new Line(P(0, 10), F), new Line(P(0, 0), F),
            new Line(P(20, 0), F), new Arc([0, 0, 0], 10, 0, true, F),
        };
        Compare("square+arc", DllRecords(path), new Planner(Accel, Vel, Oracle).PlanRecords(Origin, program));
    }

    [Fact]
    public void Arc_and_line_corpus_matches_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "arcs.jsonl"), marks = Path.Combine(dir, "arcs-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: arcs corpus missing"); return; }
        var programs = new Dictionary<string, Move[]>
        {
            ["quarter r10"] = [new Line(P(10, 0), F), new Arc([0, 10, 0], 0, 0, true, F), new Line(P(0, 0), F)],
            ["half r5"] = [new Line(P(10, 0), F), new Arc([0, 0, 0], 5, 0, true, F)],
            ["half r20"] = [new Line(P(40, 0), F), new Arc([0, 0, 0], 20, 0, true, F)],
            ["full r10"] = [new Line(P(10, 0), F), new Arc([10, 0, 0], 0, 0, true, F), new Line(P(0, 0), F)],
            ["half r10 cw"] = [new Line(P(20, 0), F), new Arc([0, 0, 0], 10, 0, false, F)],
            ["diagonal"] = [new Line(P(10, 10), F), new Line(P(0, 0), F)],
            ["fast x"] = [new Line(P(30, 0), 100), new Line(P(0, 0), 100)],
        };
        CompareCorpus(frames, marks, programs);
    }

    /// <summary>Compare every marker-delimited program in a corpus that has an entry in <paramref name="programs"/>.</summary>
    void CompareCorpus(string frames, string marks, Dictionary<string, Move[]> programs, TrajSettings? traj = null,
                       double[]? accel = null, double[]? vel = null, double fro = 100)
    {
        var m = File.ReadLines(marks).Select(l => JsonDocument.Parse(l).RootElement)
            .Select(e => (Name: e.GetProperty("experiment").GetString()!, Wall: e.GetProperty("wall").GetDouble())).ToList();
        var planner = new Planner(accel ?? Accel, vel ?? Vel, traj ?? Oracle) { FroPercent = fro };
        int compared = 0;
        var failures = new List<string>();
        for (int i = 0; i + 1 < m.Count; i += 2)
        {
            string name = m[i].Name[..^" start".Length];
            if (!programs.TryGetValue(name, out var program)) continue;
            // The DLL's last-feed state carries over from the program before
            // (often an uncompared "return"): its last anti-dive record, unscaled.
            var before = DllRecords(frames, 0, m[i].Wall).LastOrDefault(r => MotionRecord.IsCommand(r) && r[32] == MotionRecord.AntiDiveType);
            planner.LastFeed = before is null ? 0 : BitConverter.ToDouble(before, 40) * 10000 / (planner.AntiDivePercent * fro);
            if (Check(name, DllRecords(frames, m[i].Wall, m[i + 1].Wall), planner.PlanRecords(Origin, program)) is string f)
                failures.Add(f);
            compared++;
        }
        Assert.Equal(programs.Count, compared);
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }

    static double[] Turn(double ox, double oy, double deg, double len) =>
        P(ox + len * Math.Cos(deg * Math.PI / 180), oy + len * Math.Sin(deg * Math.PI / 180));

    [Fact]
    public void Blended_corner_corpus_matches_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "corners.jsonl"), marks = Path.Combine(dir, "corners-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: corners corpus missing"); return; }
        double fast = 100;
        var programs = new Dictionary<string, Move[]>();
        foreach (double deg in new double[] { 10, 20, 30, 45, 60, 80, 88, 120 })
            programs[$"corner {deg}"] = [new Line(P(10, 0), F), new Line(Turn(10, 0, deg, 10), F)];
        programs["corner 30 fast"] = [new Line(P(10, 0), fast), new Line(Turn(10, 0, 30, 10), fast)];
        programs["corner 45 short fast"] = [new Line(P(1, 0), fast), new Line(Turn(1, 0, 45, 1), fast)];
        var zig = new List<Move>();
        double[] at = Origin;
        for (int i = 0; i < 4; i++) { at = Turn(at[0], at[1], i % 2 == 0 ? 30 : -30, 3); zig.Add(new Line(at, F)); }
        programs["zigzag 60"] = [.. zig];
        programs["bend 1"] = [new Line(P(5, 0), F), new Line(Turn(5, 0, 1, 5), F)];
        programs["line arc tangent"] = [new Line(P(10, 0), F), new Arc([15, 5, 0], 10, 5, true, F)];
        programs["collinear"] = [new Line(P(5, 0), F), new Line(P(10, 0), F)];   // merged into one line
        // Not compared: the "... return" programs (single lines, covered above).
        CompareCorpus(frames, marks, programs);
    }

    [Fact]
    public void Corners_at_CornerError_0_1_and_StopAngle_45_match_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "corners2.jsonl"), marks = Path.Combine(dir, "corners2-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: corners2 corpus missing"); return; }
        var programs = new Dictionary<string, Move[]>();
        foreach (double deg in new double[] { 20, 40, 44, 46, 60 })
            foreach (var (feed, suffix) in new[] { (F, ""), (100.0, " fast") })
                programs[$"ce0.1 corner {deg}{suffix}"] = [new Line(P(10, 0), feed), new Line(Turn(10, 0, deg, 10), feed)];
        CompareCorpus(frames, marks, programs, Oracle with { CornerError = 0.1, StopAngle = 45 });
    }

    [Fact]
    public void Vector_unification_corpus_matches_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "unify.jsonl"), marks = Path.Combine(dir, "unify-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: unify corpus missing"); return; }
        double fast = 100, bend = 0.01;
        Move[] Lines(double feed, params double[][] pts) => [.. pts.Select(q => (Move)new Line(q, feed))];
        double step = 2 * Math.Asin(0.5 / 50);
        var programs = new Dictionary<string, Move[]>
        {
            ["polyline r50"] = Lines(F, [.. Enumerable.Range(1, 20).Select(i => P(50 * Math.Sin(i * step), 50 - 50 * Math.Cos(i * step)))]),
            ["noise 0.01"] = Lines(F, [.. Enumerable.Range(1, 10).Select(i => P(i, i % 2 == 1 ? 0.01 : -0.01))]),
            ["collinear 3x60"] = Lines(fast, P(60, 0), P(120, 0), P(180, 0)),
            ["bend 90+90"] = Lines(fast, P(90, 0), Turn(90, 0, bend, 90)),
            ["bend 120+120"] = Lines(fast, P(120, 0), Turn(120, 0, bend, 120)),
            ["feed 0.5%"] = [new Line(P(5, 0), F), new Line(P(10, 0), F * 1.005)],
            ["feed 2%"] = [new Line(P(5, 0), F), new Line(P(10, 0), F * 1.02)],
        };
        var planner = new Planner(Accel, Vel, Oracle);
        output.WriteLine($"polyline r50 merges 20 lines into {planner.Unify(Origin, programs["polyline r50"]).Count}");
        CompareCorpus(frames, marks, programs);
    }

    [Fact]
    public void Mixed_joins_and_contour_match_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "mixed.jsonl"), marks = Path.Combine(dir, "mixed-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: mixed corpus missing"); return; }
        double mid = 2000.0 / 60;
        var contour = new List<Move>();
        for (int lap = 0; lap < 2; lap++)
        {
            contour.AddRange([new Line(P(37, 0), mid), new Arc([40, 3, 0], 37, 3, true, mid),
                new Line(P(40, 17), mid), new Arc([37, 20, 0], 37, 17, true, mid),
                new Line(P(3, 20), mid), new Arc([0, 17, 0], 3, 17, true, mid),
                new Line(P(0, 3), mid), new Arc([3, 0, 0], 3, 3, true, mid)]);
        }
        contour.Add(new Line(P(20, 10), mid));
        for (int i = 1; i <= 60; i++)
        {
            double ang = i * 6 * Math.PI / 180, r = 0.05 * i + 1;
            contour.Add(new Line(P(20 + r * Math.Cos(ang) - 1, 10 + r * Math.Sin(ang)), mid));
        }
        var programs = new Dictionary<string, Move[]>
        {
            ["slot"] = [new Line(P(10, 0), F), new Arc([20, 10, 0], 10, 10, true, F), new Line(P(20, 20), F)],
            ["s-curve"] = [new Line(P(10, 0), F), new Arc([15, 5, 0], 10, 5, true, F), new Arc([20, 10, 0], 20, 5, false, F)],
            ["arc line 30"] = [new Line(P(10, 0), F), new Arc([20, 10, 0], 10, 10, true, F),
                new Line(P(20 - 10 * Math.Sin(Math.PI / 6), 10 + 10 * Math.Cos(Math.PI / 6)), F)],
            ["arc tiny line"] = [new Line(P(10, 0), F), new Arc([20, 10, 0], 10, 10, true, F), new Line(P(20, 10.02), F), new Line(P(20, 20), F)],
            ["slow 50"] = [new Line(P(1, 0), 50.0 / 60)],
            ["contour"] = [.. contour],
        };
        CompareCorpus(frames, marks, programs);
    }

    [Fact]
    public void Z_moves_and_feeds_over_MaxVel_match_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "axes.jsonl"), marks = Path.Combine(dir, "axes-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: axes corpus missing"); return; }
        static double[] P3(double x, double y, double z) => [x, y, z, 0, 0, 0];
        var programs = new Dictionary<string, Move[]>
        {
            ["z 10"] = [new Line(P3(0, 0, 10), F)],
            ["xz diagonal"] = [new Line(P3(10, 0, 10), F)],
            ["x over maxvel"] = [new Line(P(100, 0), 200)],
            ["xy over maxvel"] = [new Line(P(100, 100), 20000.0 / 60)],
            ["z over maxvel"] = [new Line(P3(0, 0, 50), 200)],
            ["arc over maxvel"] = [new Line(P(40, 0), 100), new Arc([0, 0, 0], 20, 0, true, 200)],
        };
        CompareCorpus(frames, marks, programs);
    }

    /// <summary>
    /// OracleDriver Realtime(): L2 added 200 / 590 / 800 ms after L1 (docs/STREAMING.md).
    /// When the DLL's generator saw L2 is not logged, so for each program
    /// this tries every arrival sample: L1 is added, that many samples are
    /// generated, then L2. At least one must reproduce the DLL exactly. The
    /// ranges show the rules: queued in time, L2 blends as if queued up front;
    /// a collinear L2 never merges once L1 has started (arrival 0 would
    /// merge and does not match); too late, an exact stop.
    /// </summary>
    [Fact]
    public void Moves_added_while_running_match_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "realtime.jsonl"), marks = Path.Combine(dir, "realtime-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: realtime corpus missing"); return; }
        var m = File.ReadLines(marks).Select(l => JsonDocument.Parse(l).RootElement)
            .Select(e => (Name: e.GetProperty("experiment").GetString()!, Wall: e.GetProperty("wall").GetDouble())).ToList();
        var c30 = Turn(10, 0, 30, 10);
        var cases = new (string Name, Move L2, int MinArrival, int MaxArrival)[]
        {
            ("late corner 200", new Line(c30, F), 1, 400),
            ("late corner 590", new Line(c30, F), 483, 483),
            ("late corner 800", new Line(c30, F), 483, 483),
            ("late collinear 200", new Line(P(20, 0), F), 1, 400),
            ("late collinear 590", new Line(P(20, 0), F), 483, 483),
        };
        foreach (var (name, l2, lo, hi) in cases)
        {
            int i = m.FindIndex(x => x.Name == name + " start");
            var dll = DllRecords(frames, m[i].Wall, m[i + 1].Wall);
            var match = new List<int>();
            for (int arrival = 0; arrival <= 600; arrival++)
            {
                var planner = new Planner(Accel, Vel, Oracle) { LastFeed = 100 };
                var stream = new Planner.Stream(planner, Origin);
                stream.Add(new Line(P(10, 0), F));
                var ours = new List<byte[]>();
                for (int s = 0; s < arrival && stream.Next() is byte[] r; ) { ours.Add(r); if (!MotionRecord.IsCommand(r)) s++; }
                stream.Add(l2);
                while (stream.Next() is byte[] r) ours.Add(r);
                if (ours.Count == dll.Count && ours.Zip(dll).All(p => MotionRecord.IsCommand(p.First)
                        ? MotionRecord.SameCommand(p.First, p.Second)
                        : Enumerable.Range(0, 6).All(a => Math.Abs(BitConverter.ToDouble(p.First, 8 * a) - BitConverter.ToDouble(p.Second, 8 * a)) < 1e-9)))
                    match.Add(arrival);
            }
            output.WriteLine($"{name}: {dll.Count} records; reproduced with L2 arriving at sample " +
                             (match.Count == 0 ? "none" : $"{match.Min()}..{match.Max()} ({match.Count} values)"));
            Assert.NotEmpty(match);
            Assert.Contains(match, a => a >= lo && a <= hi);
        }
    }

    /// <summary>
    /// OracleDriver Realtime() "fro drop" and "feed hold": a 100 mm line at
    /// 50 mm/s; FRO 50 then 100, or hold then release, while it runs. The
    /// samples where the DLL applied each change (451, 1084 / 451, 1231) are
    /// read off the corpus; from there Planner.Stream must reproduce every
    /// record, including the anti-dive records each change re-sends.
    /// </summary>
    [Fact]
    public void Fro_change_and_feed_hold_while_running_match_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "realtime.jsonl"), marks = Path.Combine(dir, "realtime-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: realtime corpus missing"); return; }
        var m = File.ReadLines(marks).Select(l => JsonDocument.Parse(l).RootElement)
            .Select(e => (Name: e.GetProperty("experiment").GetString()!, Wall: e.GetProperty("wall").GetDouble())).ToList();
        var cases = new (string Name, (int After, Action<Planner.Stream> Change)[] Changes)[]
        {
            ("fro drop", [(452, s => s.SetFro(50)), (1085, s => s.SetFro(100))]),
            ("feed hold", [(452, s => s.FeedHold(true)), (1232, s => s.FeedHold(false))]),
        };
        var failures = new List<string>();
        foreach (var (name, changes) in cases)
        {
            int i = m.FindIndex(x => x.Name == name + " start");
            var dll = DllRecords(frames, m[i].Wall, m[i + 1].Wall);
            var stream = new Planner.Stream(new Planner(Accel, Vel, Oracle) { LastFeed = 100 }, Origin);
            stream.Add(new Line(P(100, 0), 50));
            var ours = new List<byte[]>();
            int samples = 0;
            foreach (var (after, change) in changes)
            {
                while (samples < after && stream.Next() is byte[] r) { ours.Add(r); if (!MotionRecord.IsCommand(r)) samples++; }
                change(stream);
            }
            while (stream.Next() is byte[] r) ours.Add(r);
            if (Check(name, dll, ours) is string f) failures.Add(f);
        }
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }

    /// <summary>OracleDriver Fro(): the same five programs at FRO 50 and at FRO 150.</summary>
    [Fact]
    public void Feed_override_50_and_150_matches_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "fro.jsonl"), marks = Path.Combine(dir, "fro-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: fro corpus missing"); return; }
        foreach (double fro in new double[] { 50, 150 })
            CompareCorpus(frames, marks, new Dictionary<string, Move[]>
            {
                [$"fro{fro} line"] = [new Line(P(10, 0), F)],
                [$"fro{fro} corner 30"] = [new Line(P(10, 0), F), new Line(Turn(10, 0, 30, 10), F)],
                [$"fro{fro} arc"] = [new Line(P(10, 0), F), new Arc([0, 0, 0], 5, 0, true, F)],
                [$"fro{fro} x over maxvel"] = [new Line(P(100, 0), 200)],
                [$"fro{fro} x fast"] = [new Line(P(100, 0), 120)],
            }, fro: fro);
    }

    /// <summary>
    /// OracleDriver Planes(): XZ / YZ arcs, helices, a tiny Z line absorbed
    /// into an arc, dwell, dummy and duplicate points; then an arc and a
    /// line with Y MaxAccel 500, an arc with Y MaxVel 20, and the A axis
    /// (MaxVel 30, MaxAccel 500).
    /// </summary>
    [Fact]
    public void Arc_planes_helices_dwell_and_A_axis_match_the_DLL()
    {
        string dir = Path.Combine(Vectors.RepoRoot, "work", "oracle");
        string frames = Path.Combine(dir, "planes.jsonl"), marks = Path.Combine(dir, "planes-markers.jsonl");
        if (!File.Exists(frames) || !File.Exists(marks)) { output.WriteLine("SKIPPED: planes corpus missing"); return; }
        static double[] P3(double x, double y, double z) => [x, y, z, 0, 0, 0];
        double[] o = [0, 0, 0];
        Move XZ(double x, double z, bool ccw) => new Arc([x, 0, z], 0, 0, ccw, F, ArcPlane.XZ);
        Move YZ(double y, double z, bool ccw) => new Arc([0, y, z], 0, 0, ccw, F, ArcPlane.YZ);
        var c30 = P(10 + 10 * Math.Cos(Math.PI / 6), 10 * Math.Sin(Math.PI / 6));
        CompareCorpus(frames, marks, new Dictionary<string, Move[]>
        {
            ["xz quarter"] = [new Line(P(10, 0), F), XZ(0, 10, true), new Line(Origin, F)],
            ["xz quarter cw"] = [new Line(P(10, 0), F), XZ(0, 10, false), new Line(Origin, F)],
            ["yz quarter"] = [new Line(P(0, 10), F), YZ(0, 10, true), new Line(Origin, F)],
            ["yz quarter cw"] = [new Line(P(0, 10), F), YZ(0, 10, false), new Line(Origin, F)],
            ["xy helix"] = [new Line(P(10, 0), F), new Arc([-10, 0, 5], 0, 0, true, F)],
            ["xy helix full"] = [new Line(P(5, 0), F), new Arc([5, 0, 10], 0, 0, true, F)],
            ["xz helix"] = [new Line(P(10, 0), F), new Arc([0, 5, 10], 0, 0, true, F, ArcPlane.XZ)],
            ["arc tiny z"] = [new Line(P(10, 0), F), new Arc([0, 10, 0], 0, 0, true, F), new Line(P3(0, 10, 0.02), F)],
            ["dwell"] = [new Line(P(10, 0), F), new Dwell(0.25), new Line(P(20, 0), F)],
            ["dummy"] = [new Line(P(10, 0), F), new Dummy(), new Line(P(20, 0), F)],
            ["dup point"] = [new Line(P(10, 0), F), new Line(P(10, 0), F), new Line(P(20, 0), F)],
            ["dup point corner"] = [new Line(P(10, 0), F), new Line(P(10, 0), F), new Line(c30, F)],
            ["dup point 10"] = [new Line(P(10, 0), F), new Line(P(10, 0), F), new Line(Turn(10, 0, 10, 10), F)],
            ["dup point twice"] = [new Line(P(10, 0), F), new Line(P(10, 0), F), new Line(P(10, 0), F), new Line(P(20, 0), F)],
            ["dup point feed"] = [new Line(P(10, 0), F), new Line(P(10, 0), F), new Line(P(20, 0), 2 * F)],
            ["collinear feed"] = [new Line(P(10, 0), F), new Line(P(20, 0), 2 * F)],
            ["xz tangent"] = [new Line(P(10, 0), F), new Arc([20, 0, 10], 10, 10, true, F, ArcPlane.XZ), new Line(P3(20, 0, 20), F)],
            ["helix tangent"] = [new Line(P(10, 0), F), new Arc([20, 10, 2], 10, 10, true, F), new Line(P3(20, 20, 2), F)],
        });
        double[] accelY500 = [1000, 500, 1000, 1000, 1000, 1000];
        CompareCorpus(frames, marks, new Dictionary<string, Move[]>
        {
            ["arc y accel 500"] = [new Line(P(10, 0), F), new Arc(o, 5, 0, true, F)],
            ["line xy y accel 500"] = [new Line(P(10, 10), F)],
        }, accel: accelY500);
        CompareCorpus(frames, marks, new Dictionary<string, Move[]>
        {
            ["arc y vel 20"] = [new Line(P(10, 0), F), new Arc(o, 5, 0, true, 100)],
        }, vel: [150, 20, 8000.0 / 60, 1e9, 1e9, 1e9]);
        double[] accelA = [1000, 1000, 1000, 500, 1000, 1000], velA = [150, 10000.0 / 60, 8000.0 / 60, 30, 1e9, 1e9];
        CompareCorpus(frames, marks, new Dictionary<string, Move[]>
        {
            ["a only"] = [new Line([0, 0, 0, 90, 0, 0], F)],
            ["xa"] = [new Line([10, 0, 0, 45, 0, 0], F)],
            ["xa fast"] = [new Line([10, 0, 0, 45, 0, 0], 100)],
        }, accel: accelA, vel: velA);
    }
}

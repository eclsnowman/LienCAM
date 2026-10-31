using System.Diagnostics;
using System.Text.Json;
using Uc100Net.Compat;

namespace Uc100Net.Tests;

/// <summary>
/// Facade slice 3, probing, against OracleDriver ProbeScenario() run with the
/// fake's probe surface at Z -1 (work/oracle/probe.jsonl; docs/CALLS.md 4).
/// The fake's probe model is FROM CODE ONLY (no real capture has a hit); this
/// shows that Uc100Net does what DLL 2190 does against the same model. Per
/// probe: the same command frames, a probe move that matches the DLL's
/// record for record as far as both streamed (where the Stop lands depends
/// on timing), the same results, and the move after it identical (after a
/// hit it must start at the contact point, not at the last record sent).
/// </summary>
public partial class FacadeDifferentialTests
{
    [Fact]
    public void Facade_probes_like_the_DLL()
    {
        string root = Vectors.RepoRoot, dir = Path.Combine(root, "work", "oracle");
        string corpus = Path.Combine(dir, "probe.jsonl"), marks = Path.Combine(dir, "probe-markers.jsonl");
        if (!OracleDifferentialTests.OracleNetworkPresent() || !File.Exists(corpus) || !File.Exists(marks))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network and the probe corpus");
            return;
        }
        string log = Path.Combine(dir, "uc100net-probe.jsonl");
        var phases = new List<(string Name, double From, double To)>();
        var results = new List<string>();
        using (var fake = OracleDifferentialTests.StartFake(root, log, 40, "--probe-at", "2,-1.0"))
        {
            Thread.Sleep(1200);
            UC100.ResetProcessState();
            UC100.Interfaces = [OracleDifferentialTests.Local];
            int count = 0, type = 0, serial = 0;
            Assert.Equal(0, UC100.ListDevices(ref count));
            Assert.True(count == 1 && UC100.DeviceInfo(1, ref type, ref serial) == 0 && type == 19 && serial == 0x0BEEF0);
            Assert.Equal(0, UC100.Open(1));
            Configure();
            Assert.Equal(0, UC100.SetProbeSetting(5, false, 0, false));
            Thread.Sleep(300);
            int id = 2100;

            void Phase(string name, Action f)
            {
                double from = Wall();
                Thread.Sleep(50);
                f();
                var sw = Stopwatch.StartNew();
                var st = new UC100.Stat();
                do { Thread.Sleep(50); UC100.GetStatus(ref st); } while (!(st.Idle && !st.Probe && sw.ElapsedMilliseconds > 250) && sw.ElapsedMilliseconds < 10000);
                Thread.Sleep(200);
                phases.Add((name, from, Wall()));
                Thread.Sleep(150);   // the fake stamps frames with its own clock: keep the next step clear of this window
            }
            void Probe(string name, int axis, double to, double speed)
            {
                string finished = "never";
                Phase(name, () =>
                {
                    Assert.Equal(0, UC100.ProbeStart(axis, to, speed, id++));
                    bool fin = false;
                    for (int i = 0; i < 80 && !fin; i++)
                    {
                        UC100.GetProbeState(ref fin);
                        if (fin) finished = "finished"; else Thread.Sleep(50);
                    }
                });
                double px = 0, py = 0, pz = 0, pa = 0, pb = 0, pc = 0, x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
                UC100.GetProbePosition(ref px, ref py, ref pz, ref pa, ref pb, ref pc);
                UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c);
                results.Add($"{name}: {finished}, probe at {px:R} {py:R} {pz:R}, now {x:R} {y:R} {z:R}");
                Phase(name + " return", () => Assert.Equal(0, UC100.AddLinearMoveP(0, 0, 0, null, null, null, 100, id++)));
            }
            Probe("probe z hit", 2, -5, 2.0);
            Probe("probe z miss", 2, 0.5, 2.0);
            Probe("probe x miss", 0, 3, 5.0);
            Assert.Equal(0, UC100.Close());
            fake.WaitForExit(60000);
        }

        foreach (var r in results) output.WriteLine(r);
        // What the DLL's calls returned (work/oracle/probe-events.jsonl).
        Assert.Equal(
        [
            "probe z hit: finished, probe at 0 0 -1, now 0 0 -1",
            "probe z miss: never, probe at 0 0 -1, now 0 0 0.5",
            "probe x miss: never, probe at 0 0 -1, now 3 0 0",
        ], results);

        var dll = Frames(corpus);
        var ours = Frames(log);
        var m = File.ReadLines(marks).Select(l => JsonDocument.Parse(l).RootElement)
            .ToDictionary(e => e.GetProperty("experiment").GetString()!, e => e.GetProperty("wall").GetDouble());
        var failures = new List<string>();
        foreach (var (name, from, to) in phases)
        {
            var d = dll.Where(f => f.Wall > m[name + " start"] && f.Wall <= m[name + " end"]).ToList();
            var o = ours.Where(f => f.Wall > from && f.Wall <= to).ToList();
            var cd = Commands(d); var co = Commands(o);
            var rd = Records(d); var ro = Records(o);
            int n = Math.Min(rd.Count, ro.Count), first = -1;
            for (int i = 0; i < n && first < 0; i++)
            {
                bool same = MotionRecord.IsCommand(rd[i]) ? MotionRecord.SameCommand(rd[i], ro[i])
                    : Enumerable.Range(0, 6).All(a => Math.Abs(BitConverter.ToDouble(rd[i], 8 * a) - BitConverter.ToDouble(ro[i], 8 * a)) < 1e-9);
                if (!same) first = i;
            }
            bool isReturn = name.EndsWith(" return");
            output.WriteLine($"{name}: DLL [{string.Join(", ", cd)}] ours [{string.Join(", ", co)}]; records DLL {rd.Count}, ours {ro.Count}" +
                             (first >= 0 ? $", first difference at {first}" : ", same as far as both go"));
            if (!cd.SequenceEqual(co)) failures.Add($"{name}: frames");
            if (first >= 0 || (isReturn && rd.Count != ro.Count)) failures.Add($"{name}: records");
        }
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }
}

using System.Diagnostics;
using System.Text.Json;
using Uc100Net.Compat;

namespace Uc100Net.Tests;

/// <summary>
/// The board's own soft-limit trip (reply byte 32 bit 5, docs/CALLS.md 5.1)
/// against OracleDriver SoftTripScenario() (work/oracle/softtrip.jsonl): the
/// fake reports the trip while a flag file exists. The same steps through the
/// facade must send the same command frames per phase (SpindleOff and Stop on
/// the edge unless jogging), report the same Stat.SoftLimit / Idle, and stream
/// the same records where the start point does not depend on timing (a move
/// added while the trip is held, and the return after it).
/// </summary>
public partial class FacadeDifferentialTests
{
    [Fact]
    public void Facade_reacts_to_the_board_soft_limit_trip_like_the_DLL()
    {
        string root = Vectors.RepoRoot, dir = Path.Combine(root, "work", "oracle");
        string corpus = Path.Combine(dir, "softtrip.jsonl"), marks = Path.Combine(dir, "softtrip-markers.jsonl");
        string events = Path.Combine(dir, "softtrip-events.jsonl");
        if (!OracleDifferentialTests.OracleNetworkPresent() || !File.Exists(corpus) || !File.Exists(marks))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network and the softtrip corpus");
            return;
        }
        string log = Path.Combine(dir, "uc100net-softtrip.jsonl");
        string flag = Path.Combine(dir, "uc100net-softtrip.flag");
        File.Delete(flag);
        var phases = new List<(string Name, double From, double To)>();
        var states = new List<string>();
        using (var fake = OracleDifferentialTests.StartFake(root, log, 45, "--softtrip-file", flag))
        {
            Thread.Sleep(1200);
            UC100.ResetProcessState();
            UC100.Interfaces = [OracleDifferentialTests.Local];
            int count = 0, type = 0, serial = 0;
            Assert.Equal(0, UC100.ListDevices(ref count));
            Assert.True(count == 1 && UC100.DeviceInfo(1, ref type, ref serial) == 0 && type == 19 && serial == 0x0BEEF0);
            Assert.Equal(0, UC100.Open(1));
            Configure();
            int id = 2600;
            void Trip() => File.Create(flag).Dispose();
            void Untrip() => File.Delete(flag);
            void Phase(string name, Action f)
            {
                double from = Wall();
                Thread.Sleep(50);
                f();
                var sw = Stopwatch.StartNew();
                var st = new UC100.Stat();
                do { Thread.Sleep(50); UC100.GetStatus(ref st); } while (!(st.Idle && sw.ElapsedMilliseconds > 250) && sw.ElapsedMilliseconds < 10000);
                Thread.Sleep(200);
                phases.Add((name, from, Wall()));
                Thread.Sleep(150);
            }
            void State(string tag)
            {
                var st = new UC100.Stat();
                UC100.GetStatus(ref st);
                states.Add($"{tag}: SoftLimit={st.SoftLimit} Idle={st.Idle} Puffer={st.Puffer}");
            }
            var sp = new UC100.SPSetting();
            Assert.Equal(0, UC100.GetSpindleSetting(ref sp));
            sp.Mode = 1; sp.SPPin = 3; sp.PWMFreq = 1000; sp.SPMinVel = 0; sp.SPMaxVel = 24000; sp.SPMinPWMPercent = 0; sp.SPMaxPWMPercent = 100;
            sp.SPM3Pin = 4; sp.EnableM3M4Output = true;
            Assert.Equal(0, UC100.SetSpindleSetting(ref sp));
            Assert.Equal(0, UC100.SetSpindleSpeed(12000));
            Thread.Sleep(300);

            Assert.Equal(0, UC100.SpindleOn(false));
            Thread.Sleep(200);
            Phase("program", () =>
            {
                Assert.Equal(0, UC100.AddLinearMoveP(50, 0, 0, null, null, null, 20, id++));
                Thread.Sleep(800); Trip(); Thread.Sleep(500); Untrip();
            });
            State("after program");
            Phase("after trip", () => Assert.Equal(0, UC100.AddLinearMoveP(0, 0, 0, null, null, null, 100, id++)));
            State("after after trip");
            Assert.Equal(0, UC100.ClearSoftlimitState());
            State("after ClearSoftlimitState");

            Assert.Equal(0, UC100.SpindleOn(false));
            Thread.Sleep(200);
            Phase("jog", () =>
            {
                Assert.Equal(0, UC100.JogOnSpeed(0, false, 10));
                Thread.Sleep(400); Trip(); Thread.Sleep(400); Untrip(); Thread.Sleep(200);
                Assert.Equal(0, UC100.JogOnSpeed(0, false, 0));
            });
            State("after jog");
            Assert.Equal(0, UC100.ClearSoftlimitState());

            Assert.Equal(0, UC100.SpindleOn(false));
            Thread.Sleep(200);
            Phase("idle", () => { Trip(); Thread.Sleep(400); Untrip(); });
            State("after idle");
            Assert.Equal(0, UC100.ClearSoftlimitState());

            Phase("held", () =>
            {
                Trip(); Thread.Sleep(300);
                Assert.Equal(0, UC100.AddLinearMoveP(10, 0, 0, null, null, null, 100, id++));
                Thread.Sleep(400); Untrip(); Thread.Sleep(300);
                Assert.Equal(0, UC100.AddLinearMoveP(0, 0, 0, null, null, null, 100, id++));
            });
            State("after held");
            Assert.Equal(0, UC100.ClearSoftlimitState());
            Phase("return", () => Assert.Equal(0, UC100.AddLinearMoveP(0, 0, 0, null, null, null, 100, id++)));
            State("after return");
            Assert.Equal(0, UC100.Close());
            fake.WaitForExit(50000);
        }
        File.Delete(flag);

        foreach (var s in states) output.WriteLine(s);
        // What the DLL reported at the same points.
        var dllStates = File.ReadLines(events).Select(l => JsonDocument.Parse(l).RootElement.GetProperty("event").GetString()!)
            .Where(e => e.StartsWith("after ")).Select(e => e[..e.IndexOf(" X=", StringComparison.Ordinal)]).ToList();
        Assert.Equal(dllStates, states);

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
            // Where the trip lands depends on timing, and "held" starts where the jog ended.
            bool timed = name is "program" or "after trip" or "jog" or "held";
            if (name == "held")
            {
                // The move to 10 streamed while tripped is dropped by the board, so
                // the move to 0 after starts from where the board is, not from 10.
                foreach (var (who, recs) in new[] { ("DLL", rd), ("ours", ro) })
                {
                    var xs = recs.Where(r => !MotionRecord.IsCommand(r)).Select(r => BitConverter.ToDouble(r, 0)).ToList();
                    int peak = xs.LastIndexOf(10.0);
                    bool resync = peak > 0 && peak + 1 < xs.Count && Math.Abs(xs[peak + 1] - xs[0]) < 0.01;
                    output.WriteLine($"held ({who}): starts at {xs[0]:F4}, peak 10 at {peak}, next {(peak + 1 < xs.Count ? xs[peak + 1] : double.NaN):F4}");
                    if (!resync) failures.Add($"held: {who} does not restart from the board");
                }
            }
            bool same = rd.Count == ro.Count && rd.Zip(ro).All(z => MotionRecord.IsCommand(z.First)
                ? MotionRecord.SameCommand(z.First, z.Second)
                : Enumerable.Range(0, 6).All(a => Math.Abs(BitConverter.ToDouble(z.First, 8 * a) - BitConverter.ToDouble(z.Second, 8 * a)) < 1e-9));
            output.WriteLine($"{name}: DLL [{string.Join(", ", cd.Select(c => c[..2]))}] ours [{string.Join(", ", co.Select(c => c[..2]))}]; " +
                             $"records DLL {rd.Count}, ours {ro.Count}{(timed ? " (timing-dependent)" : same ? ", identical" : ", DIFFERENT")}");
            if (!cd.SequenceEqual(co)) failures.Add($"{name}: frames");
            if (!timed && !same) failures.Add($"{name}: records");
        }
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }
}

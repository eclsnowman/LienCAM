using System.Diagnostics;
using System.Text.Json;
using Uc100Net.Compat;

namespace Uc100Net.Tests;

/// <summary>
/// The DLL's host-side soft limits (docs/CALLS.md 5.1) against OracleDriver
/// SoftLimitScenario() (work/oracle/softlimit.jsonl): X limited to -20..20,
/// Y and Z to -100..100, soft limits on. Through the facade the same moves
/// must stream the same records (the move past the limit ends on the limit;
/// from outside the window the first sample is the limit), the latched state
/// must drop the same Adds, and Stat.SoftLimit and X must read the same after
/// each step (X after the timed jog excepted).
/// </summary>
public partial class FacadeDifferentialTests
{
    [Fact]
    public void Facade_soft_limits_clamp_and_latch_like_the_DLL()
    {
        string root = Vectors.RepoRoot, dir = Path.Combine(root, "work", "oracle");
        string corpus = Path.Combine(dir, "softlimit.jsonl"), marks = Path.Combine(dir, "softlimit-markers.jsonl");
        if (!OracleDifferentialTests.OracleNetworkPresent() || !File.Exists(corpus) || !File.Exists(marks))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network and the softlimit corpus");
            return;
        }
        string log = Path.Combine(dir, "uc100net-softlimit.jsonl");
        var phases = new List<(string Name, double From, double To)>();
        var states = new List<string>();
        using (var fake = OracleDifferentialTests.StartFake(root, log, 40))
        {
            Thread.Sleep(1200);
            UC100.ResetProcessState();
            UC100.Interfaces = [OracleDifferentialTests.Local];
            int count = 0, type = 0, serial = 0;
            Assert.Equal(0, UC100.ListDevices(ref count));
            Assert.True(count == 1 && UC100.DeviceInfo(1, ref type, ref serial) == 0 && type == 19 && serial == 0x0BEEF0);
            Assert.Equal(0, UC100.Open(1));
            Configure();
            int id = 2300;
            void Limits(int axis, double p, double n)
            {
                var a = new UC100.AxisSetting { Axis = axis };
                UC100.GetAxisSetting(ref a);
                a.Axis = axis; a.SoftLimitP = p; a.SoftLimitN = n;
                Assert.Equal(0, UC100.SetAxisSetting(ref a));
            }
            Limits(0, 20, -20); Limits(1, 100, -100); Limits(2, 100, -100);
            Assert.Equal(0, UC100.SetSoftLimit(true));
            Thread.Sleep(300);
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
                Thread.Sleep(150);   // the fake stamps frames with its own clock: keep the next step clear of this window
            }
            void State(string tag, bool withX = true)
            {
                var st = new UC100.Stat();
                UC100.GetStatus(ref st);
                double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
                UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c);
                states.Add($"{tag}: SoftLimit={st.SoftLimit}" + (withX ? $" X={x:R}" : ""));
            }
            int L(double x) => UC100.AddLinearMoveP(x, 0, 0, null, null, null, 50, id++);
            void EstopAndStop()
            {
                Thread.Sleep(150);   // keep its Stop frame out of the phase before (two clocks, ms apart)
                Assert.Equal(0, UC100.SetEstopState());
                Thread.Sleep(200);
                int rc = -1;
                for (int i = 0; i < 10 && rc != 0; i++) { rc = UC100.Stop(); Thread.Sleep(50); }
                Assert.Equal(0, rc);
            }

            Phase("inside", () => { Assert.Equal(0, L(15)); Assert.Equal(0, L(0)); });
            State("after inside");
            Phase("over +", () => Assert.Equal(0, L(30)));
            State("after over +");
            Phase("blocked", () => Assert.Equal(0, L(0)));
            State("after blocked");
            Assert.Equal(0, UC100.ClearSoftlimitState());
            State("after ClearSoftlimitState");
            Phase("still blocked", () => Assert.Equal(0, L(0)));
            State("after still blocked");
            Phase("jog at limit", () =>
            {
                Assert.Equal(0, UC100.JogOnSpeed(0, false, 10));
                Thread.Sleep(300);
                Assert.Equal(0, UC100.JogOnSpeed(0, false, 0));
            });
            State("after jog at limit", withX: false);
            EstopAndStop();
            State("after estop + stop", withX: false);
            Phase("return", () => Assert.Equal(0, L(0)));
            State("after return");
            Phase("over -", () => Assert.Equal(0, L(-25)));
            State("after over -");
            EstopAndStop();
            Phase("return 2", () => Assert.Equal(0, UC100.AddLinearMoveP(0, 0, 0, null, null, null, 100, id++)));
            State("after return 2");
            Assert.Equal(0, UC100.SetSoftLimit(false));
            Assert.Equal(0, UC100.Close());
            fake.WaitForExit(45000);
        }

        foreach (var s in states) output.WriteLine(s);
        // What the DLL reported at the same points (work/oracle/softlimit-events.jsonl).
        Assert.Equal(
        [
            "after inside: SoftLimit=False X=0",
            "after over +: SoftLimit=True X=20",
            "after blocked: SoftLimit=True X=20",
            "after ClearSoftlimitState: SoftLimit=False X=20",
            "after still blocked: SoftLimit=False X=20",
            "after jog at limit: SoftLimit=False",
            "after estop + stop: SoftLimit=False",
            "after return: SoftLimit=True X=20",
            "after over -: SoftLimit=True X=20",
            "after return 2: SoftLimit=True X=0",
        ], states);

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
            bool same = rd.Count == ro.Count && rd.Zip(ro).All(z => MotionRecord.IsCommand(z.First)
                ? MotionRecord.SameCommand(z.First, z.Second)
                : Enumerable.Range(0, 6).All(a => Math.Abs(BitConverter.ToDouble(z.First, 8 * a) - BitConverter.ToDouble(z.Second, 8 * a)) < 1e-9));
            output.WriteLine($"{name}: DLL [{string.Join(", ", cd.Select(c => c[..2]))}] ours [{string.Join(", ", co.Select(c => c[..2]))}]; " +
                             $"records DLL {rd.Count}, ours {ro.Count}{(same ? ", identical" : ", DIFFERENT")}");
            if (!cd.SequenceEqual(co)) failures.Add($"{name}: frames");
            if (!same) failures.Add($"{name}: records");
        }
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }
}

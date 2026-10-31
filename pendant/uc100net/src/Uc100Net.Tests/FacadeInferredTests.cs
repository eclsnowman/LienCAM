using System.Diagnostics;
using System.Text.Json;
using Uc100Net.Compat;

namespace Uc100Net.Tests;

/// <summary>
/// OracleDriver Inferred() (work/oracle/inferred.jsonl) through the facade,
/// the parts that do not depend on timing: HomeOn with Dir true and false
/// (frames), B and C moves, inch mode (records and GetAxisPosition), and Close
/// / Open (GetTrajParam and GetAxisSetting afterwards, and a corner on the
/// now disabled axes, which the DLL turned into one rest record).
/// </summary>
public partial class FacadeDifferentialTests
{
    [Fact]
    public void Facade_home_dir_BC_axes_inch_mode_and_reopen_match_the_DLL()
    {
        string root = Vectors.RepoRoot, dir = Path.Combine(root, "work", "oracle");
        string corpus = Path.Combine(dir, "inferred.jsonl"), marks = Path.Combine(dir, "inferred-markers.jsonl");
        if (!OracleDifferentialTests.OracleNetworkPresent() || !File.Exists(corpus) || !File.Exists(marks))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network and the inferred corpus");
            return;
        }
        string log = Path.Combine(dir, "uc100net-inferred.jsonl");
        var phases = new List<(string Name, double From, double To)>();
        var values = new List<string>();
        using (var fake = OracleDifferentialTests.StartFake(root, log, 50))
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
            void Phase(string name, Action f, int settleMs = 0)
            {
                double from = Wall();
                Thread.Sleep(60);
                f();
                Thread.Sleep(settleMs);
                var sw = Stopwatch.StartNew();
                var st = new UC100.Stat();
                do { Thread.Sleep(50); UC100.GetStatus(ref st); } while (!(st.Idle && !st.Home && sw.ElapsedMilliseconds > 250) && sw.ElapsedMilliseconds < 10000);
                Thread.Sleep(200);
                phases.Add((name, from, Wall()));
                Thread.Sleep(150);   // the fake stamps frames with its own clock: keep the next step clear of this window
            }
            string Pos()
            {
                double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
                UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c);
                return $"{x:R} {y:R} {z:R} {a:R} {b:R} {c:R}";
            }
            void Axis(int ax, double vel, double accel, double stepPer = 400)
            {
                var a = new UC100.AxisSetting { Axis = ax };
                UC100.GetAxisSetting(ref a);
                a.Axis = ax; a.Enable = true; a.StepPer = stepPer; a.MaxVel = vel; a.MaxAccel = accel;
                if (ax < 3) a.HomePin = ax + 1;
                Assert.Equal(0, UC100.SetAxisSetting(ref a));
            }

            Phase("home dir true", () => Assert.Equal(0, UC100.HomeOn(2, 25.0, 25.0 / 6.0, true)), 1300);
            Phase("home dir false", () => Assert.Equal(0, UC100.HomeOn(2, 25.0, 25.0 / 6.0, false)), 1300);
            Axis(4, 30, 500); Axis(5, 30, 500);
            Thread.Sleep(300);
            Phase("b only", () => Assert.Equal(0, UC100.AddLinearMoveP(null, null, null, null, 90, null, 1000.0 / 60, id++)));
            Phase("xbc", () => Assert.Equal(0, UC100.AddLinearMoveP(10, 0, 0, null, 45, 30, 1000.0 / 60, id++)));
            Phase("bc fast", () => Assert.Equal(0, UC100.AddLinearMoveP(0, 0, 0, null, 0, 0, 100, id++)));
            values.Add("after bc " + Pos());

            var tp = new UC100.TrajParam();
            UC100.GetTrajParam(ref tp);
            tp.Units = true;
            Assert.Equal(0, UC100.SetTrajParam(ref tp));
            double[] vel = [9000, 10000, 8000];
            for (int ax = 0; ax < 3; ax++) Axis(ax, vel[ax] / 60.0 / 25.4, 1000 / 25.4);
            Thread.Sleep(300);
            Phase("inch x1", () => Assert.Equal(0, UC100.AddLinearMoveP(1, 0, 0, null, null, null, 1.0, id++)));
            values.Add("inch after x1 " + Pos());
            Phase("inch return", () => Assert.Equal(0, UC100.AddLinearMoveP(0, 0, 0, null, null, null, 1.0, id++)));
            tp.Units = false;
            Assert.Equal(0, UC100.SetTrajParam(ref tp));
            for (int ax = 0; ax < 3; ax++) Axis(ax, vel[ax] / 60.0, 1000);
            Thread.Sleep(300);

            Assert.Equal(0, UC100.Close());
            Thread.Sleep(500);
            Assert.Equal(0, UC100.ListDevices(ref count));
            Assert.True(count == 1 && UC100.DeviceInfo(1, ref type, ref serial) == 0 && type == 19 && serial == 0x0BEEF0);
            Assert.Equal(0, UC100.Open(1));
            Thread.Sleep(500);
            UC100.GetTrajParam(ref tp);
            values.Add($"GetTrajParam after Open StopAngle={tp.StopAngle} ConstantVel={tp.ConstantVel} LinearErr={tp.LinearErr} CornerError={tp.CornerError} USBPufferSize={tp.USBPufferSize}");
            var x0 = new UC100.AxisSetting { Axis = 0 };
            UC100.GetAxisSetting(ref x0);
            values.Add($"X after Open Enable={x0.Enable} StepPer={x0.StepPer} MaxVel={x0.MaxVel} MaxAccel={x0.MaxAccel} SoftLimitP={x0.SoftLimitP} SoftLimitN={x0.SoftLimitN}");
            int rc = -1;
            for (int i = 0; i < 10 && rc != 0; i++) rc = UC100.Stop();
            double c30x = 10 + 10 * Math.Cos(Math.PI / 6), c30y = 10 * Math.Sin(Math.PI / 6);
            Phase("reopen corner 30", () =>
            {
                Assert.Equal(0, UC100.AddLinearMoveP(10, 0, 0, null, null, null, 1000.0 / 60, id++));
                Assert.Equal(0, UC100.AddLinearMoveP(c30x, c30y, 0, null, null, null, 1000.0 / 60, id++));
            });
            Assert.Equal(0, UC100.Close());
            fake.WaitForExit(70000);
        }

        foreach (var v in values) output.WriteLine(v);
        // What the DLL reported (work/oracle/inferred-events.jsonl).
        Assert.Equal(
        [
            "after bc 0 0 0 0 0 0",
            "inch after x1 1 0 0 0 0 0",
            "GetTrajParam after Open StopAngle=30 ConstantVel=False LinearErr=0.03 CornerError=0.03 USBPufferSize=0.1",
            "X after Open Enable=False StepPer=100 MaxVel=1 MaxAccel=1 SoftLimitP=100 SoftLimitN=100",
        ], values);

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
            output.WriteLine($"{name}: DLL [{string.Join(", ", cd)}] ours [{string.Join(", ", co)}]; " +
                             $"records DLL {rd.Count}, ours {ro.Count}{(same ? ", identical" : ", DIFFERENT")}");
            if (!cd.SequenceEqual(co)) failures.Add($"{name}: frames");
            if (!same) failures.Add($"{name}: records");
        }
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }
}

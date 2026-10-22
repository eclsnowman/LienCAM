using System.Diagnostics;
using System.Text.Json;
using Uc100Net.Compat;

namespace Uc100Net.Tests;

/// <summary>
/// Facade slice 2 against OracleDriver Calls() (work/oracle/calls.jsonl;
/// decoded in work/decode-calls.md): the same calls in the same order through
/// Uc100Net.Compat.UC100 into the fake. Per call, the non-status frames must
/// match the DLL's payload for payload; over the whole run the status-poll
/// requests must go through the same sequence of distinct values; the
/// AddLinearMoveRel and SetAxisPosition programs must stream the same records;
/// the Get* calls must return what the DLL's did. The probe is not covered
/// (the fake does not model it yet).
/// </summary>
public partial class FacadeDifferentialTests
{
    static double Wall() => DateTime.UtcNow.Subtract(DateTime.UnixEpoch).TotalSeconds;

    static List<string> Commands(IEnumerable<(double Wall, byte Cmd, byte[] Plain)> frames) =>
        [.. frames.Where(f => f.Cmd is not (byte)Command.Status and not (byte)Command.Motion).Select(f => $"{f.Cmd:x2} {Payload(f.Plain)}")];

    [Fact]
    public void Facade_slice_2_calls_send_what_the_DLL_sends()
    {
        string root = Vectors.RepoRoot, dir = Path.Combine(root, "work", "oracle");
        string corpus = Path.Combine(dir, "calls.jsonl"), marks = Path.Combine(dir, "calls-markers.jsonl");
        if (!OracleDifferentialTests.OracleNetworkPresent() || !File.Exists(corpus) || !File.Exists(marks))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network and the calls corpus");
            return;
        }
        string log = Path.Combine(dir, "uc100net-calls.jsonl");
        var phases = new List<(string Name, double From, double To)>();
        var values = new Dictionary<string, string>();
        using (var fake = OracleDifferentialTests.StartFake(root, log, 60))
        {
            Thread.Sleep(1200);
            UC100.ResetProcessState();
            UC100.Interfaces = [OracleDifferentialTests.Local];
            int count = 0, type = 0, serial = 0;
            Assert.Equal(0, UC100.ListDevices(ref count));
            Assert.True(count == 1 && UC100.DeviceInfo(1, ref type, ref serial) == 0 && type == 19 && serial == 0x0BEEF0);
            Assert.Equal(0, UC100.Open(1));
            Configure();
            Thread.Sleep(300);

            void Call(string name, Func<int> f)
            {
                double from = Wall();
                Thread.Sleep(60);
                Assert.True(f() == 0, name);
                Thread.Sleep(250);
                phases.Add((name, from, Wall()));
                Thread.Sleep(150);   // the fake stamps frames with its own clock: keep the next step clear of this window
            }
            void Program(string name, Action f)
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
            string Pos()
            {
                double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
                UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c);
                return $"{x:R} {y:R} {z:R}";
            }
            double fast = 100;
            int id = 1900;

            Call("SetEstopSetting 1", () => UC100.SetEstopSetting(1, false));
            Call("SetProbeSetting 5 0", () => UC100.SetProbeSetting(5, false, 0, false));
            Call("SetSoftLimit true", () => UC100.SetSoftLimit(true));
            Call("SetSoftLimit false", () => UC100.SetSoftLimit(false));
            Call("ClearSoftlimitState", UC100.ClearSoftlimitState);
            Call("LimitOverRide", UC100.LimitOverRide);
            Call("SetOffline true", () => UC100.SetOffline(true));
            Call("GetOffline", () => { bool s = false; int r = UC100.GetOffline(ref s); values["GetOffline"] = $"{s}"; return r; });
            Call("SetOffline false", () => UC100.SetOffline(false));
            Call("SetOutputBit 1", () => UC100.SetOutputBit(1));
            Call("GetOutput", () => { long w = 0; int r = UC100.GetOutput(ref w); values["GetOutput"] = $"{w}"; return r; });
            Call("ClearOutputBit 1", () => UC100.ClearOutputBit(1));
            Call("SetOutputBit 17", () => UC100.SetOutputBit(17));
            Call("ClearOutputBit 17", () => UC100.ClearOutputBit(17));
            Call("GetInput", () => { long w = 0; int r = UC100.GetInput(ref w); values["GetInput"] = $"{w}"; return r; });
            var sp = new UC100.SPSetting();
            Call("GetSpindleSetting", () => UC100.GetSpindleSetting(ref sp));
            values["SPSetting"] = $"{sp.Mode} {sp.PWMFreq} {sp.SPAccel} {sp.SPStepPerRev} {sp.SPMinVel} {sp.SPMaxVel} {sp.SPMinPWMPercent} {sp.SPMaxPWMPercent}";
            sp.Mode = 1; sp.SPPin = 3; sp.PWMFreq = 1000; sp.SPMinVel = 0; sp.SPMaxVel = 24000; sp.SPMinPWMPercent = 0; sp.SPMaxPWMPercent = 100;
            sp.SPM3Pin = 4; sp.EnableM3M4Output = true;
            Call("SetSpindleSetting pwm", () => UC100.SetSpindleSetting(ref sp));
            Call("SetSpindleSpeed 12000", () => UC100.SetSpindleSpeed(12000));
            Call("SpindleOn cw", () => UC100.SpindleOn(false));
            Call("SetSpindleSpeed 6000", () => UC100.SetSpindleSpeed(6000));
            Call("SpindleOn ccw", () => UC100.SpindleOn(true));
            Call("SpindleOff", UC100.SpindleOff);
            Call("SetSRO 80", () => UC100.SetSRO(80));
            Call("SetJRO 50", () => UC100.SetJRO(50));
            Call("JogOnSpeed X 10 at JRO 50", () => UC100.JogOnSpeed(0, false, 10));
            Call("JogOnSpeed X 0", () => UC100.JogOnSpeed(0, false, 0));
            Call("SetJRO 100", () => UC100.SetJRO(100));
            Call("SetSRO 100", () => UC100.SetSRO(100));
            Program("jog return", () => UC100.AddLinearMoveP(0, 0, 0, null, null, null, fast, id++));
            Program("rel x +2 at 50", () => UC100.AddLinearMoveRel(0, 2.0, 1, 50, false));
            values["after rel +2"] = Pos();
            Program("rel x -2 at 20", () => UC100.AddLinearMoveRel(0, 2.0, 1, 20, true));
            values["after rel -2"] = Pos();
            Program("rel y +1 x3 at 50", () => UC100.AddLinearMoveRel(1, 1.0, 3, 50, false));
            values["after rel y"] = Pos();
            Program("rel return", () => UC100.AddLinearMoveP(0, 0, 0, null, null, null, fast, id++));
            Call("SetAxisPosition 5", () => UC100.SetAxisPosition(5, 0, 0, 0, 0, 0));
            values["after SetAxisPosition"] = Pos();
            Program("offset move x10", () => UC100.AddLinearMoveP(10, 0, 0, null, null, null, fast, id++));
            values["after offset move"] = Pos();
            Program("offset return", () => UC100.AddLinearMoveP(5, 0, 0, null, null, null, fast, id++));
            Call("SetAxisPosition 0", () => UC100.SetAxisPosition(0, 0, 0, 0, 0, 0));
            values["after SetAxisPosition 0"] = Pos();
            Call("SetEstopState", UC100.SetEstopState);
            Call("Stop after estop", UC100.Stop);
            Assert.Equal(0, UC100.Close());
            fake.WaitForExit(75000);
        }

        foreach (var (k, v) in values) output.WriteLine($"{k}: {v}");
        Assert.Equal("True", values["GetOffline"]);
        Assert.Equal("-217874954176031", values["GetOutput"]);
        Assert.Equal("1536", values["GetInput"]);
        Assert.Equal("0 1 1 1 0 100 0 100", values["SPSetting"]);   // the DLL's defaults, as GetSpindleSetting logged them
        Assert.Equal("2 0 0", values["after rel +2"]);
        Assert.Equal("0 0 0", values["after rel -2"]);
        Assert.Equal("0 3 0", values["after rel y"]);
        Assert.Equal("5 0 0", values["after SetAxisPosition"]);
        Assert.Equal("10 0 0", values["after offset move"]);
        Assert.Equal("0 0 0", values["after SetAxisPosition 0"]);

        var dll = Frames(corpus);
        var ours = Frames(log);
        var m = File.ReadLines(marks).Select(l => JsonDocument.Parse(l).RootElement)
            .ToDictionary(e => e.GetProperty("experiment").GetString()!, e => e.GetProperty("wall").GetDouble());
        var failures = new List<string>();
        string[] motionPhases = ["rel x +2 at 50", "rel x -2 at 20", "rel y +1 x3 at 50", "rel return", "offset move x10", "offset return"];
        foreach (var (name, from, to) in phases)
        {
            var d = dll.Where(f => f.Wall > m[name + " start"] && f.Wall <= m[name + " end"]).ToList();
            var o = ours.Where(f => f.Wall > from && f.Wall <= to).ToList();
            var cd = Commands(d); var co = Commands(o);
            output.WriteLine($"{name}: DLL [{string.Join(", ", cd.Select(c => c[..2]))}] ours [{string.Join(", ", co.Select(c => c[..2]))}]");
            if (!cd.SequenceEqual(co)) failures.Add($"{name}: frames");
            if (motionPhases.Contains(name))
            {
                var rd = Records(d); var ro = Records(o);
                bool same = rd.Count == ro.Count && rd.Zip(ro).All(z => MotionRecord.IsCommand(z.First)
                    ? MotionRecord.SameCommand(z.First, z.Second)
                    : Enumerable.Range(0, 6).All(a => Math.Abs(BitConverter.ToDouble(z.First, 8 * a) - BitConverter.ToDouble(z.Second, 8 * a)) < 1e-9));
                output.WriteLine($"   motion: DLL {rd.Count} records, ours {ro.Count}{(same ? ", identical" : ", DIFFERENT")}");
                if (!same) failures.Add($"{name}: motion");
            }
        }

        // The poll requests, as the sequence of distinct values from the first call
        // on. A LimitOverRide pulse lasts one poll and may fall between two of the
        // DLL's ticks (it did in the oracle run), so polls carrying it are left out.
        List<string> Polls(IEnumerable<(double Wall, byte Cmd, byte[] Plain)> frames, double from, double to)
        {
            var list = new List<string>();
            foreach (var f in frames.Where(f => f.Cmd == (byte)Command.Status && f.Wall > from && f.Wall <= to))
            {
                string p = Payload(f.Plain);
                if ((Convert.FromHexString(p)[6] & 1) != 0) continue;
                if (list.Count == 0 || list[^1] != p) list.Add(p);
            }
            return list;
        }
        var pd = Polls(dll, m["SetEstopSetting 1 start"], m["Stop after estop end"]);
        var po = Polls(ours, phases[0].From, phases[^1].To);
        output.WriteLine($"polls DLL:  {string.Join(" ", pd.Select(p => p[..14]))}");
        output.WriteLine($"polls ours: {string.Join(" ", po.Select(p => p[..14]))}");
        if (!pd.SequenceEqual(po)) failures.Add("poll request sequence");
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }

    /// <summary>OracleDriver.Configure() through the facade.</summary>
    static void Configure()
    {
        int rc = -1;
        for (int i = 0; i < 10 && rc != 0; i++) rc = UC100.Stop();
        var tp = new UC100.TrajParam();
        UC100.GetTrajParam(ref tp);
        tp.ConstantVel = true; tp.StopAngle = 89; tp.LinearErr = 0.03; tp.CornerError = 0.03; tp.USBPufferSize = 0.1;
        Assert.Equal(0, UC100.SetTrajParam(ref tp));
        double[] vel = [9000, 10000, 8000];
        for (int ax = 0; ax < 3; ax++)
        {
            var a = new UC100.AxisSetting { Axis = ax };
            UC100.GetAxisSetting(ref a);
            a.Axis = ax; a.Enable = true; a.StepPer = 400; a.MaxVel = vel[ax] / 60.0; a.MaxAccel = 1000; a.HomePin = ax + 1;
            Assert.Equal(0, UC100.SetAxisSetting(ref a));
        }
    }
}

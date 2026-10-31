using System.Diagnostics;
using System.Text.Json;
using Xunit.Abstractions;
using Uc100Net.Compat;

namespace Uc100Net.Tests;

/// <summary>
/// The UC100-compatible facade (Uc100Net.Compat.UC100) driven with
/// OracleDriver's own calls (Main's discovery guard, Configure(), then the
/// stat scenario's "ids" and "merge" programs) against the fake, compared
/// with what DLL 2190 sent for the same calls (work/oracle/stat.jsonl): the
/// settings frames payload for payload, and every motion record of the two
/// programs. Skips without the UC-Oracle network or the corpus.
/// </summary>
[Collection(OracleNetwork.Name)]
public partial class FacadeDifferentialTests(ITestOutputHelper output)
{
    static List<(double Wall, byte Cmd, byte[] Plain)> Frames(string jsonl) =>
        [.. File.ReadLines(jsonl).Select(l => JsonDocument.Parse(l).RootElement)
            .Where(r => r.GetProperty("port").GetInt32() == 4912)
            .Select(r => (r.TryGetProperty("wall", out var w) ? w.GetDouble() : 0, Convert.FromHexString(r.GetProperty("plain").GetString()!)))
            .Select(x => (x.Item1, x.Item2[3], x.Item2))];

    static string Payload(byte[] plain) => Convert.ToHexString(plain.AsSpan(6, plain.Length - 8));

    static List<byte[]> Records(IEnumerable<(double Wall, byte Cmd, byte[] Plain)> frames) =>
        [.. frames.Where(f => f.Cmd == (byte)Command.Motion)
            .SelectMany(f => Enumerable.Range(0, f.Plain[6]).Select(i => f.Plain.AsSpan(7 + 48 * i, 48).ToArray()))];

    static List<string> SettingsPayloads(IEnumerable<(double Wall, byte Cmd, byte[] Plain)> frames) =>
        [.. frames.TakeWhile(f => f.Cmd != (byte)Command.Motion)
            .Where(f => f.Cmd is (byte)Command.Settings or (byte)Command.AxisBlock).Select(f => $"{f.Cmd:x2} {Payload(f.Plain)}")];

    static void WaitIdle()
    {
        var sw = Stopwatch.StartNew();
        var st = new UC100.Stat();
        do { Thread.Sleep(50); UC100.GetStatus(ref st); } while (!(st.Idle && sw.ElapsedMilliseconds > 250) && sw.ElapsedMilliseconds < 10000);
        Thread.Sleep(200);
    }

    [Fact]
    public void Facade_sends_what_the_DLL_sends_for_the_drivers_calls()
    {
        string root = Vectors.RepoRoot, dir = Path.Combine(root, "work", "oracle");
        string corpus = Path.Combine(dir, "stat.jsonl"), marks = Path.Combine(dir, "stat-markers.jsonl");
        if (!OracleDifferentialTests.OracleNetworkPresent() || !File.Exists(corpus) || !File.Exists(marks))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network and the stat corpus");
            return;
        }
        string log = Path.Combine(dir, "uc100net-facade.jsonl");
        using (var fake = OracleDifferentialTests.StartFake(root, log, 25))
        {
            Thread.Sleep(1200);
            UC100.ResetProcessState();
            UC100.Interfaces = [OracleDifferentialTests.Local];   // probe the oracle network only

            // OracleDriver.Main: exactly one device and it is the fake.
            int count = 0, type = 0, serial = 0;
            Assert.Equal(0, UC100.ListDevices(ref count));
            Assert.Equal(1, count);
            Assert.Equal(0, UC100.DeviceInfo(1, ref type, ref serial));
            Assert.Equal((19, 0x0BEEF0), (type, serial));
            Assert.Equal(0, UC100.Open(1));
            var v = new UC100.Versio();
            Assert.Equal(0, UC100.GetVersio(ref v));
            Assert.Equal((1005, 0x0BEEF0), (v.FWVersion, v.SerialNumber));

            // OracleDriver.Configure()
            int rc = -1;
            for (int i = 0; i < 10 && rc != 0; i++) rc = UC100.Stop();
            Assert.Equal(0, rc);
            var tp = new UC100.TrajParam();
            Assert.Equal(0, UC100.GetTrajParam(ref tp));
            Assert.Equal((30.0, false, 0.2), (tp.StopAngle, tp.ConstantVel, tp.USBPufferSize));   // the DLL's defaults
            tp.ConstantVel = true; tp.StopAngle = 89; tp.LinearErr = 0.03; tp.CornerError = 0.03; tp.USBPufferSize = 0.1;
            Assert.Equal(0, UC100.SetTrajParam(ref tp));
            double[] vel = [9000, 10000, 8000];
            for (int ax = 0; ax < 3; ax++)
            {
                var a = new UC100.AxisSetting { Axis = ax };
                Assert.Equal(0, UC100.GetAxisSetting(ref a));
                a.Axis = ax; a.Enable = true; a.StepPer = 400; a.MaxVel = vel[ax] / 60.0; a.MaxAccel = 1000; a.HomePin = ax + 1;
                Assert.Equal(0, UC100.SetAxisSetting(ref a));
            }

            // StatScenario(): "ids", then "merge".
            double f = 1000.0 / 60.0, fast = 100;
            Assert.Equal(0, UC100.AddLinearMoveP(10, 0, 0, null, null, null, f, 201));
            Assert.Equal(0, UC100.AddLinearMoveP(10 + 10 * Math.Cos(Math.PI / 6), 10 * Math.Sin(Math.PI / 6), 0, null, null, null, f, 202));
            Assert.Equal(0, UC100.AddLinearMoveP(10, 10, 0, null, null, null, f, 203));
            Assert.Equal(0, UC100.AddDwell(250, 204));
            Assert.Equal(0, UC100.AddDummyMove(205));
            Assert.Equal(0, UC100.AddLinearMoveP(0, 0, 0, null, null, null, fast, 206));
            WaitIdle();
            var st = new UC100.Stat();
            Assert.Equal(0, UC100.GetStatus(ref st));
            Assert.Equal((true, 0, 206), (st.Idle, st.Puffer, st.CurrentID));
            foreach (var (x, id) in new[] { (10.0, 601), (20, 602), (30, 603) })
                Assert.Equal(0, UC100.AddLinearMoveP(x, 0, 0, null, null, null, f, id));
            Assert.Equal(0, UC100.AddLinearMoveP(null, 10, null, null, null, null, f, 604));   // null: keep X at 30
            WaitIdle();
            double px = 0, py = 0, pz = 0, pa = 0, pb = 0, pc = 0;
            Assert.Equal(0, UC100.GetAxisPosition(ref px, ref py, ref pz, ref pa, ref pb, ref pc));
            output.WriteLine($"after merge: X {px} Y {py}");
            Assert.Equal((30.0, 10.0), (px, py));
            Assert.Equal(0, UC100.Close());
            Assert.Equal(1, UC100.GetStatus(ref st));   // not open
            fake.WaitForExit(40000);
        }

        var dllFrames = Frames(corpus);
        var m = File.ReadLines(marks).Select(l => JsonDocument.Parse(l).RootElement)
            .ToDictionary(e => e.GetProperty("experiment").GetString()!, e => e.GetProperty("wall").GetDouble());
        var dllMotion = Records(dllFrames.Where(x => x.Wall > m["ids start"] && x.Wall <= m["ids end"]))
            .Concat(Records(dllFrames.Where(x => x.Wall > m["merge start"] && x.Wall <= m["merge end"]))).ToList();
        var ours = Frames(log);
        var ourMotion = Records(ours);

        var dllSettings = SettingsPayloads(dllFrames);
        var ourSettings = SettingsPayloads(ours);
        output.WriteLine($"settings frames before motion: DLL {dllSettings.Count}, ours {ourSettings.Count}; " +
                         $"motion records: DLL {dllMotion.Count}, ours {ourMotion.Count}");
        Assert.Equal(dllSettings, ourSettings);
        Assert.Equal(dllMotion.Count, ourMotion.Count);
        double worst = 0;
        for (int i = 0; i < dllMotion.Count; i++)
        {
            if (MotionRecord.IsCommand(dllMotion[i]) || MotionRecord.IsCommand(ourMotion[i]))
            {
                Assert.True(MotionRecord.SameCommand(dllMotion[i], ourMotion[i]), $"command record {i} differs");
                continue;
            }
            for (int a = 0; a < 6; a++)
                worst = Math.Max(worst, Math.Abs(BitConverter.ToDouble(dllMotion[i], 8 * a) - BitConverter.ToDouble(ourMotion[i], 8 * a)));
        }
        output.WriteLine($"max position difference {worst:E2} mm");
        Assert.True(worst < 1e-9);
    }
}

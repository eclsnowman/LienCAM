using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Xunit.Abstractions;

namespace Uc100Net.Tests;

/// <summary>
/// MachineSettings against the 0x0D settings and 0x09 axis frames UC100.dll
/// 2190 sent through the oracle (docs/SETTINGS.md). Skips without the logs.
/// </summary>
public class SettingsTests(ITestOutputHelper output)
{
    static string Oracle => Path.Combine(Vectors.RepoRoot, "work", "oracle");

    /// <summary>(wall, cmd, payload) of every 0x0D / 0x09 frame in a fake-board log.</summary>
    static List<(double Wall, int Cmd, byte[] Payload)> Frames(string jsonl) =>
        [.. File.ReadLines(jsonl).Select(l => JsonDocument.Parse(l).RootElement)
            .Where(r => r.GetProperty("port").GetInt32() == 4912 && r.GetProperty("cmd").GetInt32() is 9 or 13)
            .Select(r =>
            {
                byte[] plain = Convert.FromHexString(r.GetProperty("plain").GetString()!);
                return (r.GetProperty("wall").GetDouble(), r.GetProperty("cmd").GetInt32(), plain[6..^2]);
            })];

    /// <summary>OracleDriver Configure(): X Y Z enabled, StepPer 400, MaxAccel 1000, HomePin 1..3.</summary>
    static IEnumerable<MachineSettings> Configure(MachineSettings s)
    {
        double[] vel = [9000, 10000, 8000];
        for (int ax = 0; ax < 3; ax++)
        {
            s.SetAxis(ax, s.Axes[ax] with { Enable = true, StepPer = 400, MaxVel = vel[ax] / 60.0, MaxAccel = 1000, HomePin = ax + 1 });
            yield return s;
        }
    }

    [Fact]
    public void Open_defaults_are_the_DLL_default_blocks()
    {
        var s = new MachineSettings();
        Assert.Equal(Defaults.SettingsBlock, s.SettingsPayload());
        Assert.Equal(Enumerable.Range(0, 12).SelectMany(_ => BitConverter.GetBytes(100.0)), s.AxisBlockPayload());
    }

    /// <summary>planes.jsonl: Open, Configure() X/Y/Z, Y MaxAccel 500, Y MaxVel 20, Y back, A enabled.</summary>
    [Fact]
    public void Configure_and_axis_changes_match_the_DLL()
    {
        string log = Path.Combine(Oracle, "planes.jsonl");
        if (!File.Exists(log)) { output.WriteLine("SKIPPED: planes.jsonl missing"); return; }
        var frames = Frames(log);
        var s = new MachineSettings();
        var expect13 = new List<byte[]> { s.SettingsPayload() };
        var expect09 = new List<byte[]>();
        foreach (var _ in Configure(s)) { expect13.Add(s.SettingsPayload()); expect09.Add(s.AxisBlockPayload()); }
        foreach (var (ax, vel, accel) in new[] { (1, 10000.0 / 60, 500.0), (1, 20.0, 1000.0), (1, 10000.0 / 60, 1000.0), (3, 30.0, 500.0) })
        {
            s.SetAxis(ax, s.Axes[ax] with { Enable = true, StepPer = 400, MaxVel = vel, MaxAccel = accel });
            expect13.Add(s.SettingsPayload()); expect09.Add(s.AxisBlockPayload());
        }
        var got13 = frames.Where(f => f.Cmd == 13).Select(f => f.Payload).ToList();
        var got09 = frames.Where(f => f.Cmd == 9).Select(f => f.Payload).ToList();
        output.WriteLine($"0x0D: {got13.Count} frames, 0x09: {got09.Count} frames");
        Assert.Equal(expect13.Count, got13.Count);
        Assert.Equal(expect09.Count, got09.Count);
        for (int i = 0; i < expect13.Count; i++) Assert.True(expect13[i].SequenceEqual(got13[i]), $"0x0D frame {i} differs");
        for (int i = 0; i < expect09.Count; i++) Assert.True(expect09[i].SequenceEqual(got09[i]), $"0x09 frame {i} differs");
    }

    /// <summary>
    /// sweep.jsonl: every AxisSetting field of X and Y changed one at a time
    /// (OracleDriver Sweep()), each followed by a restore, then four e-stop
    /// settings. The last 0x0D / 0x09 frame in each marker window must match.
    /// </summary>
    [Fact]
    public void Every_axis_field_and_estop_change_matches_the_DLL()
    {
        string log = Path.Combine(Oracle, "sweep.jsonl"), marks = Path.Combine(Oracle, "sweep-markers.jsonl");
        if (!File.Exists(log) || !File.Exists(marks)) { output.WriteLine("SKIPPED: sweep corpus missing"); return; }
        var frames = Frames(log);
        var m = File.ReadLines(marks).Select(l => JsonDocument.Parse(l).RootElement)
            .Select(e => (Name: e.GetProperty("experiment").GetString()!, Wall: e.GetProperty("wall").GetDouble())).ToList();
        var s = new MachineSettings();
        foreach (var _ in Configure(s)) { }
        var baseline = new[] { s.Axes[0], s.Axes[1] };
        int lastAxis = 0, compared = 0;
        var failures = new List<string>();
        for (int i = 1; i < m.Count; i++)
        {
            string e = m[i].Name;
            var window = frames.Where(f => f.Wall > m[i - 1].Wall && f.Wall <= m[i].Wall).ToList();
            var field = Regex.Match(e, @"^axis(\d)\.(\w+)=(.*)$");
            if (field.Success)
            {
                lastAxis = int.Parse(field.Groups[1].Value);
                var changed = baseline[lastAxis] with { };
                var prop = typeof(AxisSettings).GetProperty(field.Groups[2].Value)!;
                string v = field.Groups[3].Value;
                object value = prop.PropertyType == typeof(bool) ? bool.Parse(v)
                    : prop.PropertyType == typeof(int) ? (object)int.Parse(v, CultureInfo.InvariantCulture)
                    : double.Parse(v, CultureInfo.InvariantCulture);
                prop.SetValue(changed, value);
                s.SetAxis(lastAxis, changed);
            }
            else if (e == "restore") s.SetAxis(lastAxis, baseline[lastAxis]);
            else if (Regex.Match(e, @"^estop pin=(\d+) neg=(\w+)$") is { Success: true } es)
                s.SetEstop(int.Parse(es.Groups[1].Value), bool.Parse(es.Groups[2].Value));
            else continue;   // traj.*: the DLL sends no settings frame
            var last13 = window.LastOrDefault(f => f.Cmd == 13).Payload;
            var last09 = window.LastOrDefault(f => f.Cmd == 9).Payload;
            if (last13 is null) continue;   // nothing sent in this window
            compared++;
            if (!s.SettingsPayload().SequenceEqual(last13)) failures.Add($"{e} 0x0D");
            if (last09 is not null && !s.AxisBlockPayload().SequenceEqual(last09)) failures.Add($"{e} 0x09");
        }
        output.WriteLine($"{compared} experiments and restores compared, {failures.Count} mismatches");
        Assert.True(compared > 100, $"only {compared} windows compared");
        Assert.True(failures.Count == 0, string.Join("; ", failures));
    }
    /// <summary>
    /// The 0x0A spindle frame (work/decode-calls.md 2) against every one the
    /// DLL sent: Open's (the defaults: PWMFreq 1, 0..100 rpm, speed 10) and
    /// the oracle "calls" run (PWM 1000 Hz, 0..24000 rpm; speeds 12000 and
    /// 6000; SRO 80 and back to 100).
    /// </summary>
    [Fact]
    public void Spindle_speed_frames_match_the_DLL()
    {
        var pwm = new SpindleSettings { Mode = 1, PwmFreq = 1000, MaxVel = 24000 };
        var cases = new (string Name, SpindleSettings Sp, double Rpm, double Sro, string Hex)[]
        {
            ("Open", new SpindleSettings(), 10, 100, "409c801a555555555555c53f"),
            ("SetSpindleSetting pwm", pwm, 10, 100, "00009001555555555555c53f"),
            ("SetSpindleSpeed 12000", pwm, 12000, 100, "c80090010000000000006940"),
            ("SetSpindleSpeed 6000", pwm, 6000, 100, "640090010000000000005940"),
            ("SetSRO 80", pwm, 6000, 80, "500090010000000000005440"),
            ("SetSRO 100", pwm, 6000, 100, "640090010000000000005940"),
        };
        foreach (var (name, sp, rpm, sro, hex) in cases)
        {
            string ours = Convert.ToHexString(SpindleFrames.Speed(sp, rpm, sro)).ToLowerInvariant();
            output.WriteLine($"{name}: {ours} (DLL {hex})");
            Assert.Equal(hex, ours);
        }
        Assert.Equal(Convert.ToHexString(Defaults.Init0A), Convert.ToHexString(SpindleFrames.Speed(new SpindleSettings(), 10, 100)));
        // The 0x1A the DLL sent after SetSpindleSetting (calls.jsonl): PID off, PWM 0..100 %, 100 counts/rev.
        Assert.Equal("00010000000000000000000000000000000000f03f0000000000000000000000000000000000000000000000000000000000005940",
            Convert.ToHexString(SpindleFrames.Pid(pwm)).ToLowerInvariant());
    }
}

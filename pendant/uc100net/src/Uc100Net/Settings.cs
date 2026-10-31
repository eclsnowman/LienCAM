namespace Uc100Net;

/// <summary>
/// One axis as UC100.AxisSetting carries it. The defaults are what Open()
/// stores before any SetAxisSetting: disabled, MaxAccel = MaxVel = 1,
/// StepPer 100, soft limits 100, everything else 0.
/// </summary>
public sealed record AxisSettings
{
    public bool Enable { get; init; }
    public int StepPin { get; init; }
    public int DirPin { get; init; }
    public bool StepNeg { get; init; }
    public bool DirNeg { get; init; }
    /// <summary>units/s^2</summary>
    public double MaxAccel { get; init; } = 1;
    /// <summary>units/s</summary>
    public double MaxVel { get; init; } = 1;
    public double StepPer { get; init; } = 100;
    public int HomePin { get; init; }
    public bool HomeNeg { get; init; }
    public int LimitPPin { get; init; }
    public bool LimitPNeg { get; init; }
    public int LimitNPin { get; init; }
    public bool LimitNNeg { get; init; }
    public double SoftLimitP { get; init; } = 100;
    public double SoftLimitN { get; init; } = 100;
    /// <summary>For X, Y, Z: the slave axis (3..5 = A..C), 0 for none.</summary>
    public int SlaveAxis { get; init; }
    public bool BacklashOn { get; init; }
    public double BacklashDist { get; init; }
    public double CompAccel { get; init; }
    public int EnablePin { get; init; }
    public bool EnablePinNeg { get; init; }
    public int EnableDelay { get; init; }
    public int CurrentHiLowPin { get; init; }
    public bool CurrentHiLowPinNeg { get; init; }
    public double HomeBackOff { get; init; }
    public bool RotaryAxis { get; init; }
    public bool RotaryRollover { get; init; }
}

/// <summary>A pin and its invert flag, as the Set*Setting calls take them.</summary>
public readonly record struct Pin(int Number, bool Neg = false);

/// <summary>SPSetting fields that reach the settings block.</summary>
public sealed record SpindleSettings
{
    /// <summary>0 = none, 1 = PWM, 2 = step/dir (INFERRED from which bytes the DLL fills).</summary>
    public int Mode { get; init; }
    public Pin SpPin { get; init; }
    public Pin SpDirPin { get; init; }
    public double SpAccel { get; init; } = 1;
    public double SpStepPerRev { get; init; } = 1;
    public Pin M3Pin { get; init; }
    public Pin M4Pin { get; init; }
    public bool EnableM3M4Output { get; init; }
    // Not in the settings block; the 0x0A speed frame and the 0x1A frame use
    // them (work/decode-calls.md 2). Defaults are the DLL's (its .data).
    public int PwmFreq { get; init; } = 1;
    /// <summary>rpm</summary>
    public double MinVel { get; init; }
    /// <summary>rpm</summary>
    public double MaxVel { get; init; } = 100;
    public double MinPwmPercent { get; init; }
    public double MaxPwmPercent { get; init; } = 100;
}

/// <summary>
/// The spindle frames UC100.dll 2190 sends to the AXBB-E (work/decode-calls.md
/// sections 2 and 3, checked against the oracle "calls" run).
/// </summary>
public static class SpindleFrames
{
    /// <summary>The DLL's spindle timer runs at 400 kHz.</summary>
    const double TimerHz = 400000;

    /// <summary>
    /// 0x0A (FUN_180032d10): u16 LE PWM on-count, u16 LE period (both
    /// truncated to 16 bits as the DLL does), LE double rev/s.
    /// v = clamp(speed x sro / 100, MinVel, MaxVel); duty% is v mapped linearly
    /// onto MinPwm..MaxPwm; on-count = (int)(period x duty / 100).
    /// </summary>
    public static byte[] Speed(SpindleSettings sp, double rpm, double sroPercent)
    {
        double lo = Math.Min(sp.MinVel, sp.MaxVel), hi = Math.Max(sp.MinVel, sp.MaxVel);
        double v = Math.Clamp(rpm * sroPercent / 100, lo, hi);
        double duty = sp.MaxVel == sp.MinVel ? sp.MinPwmPercent
            : sp.MinPwmPercent + (sp.MaxPwmPercent - sp.MinPwmPercent) * (v - sp.MinVel) / (sp.MaxVel - sp.MinVel);
        duty = Math.Clamp(duty, Math.Min(sp.MinPwmPercent, sp.MaxPwmPercent), Math.Max(sp.MinPwmPercent, sp.MaxPwmPercent));
        int period = (int)(TimerHz / Math.Max(1, sp.PwmFreq));
        int on = (int)(period * duty / 100);
        var b = new byte[12];
        BitConverter.TryWriteBytes(b.AsSpan(0), (ushort)on);
        BitConverter.TryWriteBytes(b.AsSpan(2), (ushort)period);
        BitConverter.TryWriteBytes(b.AsSpan(4), v / 60);
        return b;
    }

    /// <summary>
    /// 0x1A (FUN_1800383f0) with the spindle PID off, as Uc100Net always sends
    /// it: 0, prescaler term 1, analog output 0, 0, MinPwm / 100, MaxPwm / 100,
    /// gains 0, encoder counts/rev 100 (the DLL's default). CAPTURED for the
    /// defaults; the PID itself is not supported.
    /// </summary>
    public static byte[] Pid(SpindleSettings sp)
    {
        var b = new byte[53];
        BitConverter.TryWriteBytes(b.AsSpan(1), (ushort)1);
        BitConverter.TryWriteBytes(b.AsSpan(5), sp.MinPwmPercent / 100);
        BitConverter.TryWriteBytes(b.AsSpan(13), sp.MaxPwmPercent / 100);
        BitConverter.TryWriteBytes(b.AsSpan(45), 100.0);
        return b;
    }
}

/// <summary>THCSetting fields that reach the settings block.</summary>
public sealed record ThcSettings
{
    public Pin OnPin { get; init; }
    public Pin UpPin { get; init; }
    public Pin DownPin { get; init; }
    /// <summary>Seconds, 0..10.</summary>
    public double OnTime { get; init; }
    public Pin EnPin { get; init; }
    public Pin AntiDivePin { get; init; }
    public Pin AntiDownPin { get; init; }
}

/// <summary>EncoderSetting fields that reach the settings block (pins already validated).</summary>
public sealed record EncoderSettings
{
    public int MpgPinA { get; init; }
    public int MpgPinB { get; init; }
    public int EncoderPinA { get; init; }
    public int EncoderPinB { get; init; }
    public bool EncoderReverseDirection { get; init; }
    /// <summary>Aux1 A, Aux1 B, Aux2 A ... Aux6 B.</summary>
    public int[] Aux { get; init; } = new int[12];
}

/// <summary>
/// Everything UC100.dll 2190 puts in the AXBB-E's settings frames: the 0x0D
/// block (392-byte payload, built by FUN_180022b30) and the 0x09 axis block
/// (96 bytes, FUN_180032430). Layout decoded from the decompile and checked
/// byte for byte against every 0x0D / 0x09 frame the DLL sent in the oracle
/// (docs/SETTINGS.md). <see cref="SetAxis"/> applies SetAxisSetting's
/// clamps. Only the AXBB-E (board type 19) is modelled.
/// </summary>
public sealed class MachineSettings
{
    public const int SettingsLength = 392;
    public const int AxisBlockLength = 96;

    /// <summary>Output pins whose on/off sense the DLL inverts on the AXBB-E (FUN_18002bc80, board 0x13).</summary>
    static readonly HashSet<int> Flip = [2, 26, 27, 29, 30, 31, 32, 47];
    const int MaxPin = 0x3F;

    public AxisSettings[] Axes { get; } = [.. Enumerable.Range(0, 6).Select(_ => new AxisSettings())];
    /// <summary>SetStepRate: 0..4 on Ethernet boards; also caps MaxVel x StepPer.</summary>
    public int StepRate { get; set; }
    public Pin Estop { get; set; }
    public Pin ChargePump1 { get; set; }
    public Pin ChargePump2 { get; set; }
    public int IndexPin { get; set; }
    public EncoderSettings Encoder { get; set; } = new();
    public SpindleSettings Spindle { get; set; } = new();
    public ThcSettings Thc { get; set; } = new();
    public Pin Probe1 { get; set; }
    public Pin Probe2 { get; set; }
    /// <summary>SetLaserOutPin; a non-zero pin disables axis C.</summary>
    public Pin Laser { get; set; }
    /// <summary>SetOutputPin Out1..Out10.</summary>
    public Pin[] Outputs { get; } = new Pin[10];
    /// <summary>SetDebounce: Debounce, THCDebounce, HomeDebounce, Probe1Debounce, Probe2Debounce.</summary>
    public int[] Debounce { get; } = new int[5];
    /// <summary>SetTangentialCutter Enable (sets the A rotary bit).</summary>
    public bool TangentialCutter { get; set; }
    /// <summary>The last SetAxisPosition values; the 0x09 soft limits are sent relative to them (UNCONFIRMED by data).</summary>
    public double[] Positions { get; } = new double[6];

    static readonly double[] RateLimit = [95000, 47500, 23750, 190000, 380000];

    /// <summary>
    /// SetAxisSetting (UC100.dll 2190 @180005550): clamp the values as the
    /// DLL does and store them, including its slave-axis rules. Inch mode
    /// (TrajParam.Units, x25.4) is not modelled: values are in mm.
    /// </summary>
    public void SetAxis(int axis, AxisSettings p)
    {
        if (axis is < 0 or > 5) throw new ArgumentOutOfRangeException(nameof(axis));
        static int PinOr0(int pin) => pin is < 0 or > MaxPin ? 0 : pin;
        double stepPer = p.StepPer == 0 ? 1 : Math.Abs(p.StepPer);
        double maxVel = p.MaxVel == 0 ? 1 : Math.Abs(p.MaxVel);
        if (StepRate is >= 0 and <= 4 && stepPer * maxVel > RateLimit[StepRate]) maxVel = RateLimit[StepRate] / stepPer;
        double maxAccel = p.MaxAccel <= 0 ? 0.01 : p.MaxAccel;
        p = p with
        {
            MaxAccel = maxAccel,
            StepPin = PinOr0(p.StepPin), DirPin = PinOr0(p.DirPin), HomePin = PinOr0(p.HomePin),
            LimitNPin = PinOr0(p.LimitNPin), LimitPPin = PinOr0(p.LimitPPin), EnablePin = PinOr0(p.EnablePin),
            StepPer = stepPer, MaxVel = maxVel,
            SlaveAxis = axis < 3 && p.SlaveAxis is >= 3 and <= 5 ? p.SlaveAxis : 0,
            CompAccel = p.CompAccel < maxAccel * 1.2 ? maxAccel * 1.2 : p.CompAccel,
            BacklashDist = p.BacklashOn ? p.BacklashDist : 0,
            EnableDelay = Math.Clamp(p.EnableDelay, 0, 255),
            CurrentHiLowPin = PinOr0(p.CurrentHiLowPin),
            RotaryAxis = axis >= 3 && p.RotaryAxis,
        };
        if (p.Enable && axis >= 3 && p.StepPin == 0 && p.DirPin == 0) p = p with { StepPin = 0x3C, DirPin = 0x3D };

        bool isSlave = axis >= 3 && Axes.Take(3).Any(a => a.SlaveAxis == axis);
        if (!isSlave) Axes[axis] = p;
        else
            Axes[axis] = Axes[axis] with   // a slave takes only its pins and a few extras
            {
                DirNeg = p.DirNeg, DirPin = p.DirPin, HomePin = p.HomePin, HomeNeg = p.HomeNeg,
                LimitNNeg = p.LimitNNeg, LimitNPin = p.LimitNPin, LimitPNeg = p.LimitPNeg, LimitPPin = p.LimitPPin,
                StepNeg = p.StepNeg, StepPin = p.StepPin, EnablePin = p.EnablePin, EnableDelay = p.EnableDelay,
                EnablePinNeg = p.EnablePinNeg, CurrentHiLowPin = p.CurrentHiLowPin,
                CurrentHiLowPinNeg = p.CurrentHiLowPinNeg, HomeBackOff = p.HomeBackOff,
                RotaryRollover = p.RotaryRollover, RotaryAxis = false,
            };
        if (axis < 3 && p.SlaveAxis != 0)   // the master's motion settings go to its slave
            Axes[p.SlaveAxis] = Axes[p.SlaveAxis] with
            {
                SlaveAxis = 0, RotaryAxis = false,
                BacklashDist = p.BacklashDist, BacklashOn = p.BacklashOn, CompAccel = p.CompAccel, Enable = p.Enable,
                HomeNeg = p.HomeNeg, MaxAccel = p.MaxAccel, MaxVel = p.MaxVel, SoftLimitN = p.SoftLimitN,
                SoftLimitP = p.SoftLimitP, StepPer = p.StepPer,
            };
        if (Laser.Number != 0) Axes[5] = Axes[5] with { Enable = false };
    }

    /// <summary>SetEstopSetting: an out-of-range pin is stored as 0.</summary>
    public void SetEstop(int pin, bool neg) => Estop = new Pin(pin is < 0 or > MaxPin ? 0 : pin, neg);

    // Pin byte conventions (docs/SETTINGS.md section 0.2). +0x80 is modulo 256.
    static byte OutA(Pin p, bool gate = true) =>
        !gate || p.Number == 0 ? (byte)0 : (byte)(p.Number + ((!p.Neg ^ Flip.Contains(p.Number)) ? 0x80 : 0));
    static byte OutB(Pin p, bool gate = true, bool zeroPinIsZero = true) =>
        !gate || (zeroPinIsZero && p.Number == 0) ? (byte)0 : (byte)(p.Number + ((p.Neg ^ Flip.Contains(p.Number)) ? 0x80 : 0));
    static byte InP(Pin p, bool gate = true) =>
        !gate || p.Number == 0 ? (byte)0 : (byte)(p.Number + (p.Neg ? 0 : 0x80));
    static byte InN(Pin p, bool gate = true) =>
        !gate || p.Number == 0 ? (byte)0 : (byte)(p.Number + (p.Neg ? 0x80 : 0));

    /// <summary>The 0x0D settings block payload (392 bytes).</summary>
    public byte[] SettingsPayload()
    {
        var b = new byte[SettingsLength];
        var a = Axes;
        for (int k = 0; k < 6; k++)
        {
            b[2 * k] = OutA(new(a[k].StepPin, a[k].StepNeg), a[k].Enable);
            b[2 * k + 1] = OutA(new(a[k].DirPin, a[k].DirNeg), a[k].Enable);
        }
        var sp = Spindle;
        b[12] = OutA(sp.SpPin, sp.Mode == 2);
        b[13] = OutA(sp.SpDirPin, sp.Mode is 1 or 2);
        b[14] = OutA(ChargePump1);
        b[15] = OutA(ChargePump2);
        for (int k = 0; k < 6; k++) b[16 + k] = OutA(new(a[k].CurrentHiLowPin, a[k].CurrentHiLowPinNeg));   // not gated by Enable
        b[22] = InP(Estop);
        b[23] = (byte)IndexPin;
        for (int k = 0; k < 6; k++)
        {
            b[24 + 3 * k] = InP(new(a[k].LimitPPin, a[k].LimitPNeg), a[k].Enable);
            b[25 + 3 * k] = InP(new(a[k].LimitNPin, a[k].LimitNNeg), a[k].Enable);
            b[26 + 3 * k] = InN(new(a[k].HomePin, a[k].HomeNeg), a[k].Enable);
        }
        b[42] = OutA(sp.SpPin, sp.Mode == 1);
        var enc = Encoder;
        b[43] = (byte)enc.MpgPinA;
        b[44] = (byte)enc.MpgPinB;
        (int ea, int eb) = enc.EncoderReverseDirection ? (enc.EncoderPinB, enc.EncoderPinA) : (enc.EncoderPinA, enc.EncoderPinB);
        b[45] = (byte)ea; b[46] = (byte)eb;
        b[47] = (byte)StepRate;
        int slaves = 0;
        for (int m = 0; m < 3; m++)
            if (a[m].SlaveAxis is >= 3 and <= 5) slaves += (1 << (2 * m)) * (a[m].SlaveAxis - 2);
        b[48] = (byte)slaves;
        b[49] = OutA(sp.M3Pin, sp.EnableM3M4Output);
        b[50] = OutA(sp.M4Pin, sp.EnableM3M4Output);
        for (int k = 0; k < 6; k++) b[51 + k] = OutB(new(a[k].EnablePin, a[k].EnablePinNeg), a[k].Enable, zeroPinIsZero: false);
        b[57] = OutA(Thc.EnPin);
        b[58] = OutA(Thc.AntiDivePin);
        b[59] = OutA(Thc.AntiDownPin);
        b[60] = OutA(Laser);
        for (int k = 0; k < 10; k++) b[61 + k] = OutB(Outputs[k]);
        // 71..79: always 0
        b[80] = InN(Probe1);
        b[81] = InN(Probe2);
        b[82] = InN(Thc.OnPin);
        b[83] = InN(Thc.UpPin);
        b[84] = InN(Thc.DownPin);
        // 85: always 0
        int on = Math.Min((int)(Thc.OnTime * 781.0), 0x1E82);   // samples, big-endian
        b[86] = (byte)(on >> 8); b[87] = (byte)on;
        for (int k = 0; k < 6; k++)
        {
            int o = 88 + 36 * k;
            BitConverter.TryWriteBytes(b.AsSpan(o), a[k].MaxVel * 1.04);
            BitConverter.TryWriteBytes(b.AsSpan(o + 8), a[k].MaxAccel);
            BitConverter.TryWriteBytes(b.AsSpan(o + 16), a[k].StepPer);
            int backlash = a[k].BacklashOn ? (int)(a[k].BacklashDist * a[k].StepPer * 256.0) : 0;
            BitConverter.TryWriteBytes(b.AsSpan(o + 24), backlash);
            BitConverter.TryWriteBytes(b.AsSpan(o + 28), a[k].CompAccel);
        }
        BitConverter.TryWriteBytes(b.AsSpan(304), sp.SpAccel);
        BitConverter.TryWriteBytes(b.AsSpan(312), sp.SpStepPerRev);
        for (int k = 0; k < 12; k++) b[320 + k] = (byte)enc.Aux[k];
        b[332] = (byte)Debounce[0]; b[333] = (byte)Debounce[1]; b[334] = (byte)Debounce[2];
        for (int k = 0; k < 6; k++) b[335 + k] = (byte)a[k].EnableDelay;
        for (int k = 0; k < 6; k++) BitConverter.TryWriteBytes(b.AsSpan(341 + 8 * k), a[k].HomeBackOff);
        int rotary = 0;
        if (a[3].Enable && (a[3].RotaryAxis || TangentialCutter)) rotary |= 1;
        if (a[4].Enable && a[4].RotaryAxis) rotary |= 2;
        if (a[5].Enable && a[5].RotaryAxis) rotary |= 4;
        b[389] = (byte)rotary;
        b[390] = (byte)Debounce[3]; b[391] = (byte)Debounce[4];
        return b;
    }

    /// <summary>The 0x09 axis block payload: per axis SoftLimitP - pos, SoftLimitN - pos (LE doubles).</summary>
    public byte[] AxisBlockPayload()
    {
        var b = new byte[AxisBlockLength];
        for (int k = 0; k < 6; k++)
        {
            BitConverter.TryWriteBytes(b.AsSpan(16 * k), Axes[k].SoftLimitP - Positions[k]);
            BitConverter.TryWriteBytes(b.AsSpan(16 * k + 8), Axes[k].SoftLimitN - Positions[k]);
        }
        return b;
    }
}

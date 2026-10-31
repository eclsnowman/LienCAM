using System.Buffers.Binary;

namespace Uc100Net;

/// <summary>
/// Board state that travels in the status-poll request, the output and input
/// words, the spindle, and SetAxisPosition (work/decode-calls.md, decoded from
/// the 2190 decompile and checked against the oracle "calls" run).
/// </summary>
public sealed partial class Board
{
    // ---- the status-poll request (FUN_180027740) ------------------------------
    //
    // 17 bytes: three LE u16 output words, flags A, flags B, the motion-progress
    // byte, four BE u16 analog outputs. Uc100Net models the output words and
    // flags A; flags B (THC), byte 8 and the analog outputs stay 0.

    /// <summary>Logical outputs: bit n = output n + 1 (the DLL's DAT_1800b80b0).</summary>
    ulong outputs;
    bool outputsWritten;
    bool limitOverridePulse;

    /// <summary>Bits of the logical word the AXBB-E maps to pins (FUN_180027f20).</summary>
    const ulong MappedOutputs =
        (1UL << 1) | (1UL << 2) | (1UL << 3) | (1UL << 4) | (1UL << 9) | (1UL << 10) | (1UL << 14) | (1UL << 15) |
        (1UL << 16) | (1UL << 17) | (1UL << 18) | (1UL << 19) | (1UL << 20) | (1UL << 21) |
        (1UL << 24) | (1UL << 25) | (1UL << 26) | (1UL << 28) | (1UL << 29) | (1UL << 30) | (1UL << 31) |
        (1UL << 32) | (1UL << 33) | (1UL << 34) | (1UL << 37) | (1UL << 41) | (1UL << 42) | (1UL << 46) | (1UL << 47);

    /// <summary>
    /// Outputs 2, 26, 27, 29, 30, 31, 32 and 47 are active-high on the wire,
    /// the rest active-low: the same set the settings block inverts (docs/SETTINGS.md).
    /// </summary>
    const ulong ActiveHighOutputs = 0x4000F6000002;

    /// <summary>What Open puts in the output words before the first output call (all outputs off; L1305-1308).</summary>
    static readonly byte[] OpenOutputWords = [0xfd, 0xff, 0xff, 0x09, 0xff, 0xbf];

    /// <summary>SetSoftLimit: poll flag A bit 1.</summary>
    public bool SoftLimitEnable { get; set; }

    /// <summary>!SetOffline: poll flag A bit 4 (true after Open). Offline does not stop streaming.</summary>
    public bool Online { get; set; } = true;

    /// <summary>SetEstopState: poll flag A bit 3, the host's e-stop request, until the next Stop.</summary>
    public bool EstopRequested { get; private set; }

    /// <summary>
    /// SetEstopState (L2766-2830): the e-stop request goes into the poll (the
    /// board e-stops on it: INFERRED from the real capture), then, as the
    /// DLL's RT loop does, a poll and a Stop that flushes everything. The
    /// request stays set until <see cref="Stop"/>.
    /// </summary>
    public bool RequestEstop()
    {
        lock (api)
        {
            EstopRequested = true;
            softLimitLatched = false;   // the only thing that unlatches the soft-limit stop (L2772)
            PollOnce();
            return StopLocked(clearEstopRequest: false);
        }
    }

    /// <summary>LimitOverRide: poll flag A bit 0 for one poll.</summary>
    public void LimitOverride() { lock (api) limitOverridePulse = true; }

    /// <summary>SetOutputBit / ClearOutputBit (Num 1..64). Outputs the AXBB-E does not map are kept but never reach a pin.</summary>
    public void SetOutput(int num, bool on)
    {
        if (num is < 1 or > 64) throw new ArgumentOutOfRangeException(nameof(num));
        lock (api)
        {
            ulong bit = 1UL << (num - 1);
            outputs = on ? outputs | bit : outputs & ~bit;
            outputsWritten = true;
        }
    }

    /// <summary>The poll request for the next tick; a LimitOverRide pulse is spent by it.</summary>
    byte[] TakePollRequest()
    {
        var p = new byte[17];
        if (outputsWritten)
        {
            ulong wire = (~outputs ^ ActiveHighOutputs) & MappedOutputs;
            for (int w = 0; w < 3; w++) BinaryPrimitives.WriteUInt16LittleEndian(p.AsSpan(2 * w), (ushort)(wire >> (16 * w)));
        }
        else OpenOutputWords.CopyTo(p, 0);
        p[6] = (byte)((limitOverridePulse ? 0x01 : 0) | (SoftLimitEnable ? 0x02 : 0) | (EstopRequested ? 0x08 : 0) | (Online ? 0x10 : 0));
        limitOverridePulse = false;
        return p;
    }

    /// <summary>
    /// GetOutput: the outputs as the board reports them (reply bytes 47..52,
    /// three BE words, FUN_180028b60); unmapped outputs read 1. Null before
    /// the first status reply.
    /// </summary>
    public long? OutputReadback
    {
        get
        {
            var plain = LastStatus?.Plain;
            if (plain is null) return null;
            ulong bits = 0;
            for (int w = 0; w < 3; w++) bits |= (ulong)BinaryPrimitives.ReadUInt16BigEndian(plain.AsSpan(47 + 2 * w)) << (16 * w);
            return (long)~((bits & MappedOutputs) ^ ActiveHighOutputs);
        }
    }

    /// <summary>
    /// GetInput: the 11 AXBB-E inputs, bit n = input pin n + 1, from reply
    /// bytes 35..38 (FUN_1800339f0). Null before the first status reply.
    /// </summary>
    public long? Inputs
    {
        get
        {
            var plain = LastStatus?.Plain;
            if (plain is null) return null;
            int a = BinaryPrimitives.ReadUInt16BigEndian(plain.AsSpan(35)), b = BinaryPrimitives.ReadUInt16BigEndian(plain.AsSpan(37));
            int Bit(int word, int n) => (word >> n) & 1;
            return Bit(a, 12) | Bit(a, 2) << 1 | Bit(a, 8) << 2 | Bit(a, 4) << 3 | Bit(a, 5) << 4 | Bit(a, 0) << 5
                 | Bit(b, 0) << 6 | Bit(a, 1) << 7 | Bit(b, 12) << 8 | Bit(b, 14) << 9 | Bit(b, 13) << 10;
        }
    }

    // ---- spindle ------------------------------------------------------------------

    /// <summary>SetSpindleSpeed, rpm (the DLL starts at 10).</summary>
    public double SpindleSpeed { get; private set; } = 10;

    /// <summary>SetSRO, percent.</summary>
    public double SpindleOverride { get; private set; } = 100;

    /// <summary>SetSpindleSpeed: clamped to MinVel..MaxVel as the DLL does, then the 0x0A frame.</summary>
    public bool SetSpindleSpeed(double rpm)
    {
        var sp = Settings.Spindle;
        lock (api)
        {
            SpindleSpeed = Math.Clamp(rpm, Math.Min(sp.MinVel, sp.MaxVel), Math.Max(sp.MinVel, sp.MaxVel));
            return transport.Exchange(Command.Spindle, SpindleFrames.Speed(sp, SpindleSpeed, SpindleOverride), Transport.IsAck) is not null;
        }
    }

    /// <summary>SetSRO: 0..300 %; the 0x0A frame goes out only when the value changes, as in the DLL.</summary>
    public bool SetSpindleOverride(double percent)
    {
        percent = Math.Clamp(percent, 0, 300);
        lock (api)
        {
            if (percent == SpindleOverride) return true;
            SpindleOverride = percent;
            return transport.Exchange(Command.Spindle, SpindleFrames.Speed(Settings.Spindle, SpindleSpeed, SpindleOverride), Transport.IsAck) is not null;
        }
    }

    /// <summary>SpindleOn: 0x0B, CW unless <paramref name="ccw"/>.</summary>
    public bool SpindleOn(bool ccw)
    {
        lock (api) return transport.Exchange(Command.SpindleOn, [(byte)(ccw ? 1 : 0)], Transport.IsAck) is not null;
    }

    /// <summary>SpindleOff: 0x0C.</summary>
    public bool SpindleOff()
    {
        lock (api) return transport.Exchange(Command.SpindleOff, [], Transport.IsAck) is not null;
    }

    /// <summary>After SetSpindleSetting changed <see cref="MachineSettings.Spindle"/>: 0x0A, 0x0D, 0x1A, in the DLL's order.</summary>
    public bool SendSpindleSettings()
    {
        lock (api)
            return transport.Exchange(Command.Spindle, SpindleFrames.Speed(Settings.Spindle, SpindleSpeed, SpindleOverride), Transport.IsAck) is not null
                && transport.Exchange(Command.Settings, Settings.SettingsPayload(), Transport.IsAck) is not null
                && transport.Exchange(Command.SpindleEncoder, SpindleFrames.Pid(Settings.Spindle), Transport.IsAck) is not null;
    }

    /// <summary>The 0x0D settings block alone (SetEstopSetting, SetProbeSetting).</summary>
    public bool SendSettingsBlock()
    {
        lock (api) return transport.Exchange(Command.Settings, Settings.SettingsPayload(), Transport.IsAck) is not null;
    }

    // ---- SetAxisPosition ----------------------------------------------------------

    /// <summary>
    /// SetAxisPosition's triplet: 0x01 (the board zeroes its step counters),
    /// 0x09 with the soft limits relative to the new positions, 0x17 (THC
    /// window minus the Z offset; THC defaults 0..1, feed 1). The attached
    /// stream restarts at 0: records are relative to the new zero, and the
    /// caller keeps <paramref name="positions"/> as the work offset.
    /// </summary>
    public bool SetAxisPosition(double[] positions)
    {
        if (positions.Length != 6) throw new ArgumentException("six axes X..C");
        lock (api)
        {
            positions.CopyTo(Settings.Positions, 0);
            var thc = new byte[24];
            BitConverter.TryWriteBytes(thc.AsSpan(0), 1.0 - positions[2]);
            BitConverter.TryWriteBytes(thc.AsSpan(8), 0.0 - positions[2]);
            BitConverter.TryWriteBytes(thc.AsSpan(16), 1.0);
            bool ok = transport.Exchange(Command.AxisPositionBegin, Defaults.AxisPositionBegin, Transport.IsAck) is not null
                && transport.Exchange(Command.AxisBlock, Settings.AxisBlockPayload(), Transport.IsAck) is not null
                && transport.Exchange(Command.AxisPositionEnd, thc, Transport.IsAck) is not null;
            stream?.Reset(new double[6]);
            Array.Fill(positionRing, new double[6]);
            lastPositionSent = new double[6];
            return ok;
        }
    }
}

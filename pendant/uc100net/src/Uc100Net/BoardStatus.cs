using System.Buffers.Binary;

namespace Uc100Net;

/// <summary>
/// The board's 153-byte reply to the 0x0E status poll. The layout is from
/// the 2190 poll parser (FUN_18002f5b0) and GetStatus, and the flag bits are
/// checked against the real AXBB-E (docs/ORACLE.md, "Board state flags").
/// Only the fields with a confirmed meaning are exposed; the rest stays in
/// <see cref="Plain"/>.
/// </summary>
public sealed class BoardStatus
{
    public const int Length = 153;

    /// <summary>The longer reply that carries a probe hit's latched counters (docs/CALLS.md 4).</summary>
    public const int ProbeLength = 177;

    /// <summary>The decoded frame.</summary>
    public byte[] Plain { get; }

    /// <summary>Axis positions X Y Z A B C in steps (bytes 6..29, int32 BE).</summary>
    public int[] PositionSteps { get; }

    /// <summary>
    /// Records in the board buffer (bytes 30..31). An idle board reports 1. The
    /// DLL's CurrentID is ring_head - this value.
    /// </summary>
    public ushort BufferFill { get; }

    /// <summary>State bits (byte 32).</summary>
    public byte Flags { get; }

    /// <summary>Board clock in 10 us units (bytes 33..34, wraps at 65536).</summary>
    public ushort Clock { get; }

    /// <summary>Per-axis "moving" bits (byte 53), bit n = axis n.</summary>
    public byte MovingAxes { get; }

    public bool Jog => (Flags & 0x01) != 0;
    public bool Estop => (Flags & 0x02) != 0;
    public bool Busy => (Flags & 0x04) != 0;
    public bool Ready => (Flags & 0x08) != 0;
    public bool Homing => (Flags & 0x10) != 0;
    /// <summary>The board's own soft-limit trip (bit 5, adbc8 L28030; docs/CALLS.md 5.1).</summary>
    public bool BoardSoftLimit => (Flags & 0x20) != 0;
    public bool HardLimit => (Flags & 0x40) != 0;

    /// <summary>Byte 53 bit 6: a probe move is running (the DLL ends the probe with Stop when it clears).</summary>
    public bool ProbeRunning => (MovingAxes & 0x40) != 0;

    /// <summary>Byte 87 bit 2: the probe touched; <see cref="ProbeSteps"/> holds where.</summary>
    public bool ProbeHit => (Plain[87] & 0x04) != 0;

    /// <summary>The six step counters latched at contact (bytes 151..174, BE int32), or null in a 153-byte reply.</summary>
    public int[]? ProbeSteps => Plain.Length >= ProbeLength
        ? [.. Enumerable.Range(0, 6).Select(ax => BinaryPrimitives.ReadInt32BigEndian(Plain.AsSpan(151 + 4 * ax)))]
        : null;

    BoardStatus(byte[] plain)
    {
        Plain = plain;
        PositionSteps = new int[6];
        for (int ax = 0; ax < 6; ax++)
            PositionSteps[ax] = BinaryPrimitives.ReadInt32BigEndian(plain.AsSpan(6 + 4 * ax));
        BufferFill = BinaryPrimitives.ReadUInt16BigEndian(plain.AsSpan(30));
        Flags = plain[32];
        Clock = BinaryPrimitives.ReadUInt16BigEndian(plain.AsSpan(33));
        MovingAxes = plain[53];
    }

    /// <summary>Parse a decoded status reply; null if it isn't one, or fails validation.</summary>
    public static BoardStatus? FromPlain(byte[] plain)
    {
        if (plain.Length is not (Length or ProbeLength) || plain[3] != (byte)Command.Status
            || !FrameCodec.IsValid(plain, fromBoard: true))
            return null;
        return new BoardStatus(plain);
    }
}

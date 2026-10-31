namespace Uc100Net;

/// <summary>
/// The 48-byte records of a motion frame (docs/ORACLE.md), six LE doubles.
/// A position record is absolute X Y Z A B C. A command record has FLT_MIN
/// (or FLT_MAX) in slot 0 and a type byte at byte 32 (slot 4); what the DLL
/// writes there comes from its sample generator FUN_18000d830.
/// </summary>
public static class MotionRecord
{
    public const int Length = 48;

    /// <summary>Command type 2: the THC anti-dive velocity threshold, in slot 5.</summary>
    public const byte AntiDiveType = 2;

    static readonly double FltMin = BitConverter.ToDouble([0, 0, 0, 0, 0, 0, 0x10, 0x38]);
    static readonly double FltMax = BitConverter.ToDouble([0, 0, 0, 0xe0, 0xff, 0xff, 0xef, 0x47]);

    public static byte[] Position(ReadOnlySpan<double> xyzabc)
    {
        if (xyzabc.Length != 6) throw new ArgumentException("six axes X..C", nameof(xyzabc));
        var r = new byte[Length];
        for (int i = 0; i < 6; i++) BitConverter.TryWriteBytes(r.AsSpan(8 * i), xyzabc[i]);
        return r;
    }

    /// <summary>
    /// The record the DLL sends whenever the executing move's feed changes:
    /// velocity = feed x FRO% x THCAntiDiveVel% / 10000 (units/s), below which
    /// the board's THC anti-dive engages. MEASURED at FRO 100% and the DLL's
    /// default THCAntiDiveVel 50% (so feed / 2) on every oracle program.
    /// </summary>
    public static byte[] AntiDive(double velocity)
    {
        var r = new byte[Length];
        BitConverter.TryWriteBytes(r, FltMin);
        r[32] = AntiDiveType;
        BitConverter.TryWriteBytes(r.AsSpan(40), velocity);
        return r;
    }

    /// <summary>Command type 3: one sample with no motion (dwell, dummy move, a lone zero-length line).</summary>
    public const byte RestType = 3;

    /// <summary>
    /// A sample in which nothing moves: the DLL sends one per 1.28 ms of a
    /// dwell, one for a dummy move, and one for a zero-length line it keeps.
    /// All other slots are 0. MEASURED (oracle "planes").
    /// </summary>
    public static byte[] Rest()
    {
        var r = new byte[Length];
        BitConverter.TryWriteBytes(r, FltMin);
        r[32] = RestType;
        return r;
    }

    /// <summary>
    /// Two command records that mean the same: bytes 33..39 left out. DLL 2190
    /// leaves stale data there (MEASURED, oracle "inferred": the upper half of
    /// an old B-axis sample once B has moved); the board reads the type byte
    /// and slot 5. Uc100Net sends zeros.
    /// </summary>
    public static bool SameCommand(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b) =>
        a.Length == Length && b.Length == Length && a[..33].SequenceEqual(b[..33]) && a[40..].SequenceEqual(b[40..]);

    public static bool IsCommand(ReadOnlySpan<byte> record)
    {
        double slot0 = BitConverter.ToDouble(record);
        return slot0 == FltMin || slot0 == FltMax;
    }
}

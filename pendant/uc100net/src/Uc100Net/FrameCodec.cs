namespace Uc100Net;

/// <summary>
/// UC100 Ethernet frame obfuscation, as validated on real AXBB-E traffic
/// (docs/WIRE-PROTOCOL.md section 2): every captured frame decodes, and every
/// host frame re-encodes byte for byte.
/// </summary>
/// <remarks>
/// Plaintext: '#' '-' '>' CMD nonceHi nonceLo payload... csumA csumB.
/// The nonce (bytes 4..5) travels in clear and seeds a 32-bit LFSR at
/// 0x20140000 + nonce. After two warm-up steps, each further step yields a
/// keystream byte (the sum of the state's four bytes) that is ADDED to
/// bytes 0..3 and 6..n-1. The checksum is the 16-bit sum of bytes 0..n-3:
/// big-endian from the host, little-endian from the board.
/// </remarks>
public static class FrameCodec
{
    public const uint SeedBase = 0x20140000;
    public const int WarmupSteps = 2;
    public const int HeaderLength = 6;
    public const int ChecksumLength = 2;

    public static uint Step(uint s)
    {
        uint feedback = (s ^ (s >> 2) ^ (s >> 4) ^ (s >> 6) ^ (s >> 31)) & 1;
        return (feedback << 31) | (s >> 1);
    }

    static byte KeyByte(uint s) =>
        (byte)((s & 0xFF) + ((s >> 8) & 0xFF) + ((s >> 16) & 0xFF) + (s >> 24));

    static uint Seed(ReadOnlySpan<byte> frame)
    {
        uint s = SeedBase + (uint)(frame[4] << 8 | frame[5]);
        for (int i = 0; i < WarmupSteps; i++) s = Step(s);
        return s;
    }

    /// <summary>Obfuscate a plaintext frame, writing its checksum first.</summary>
    public static byte[] Encode(ReadOnlySpan<byte> plain, bool fromBoard = false)
    {
        if (plain.Length < HeaderLength + ChecksumLength)
            throw new ArgumentException("frame shorter than header + checksum", nameof(plain));
        byte[] p = plain.ToArray();
        ushort sum = Checksum(p);
        if (fromBoard) { p[^2] = (byte)sum; p[^1] = (byte)(sum >> 8); }
        else { p[^2] = (byte)(sum >> 8); p[^1] = (byte)sum; }
        uint s = Seed(p);
        for (int i = 0; i < p.Length; i++)
        {
            if (i == 4 || i == 5) continue;
            s = Step(s);
            p[i] = (byte)(p[i] + KeyByte(s));
        }
        return p;
    }

    /// <summary>Recover the plaintext of an obfuscated frame (no validation).</summary>
    public static byte[] Decode(ReadOnlySpan<byte> raw)
    {
        byte[] p = raw.ToArray();
        if (p.Length < HeaderLength) return p;
        uint s = Seed(p);
        for (int i = 0; i < p.Length; i++)
        {
            if (i == 4 || i == 5) continue;
            s = Step(s);
            p[i] = (byte)(p[i] - KeyByte(s));
        }
        return p;
    }

    public static ushort Checksum(ReadOnlySpan<byte> plain)
    {
        int sum = 0;
        for (int i = 0; i < plain.Length - ChecksumLength; i++) sum += plain[i];
        return (ushort)sum;
    }

    public static bool HasMagic(ReadOnlySpan<byte> plain) =>
        plain.Length >= 4 && plain[0] == (byte)'#' && plain[1] == (byte)'-' && plain[2] == (byte)'>';

    /// <summary>Magic and checksum both correct for a decoded frame.</summary>
    public static bool IsValid(ReadOnlySpan<byte> plain, bool fromBoard)
    {
        if (plain.Length < HeaderLength + ChecksumLength || !HasMagic(plain)) return false;
        ushort stored = fromBoard
            ? (ushort)(plain[^1] << 8 | plain[^2])
            : (ushort)(plain[^2] << 8 | plain[^1]);
        return Checksum(plain) == stored;
    }

    public static ushort Nonce(ReadOnlySpan<byte> frame) => (ushort)(frame[4] << 8 | frame[5]);

    /// <summary>Build and obfuscate a host frame: header, payload, checksum.</summary>
    public static byte[] BuildHostFrame(Command cmd, ushort nonce, ReadOnlySpan<byte> payload)
    {
        var plain = new byte[HeaderLength + payload.Length + ChecksumLength];
        plain[0] = (byte)'#'; plain[1] = (byte)'-'; plain[2] = (byte)'>';
        plain[3] = (byte)cmd;
        plain[4] = (byte)(nonce >> 8); plain[5] = (byte)nonce;
        payload.CopyTo(plain.AsSpan(HeaderLength));
        return Encode(plain);
    }
}

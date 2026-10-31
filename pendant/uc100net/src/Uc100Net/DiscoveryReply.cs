using System.Globalization;
using System.Net;
using System.Text;

namespace Uc100Net;

/// <summary>
/// A board's answer to the 0xC0 discovery probe (61 bytes). Offsets are
/// from the 2190 ListDevices code, checked against the real AXBB-E reply
/// (docs/WIRE-PROTOCOL.md section 4).
/// </summary>
public sealed record DiscoveryReply(
    byte[] Mac,
    IPAddress Address,
    byte TypeByte1D,
    byte TypeByte1E,
    int? DeviceType,
    string Serial,
    int SerialNumber,
    string Firmware,
    string Field1000)
{
    public const int Length = 61;

    /// <summary>Board-type bytes 0x1d/0x1e -> UC100 device type. Only AXBB is confirmed.</summary>
    public static int? DeviceTypeOf(byte b1d, byte b1e) => (b1d, b1e) switch
    {
        (0x00, 0x03) => 19,   // AXBB
        _ => null,
    };

    public string MacText => string.Join(":", Mac.Select(b => b.ToString("x2")));

    /// <summary>Decode and validate; null if this isn't a reply to the probe with this nonce.</summary>
    public static DiscoveryReply? Parse(ReadOnlySpan<byte> raw, ushort nonce)
    {
        if (raw.Length < Length) return null;
        byte[] p = FrameCodec.Decode(raw);
        if (!FrameCodec.IsValid(p, fromBoard: true) || p[3] != (byte)Command.Discovery
            || FrameCodec.Nonce(p) != nonce)
            return null;
        string serial = Text(p, 0x22, 0x28);
        int.TryParse(serial, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out int serialNumber);
        return new DiscoveryReply(
            Mac: p[0x06..0x0C],
            Address: new IPAddress(p[0x0C..0x10]),
            TypeByte1D: p[0x1D],
            TypeByte1E: p[0x1E],
            DeviceType: DeviceTypeOf(p[0x1D], p[0x1E]),
            Serial: serial,
            // The DLL reads the serial field as hex: "0BEEF0" -> 782064 (oracle DeviceInfo).
            SerialNumber: serialNumber,
            Firmware: Text(p, 0x29, 0x2D),
            Field1000: Text(p, 0x19, 0x1D));
    }

    static string Text(byte[] p, int from, int to)
    {
        int end = Array.IndexOf(p, (byte)0, from, to - from);
        return Encoding.ASCII.GetString(p, from, (end < 0 ? to : end) - from);
    }
}

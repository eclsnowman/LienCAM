namespace Uc100Net;

/// <summary>
/// Frame command codes (byte 3), mapped from decoded real-board traffic and
/// the oracle (docs/WIRE-PROTOCOL.md section 3, docs/ORACLE.md).
/// </summary>
public enum Command : byte
{
    /// <summary>First of the SetAxisPosition triplet (0x01, 0x09, 0x17).</summary>
    AxisPositionBegin = 0x01,
    /// <summary>Motion records: byte 6 = count, then 48-byte records (six LE doubles).</summary>
    Motion = 0x02,
    /// <summary>Jog: axis byte + LE double signed speed in units/s.</summary>
    Jog = 0x04,
    /// <summary>Jog stop: axis byte.</summary>
    JogStop = 0x05,
    /// <summary>Stop; the board replies with an 11-byte 0x06 frame carrying its state.</summary>
    Stop = 0x06,
    /// <summary>Home: axis byte + LE doubles fast speed, slow speed.</summary>
    Home = 0x08,
    /// <summary>104-byte axis block (12 doubles); follows SetAxisSetting and SetAxisPosition.</summary>
    AxisBlock = 0x09,
    /// <summary>Spindle PWM and speed: u16 on-count, u16 period (400 kHz counts), LE double rev/s (work/decode-calls.md 2).</summary>
    Spindle = 0x0A,
    /// <summary>SpindleOn: one byte, 0 = CW, 1 = CCW.</summary>
    SpindleOn = 0x0B,
    /// <summary>SpindleOff (no payload).</summary>
    SpindleOff = 0x0C,
    /// <summary>400-byte settings block A, re-sent by most Set*Setting calls.</summary>
    Settings = 0x0D,
    /// <summary>Status poll (25 bytes) / status reply (153 bytes).</summary>
    Status = 0x0E,
    /// <summary>RESET burst (doubles 10.0, 10.0, 0.01; not yet decoded).</summary>
    Cmd15 = 0x15,
    /// <summary>Parameterless; RESET burst.</summary>
    Cmd16 = 0x16,
    /// <summary>Probe start: one byte, 1 &lt;&lt; axis.</summary>
    ProbeStart = 0x0F,
    /// <summary>Third of the SetAxisPosition triplet: THC max - Z offset, THC min - Z offset, THC feed (3 LE doubles).</summary>
    AxisPositionEnd = 0x17,
    /// <summary>Encoder / spindle / spindle-PID settings (61 bytes).</summary>
    SpindleEncoder = 0x1A,
    /// <summary>Board acknowledgement (the first settings block after power-up).</summary>
    AckFirst = 0xAA,
    /// <summary>Board acknowledgement.</summary>
    Ack = 0xAB,
    /// <summary>Firmware-update traffic on port 4910. Uc100Net never sends it.</summary>
    Bootloader = 0xAC,
    /// <summary>Discovery: 8-byte broadcast probe, 61-byte reply.</summary>
    Discovery = 0xC0,
}

using Xunit.Abstractions;

namespace Uc100Net.Tests;

public class ParsingTests(ITestOutputHelper output)
{
    [Fact]
    public void Discovery_reply_from_the_real_board()
    {
        var vectors = Vectors.Load(output);
        if (vectors is null) return;
        var replies = vectors.Where(v => v.FromBoard && v.Plain[3] == (byte)Command.Discovery).ToList();
        Assert.Equal(4, replies.Count);
        foreach (var v in replies)
        {
            var r = DiscoveryReply.Parse(v.Raw, FrameCodec.Nonce(v.Raw));
            Assert.NotNull(r);
            Assert.Equal("1005", r.Firmware);
            Assert.Equal(19, r.DeviceType);
            Assert.Equal("10.10.10.11", r.Address.ToString());
            Assert.Equal(0xCD095A, r.SerialNumber);
        }
    }

    [Fact]
    public void Discovery_reply_rejects_wrong_nonce()
    {
        var vectors = Vectors.Load(output);
        if (vectors is null) return;
        var v = vectors.First(v => v.FromBoard && v.Plain[3] == (byte)Command.Discovery);
        Assert.Null(DiscoveryReply.Parse(v.Raw, (ushort)(FrameCodec.Nonce(v.Raw) + 1)));
    }

    /// <summary>
    /// Flag patterns of the real board in uccnc.pcapng (docs/ORACLE.md): idle
    /// 0x08 before t=10, e-stop 0x0a at t=11-20, homing 0x14 at t=28-32, jog
    /// 0x05 at t=42-45.
    /// </summary>
    [Theory]
    [InlineData(5.0, false, false, false, true)]
    [InlineData(15.0, false, true, false, true)]   // e-stop reads 0x0a: ready stays set
    [InlineData(30.0, false, false, true, false)]
    [InlineData(43.0, true, false, false, false)]
    public void Status_flags_on_the_real_board(double t, bool jog, bool estop, bool homing, bool ready)
    {
        var vectors = Vectors.Load(output);
        if (vectors is null) return;
        var v = vectors.First(v => v.Cap == "uccnc" && v.FromBoard && v.Plain[3] == (byte)Command.Status && v.T >= t);
        var s = BoardStatus.FromPlain(v.Plain);
        Assert.NotNull(s);
        Assert.Equal((jog, estop, homing, ready), (s.Jog, s.Estop, s.Homing, s.Ready));
        Assert.Equal(1, s.BufferFill);
    }

    [Fact]
    public void Status_rejects_other_frames()
    {
        byte[] ack = FrameCodec.Decode(FrameCodec.Encode(
            [(byte)'#', (byte)'-', (byte)'>', (byte)Command.Ack, 0, 1, 0, 0], fromBoard: true));
        Assert.Null(BoardStatus.FromPlain(ack));
    }
}

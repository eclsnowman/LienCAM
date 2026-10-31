using System.Text.Json;
using Xunit.Abstractions;

namespace Uc100Net.Tests;

public class FrameCodecTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(0x0000)]
    [InlineData(0x0001)]
    [InlineData(0x4823)]
    [InlineData(0x7FFE)]
    public void Host_frame_round_trips(int nonce)
    {
        byte[] raw = FrameCodec.BuildHostFrame(Command.Status, (ushort)nonce, new byte[17]);
        byte[] plain = FrameCodec.Decode(raw);
        Assert.True(FrameCodec.IsValid(plain, fromBoard: false));
        Assert.Equal((byte)Command.Status, plain[3]);
        Assert.Equal((ushort)nonce, FrameCodec.Nonce(plain));
        Assert.Equal(raw, FrameCodec.Encode(plain));
    }

    [Fact]
    public void Board_checksum_is_little_endian()
    {
        byte[] plain = [(byte)'#', (byte)'-', (byte)'>', (byte)Command.Ack, 0x12, 0x34, 0, 0];
        byte[] decoded = FrameCodec.Decode(FrameCodec.Encode(plain, fromBoard: true));
        Assert.True(FrameCodec.IsValid(decoded, fromBoard: true));
        Assert.False(FrameCodec.IsValid(decoded, fromBoard: false));
    }

    [Fact]
    public void Nonce_bytes_travel_in_clear()
    {
        byte[] raw = FrameCodec.BuildHostFrame(Command.Stop, 0x1805, [0x2A]);
        Assert.Equal(0x18, raw[4]);
        Assert.Equal(0x05, raw[5]);
    }

    /// <summary>
    /// Every frame of the four real AXBB-E captures: decode matches the Python
    /// reference, validates, and host frames re-encode byte for byte. Needs
    /// work/vectors/frames.jsonl (tools/export_vectors.py); skipped without it.
    /// </summary>
    [Fact]
    public void Real_board_frames()
    {
        var vectors = Vectors.Load(output);
        if (vectors is null) return;
        int host = 0, board = 0;
        foreach (var v in vectors)
        {
            byte[] plain = FrameCodec.Decode(v.Raw);
            Assert.Equal(v.Plain, plain);
            Assert.True(FrameCodec.IsValid(plain, v.FromBoard), $"{v.Cap} t={v.T} invalid");
            if (v.FromBoard) board++;
            else { Assert.Equal(v.Raw, FrameCodec.Encode(plain)); host++; }
        }
        output.WriteLine($"validated {host} host and {board} board frames");
        Assert.Equal(4212, host);
        Assert.Equal(4216, board);
    }
}

public sealed record Vector(string Cap, double T, bool FromBoard, byte[] Raw, byte[] Plain);

public static class Vectors
{
    public static string RepoRoot
    {
        get
        {
            var d = new DirectoryInfo(AppContext.BaseDirectory);
            while (d is not null && !File.Exists(Path.Combine(d.FullName, "src", "Uc100Net", "Uc100Net.csproj"))) d = d.Parent;
            return d?.FullName ?? throw new InvalidOperationException("repo root not found");
        }
    }

    public static List<Vector>? Load(ITestOutputHelper output)
    {
        string path = Path.Combine(RepoRoot, "work", "vectors", "frames.jsonl");
        if (!File.Exists(path))
        {
            output.WriteLine($"SKIPPED: {path} not present (run tools/export_vectors.py)");
            return null;
        }
        var list = new List<Vector>();
        foreach (string line in File.ReadLines(path))
        {
            using var doc = JsonDocument.Parse(line);
            var r = doc.RootElement;
            list.Add(new Vector(r.GetProperty("cap").GetString()!, r.GetProperty("t").GetDouble(),
                r.GetProperty("from_board").GetBoolean(),
                Convert.FromHexString(r.GetProperty("raw").GetString()!),
                Convert.FromHexString(r.GetProperty("plain").GetString()!)));
        }
        return list;
    }
}

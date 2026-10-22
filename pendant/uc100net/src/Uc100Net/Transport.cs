using System.Net;
using System.Net.Sockets;

namespace Uc100Net;

/// <summary>
/// One UDP socket to one board: request/reply exchanges with the DLL's
/// conventions (FUN_180003180 / per-command senders in 2190).
/// </summary>
/// <remarks>
/// - Local port 4913, falling back to 4914..4922; the peer is board:4912.
/// - Each request has a fresh nonce: rand() % 0xffff in the DLL, and MSVC
///   rand() tops out at 32767, so 0..32766 here.
/// - A reply counts only if it has the magic, the expected command and the
///   echoed nonce. The DLL waits 10 ms (select timeout 10000 us) and does not
///   retransmit.
/// Not thread-safe by itself: <see cref="Board"/> serialises all exchanges
/// under one lock, as the bridge does ("one owner thread for the board").
/// </remarks>
public sealed class Transport : IDisposable
{
    public const int BoardPort = 4912;
    public const int FirstLocalPort = 4913;
    public const int LastLocalPort = 4922;

    readonly Socket socket;
    readonly IPEndPoint board;
    readonly byte[] buffer = new byte[2048];

    public int LocalPort { get; }
    public long Sent { get; private set; }
    public long Timeouts { get; private set; }
    public long Rejected { get; private set; }

    public Transport(IPAddress localAddress, IPAddress boardAddress)
    {
        board = new IPEndPoint(boardAddress, BoardPort);
        socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        for (int port = FirstLocalPort; ; port++)
        {
            try { socket.Bind(new IPEndPoint(localAddress, port)); LocalPort = port; break; }
            catch (SocketException) when (port < LastLocalPort) { }
        }
    }

    public static ushort NewNonce() => (ushort)Random.Shared.Next(0, 0x7FFF);

    /// <summary>
    /// Send one command and wait for its reply. Returns the decoded reply, or
    /// null on timeout.
    /// </summary>
    public byte[]? Exchange(Command cmd, ReadOnlySpan<byte> payload, Func<byte[], bool> isReply, int timeoutMs = 10)
    {
        ushort nonce = NewNonce();
        byte[] frame = FrameCodec.BuildHostFrame(cmd, nonce, payload);
        // Drop stale replies from an earlier, timed-out exchange.
        while (socket.Available > 0) socket.Receive(buffer);
        socket.SendTo(frame, board);
        Sent++;
        long deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            int left = (int)(deadline - Environment.TickCount64);
            if (left <= 0 || !socket.Poll(left * 1000, SelectMode.SelectRead)) { Timeouts++; return null; }
            int n = socket.Receive(buffer);
            byte[] plain = FrameCodec.Decode(buffer.AsSpan(0, n));
            if (FrameCodec.HasMagic(plain) && n >= FrameCodec.HeaderLength && FrameCodec.Nonce(plain) == nonce && isReply(plain))
                return plain;
            Rejected++;
        }
    }

    /// <summary>A plain acknowledgement: 0xAB, or 0xAA (the DLL accepts both).</summary>
    public static bool IsAck(byte[] plain) => plain[3] is (byte)Command.Ack or (byte)Command.AckFirst;

    public void Dispose() => socket.Dispose();
}

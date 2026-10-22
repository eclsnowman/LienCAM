using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace Uc100Net;

/// <summary>
/// Broadcast discovery (ListDevices). Unlike the DLL, which probes every
/// adapter, this probes only the one interface it is given.
/// </summary>
public static class Discovery
{
    public const int ProbePort = 4910;
    public const int LocalPort = 4950;

    /// <summary>The 8-byte probe: '#->' 0xC0 nonce checksum.</summary>
    public static byte[] Probe(ushort nonce) => FrameCodec.BuildHostFrame(Command.Discovery, nonce, ReadOnlySpan<byte>.Empty);

    public static List<DiscoveryReply> Scan(IPAddress localAddress, IPAddress broadcast, TimeSpan timeout)
    {
        using var s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        s.EnableBroadcast = true;
        // The AXBB-E answers to 255.255.255.255:4950 (every real-board capture).
        // Windows hands that to a socket bound to the local address; Linux only
        // to one bound to the wildcard address, so there the socket binds the
        // wildcard and replies are kept only from the local subnet (as the DLL
        // also checks).
        bool wildcard = !OperatingSystem.IsWindows();
        s.Bind(new IPEndPoint(wildcard ? IPAddress.Any : localAddress, LocalPort));
        IPAddress? mask = wildcard ? MaskOf(localAddress) : null;
        ushort nonce = Transport.NewNonce();
        s.SendTo(Probe(nonce), new IPEndPoint(broadcast, ProbePort));
        var found = new List<DiscoveryReply>();
        var buffer = new byte[2048];
        long deadline = Environment.TickCount64 + (long)timeout.TotalMilliseconds;
        while (true)
        {
            int left = (int)(deadline - Environment.TickCount64);
            if (left <= 0 || !s.Poll(left * 1000, SelectMode.SelectRead)) break;
            EndPoint from = new IPEndPoint(IPAddress.Any, 0);
            int n = s.ReceiveFrom(buffer, ref from);
            if (mask is not null && !SameSubnet(((IPEndPoint)from).Address, localAddress, mask)) continue;
            var reply = DiscoveryReply.Parse(buffer.AsSpan(0, n), nonce);
            if (reply is not null && !found.Any(f => f.Mac.SequenceEqual(reply.Mac))) found.Add(reply);
        }
        return found;
    }

    static IPAddress? MaskOf(IPAddress local) =>
        NetworkInterface.GetAllNetworkInterfaces()
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .FirstOrDefault(u => u.Address.Equals(local))?.IPv4Mask;

    static bool SameSubnet(IPAddress a, IPAddress b, IPAddress mask)
    {
        byte[] x = a.GetAddressBytes(), y = b.GetAddressBytes(), m = mask.GetAddressBytes();
        if (x.Length != 4 || y.Length != 4 || m.Length != 4) return false;
        for (int i = 0; i < 4; i++) if ((x[i] & m[i]) != (y[i] & m[i])) return false;
        return true;
    }
}

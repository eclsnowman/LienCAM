// Which of this PC's addresses a phone can reach.
//
// A machine PC has more than one network card: the controller's (the AXBB-E sits on
// its own 10.10.10.x link with no route anywhere) and the shop LAN the phone is on.
// The OS knows which card carries its default route; asking it (a UDP "connect"
// sends no packet) names the LAN card. That address goes first so the pairing URL
// defaults to it; the others stay listed for the "Phone network" choice.
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

let routedIp = null;

export function orderLanIps(ips, routed) {
  if (!routed || !ips.includes(routed)) return ips;
  return [routed, ...ips.filter((ip) => ip !== routed)];
}

export function refreshRoutedIp() {
  const socket = createSocket('udp4');
  const done = () => { try { socket.close(); } catch { /* already closed */ } };
  socket.on('error', done);
  try {
    socket.connect(53, '1.1.1.1', () => {
      try { routedIp = socket.address().address; } catch { /* no route: keep the OS order */ }
      done();
    });
  } catch { done(); }
}

export function getLanIps() {
  const ips = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  refreshRoutedIp();
  return orderLanIps(ips, routedIp);
}

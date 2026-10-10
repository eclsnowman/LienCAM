// pendant/server.mjs
// Isolated lightweight HTTP & SSE server for mobile jog & probing pendant.

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { getLanIps, refreshRoutedIp } from './lanIps.mjs';
import { SimulatedGrbl } from './sim-grbl.mjs';
import {
  buildProbePlan,
  calculateBoreResult,
  calculateBossResult,
  calculateEdgeResult,
  calculateAngleResult,
} from './probe-planner.mjs';

const args = process.argv.slice(2);
const bridgeMode = args.includes('--bridge');
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8324;
const APP_DIR = resolve(import.meta.dirname, 'app');
const THEME_FILE = resolve(import.meta.dirname, '../src/theme/tokens.css');
const grbl = bridgeMode ? null : new SimulatedGrbl();

const sseClients = new Set();

// 15 Hz Telemetry Broadcast to all connected phones/clients
if (!bridgeMode) setInterval(() => {
  if (sseClients.size === 0) return;
  const status = grbl.getStatus();
  const msg = `event: status\ndata: ${JSON.stringify(status)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}, 66); // ~15 Hz

function broadcastProbeProgress(progressData) {
  const msg = `event: probe_progress\ndata: ${JSON.stringify(progressData)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Active probing execution runner
let activeProbeExecution = null;

async function runProbePlan(plan) {
  if (!grbl) throw new Error('The simulator is unavailable in bridge mode.');
  const { routineId, params, steps } = plan;
  const touches = {};
  const totalSteps = steps.length;

  for (let i = 0; i < totalSteps; i++) {
    const step = steps[i];
    broadcastProbeProgress({
      stepIndex: i,
      totalSteps,
      stepLabel: step.label,
      message: `Running step ${i + 1}/${totalSteps}: ${step.label}`,
    });

    // Execute the G-code commands for this step
    for (const cmd of step.commands) {
      grbl.executeLine(cmd);
      // Wait for move / probe to complete
      await waitForIdleOrContact();
      if (grbl.state === 'alarm') {
        broadcastProbeProgress({
          stepIndex: i,
          totalSteps,
          error: 'Probe cycle aborted: ALARM state encountered.',
        });
        return;
      }
    }

    // If this step produced a probe touch, record it
    if (step.key) {
      touches[step.key] = { ...grbl.lastProbe.pos };
      broadcastProbeProgress({
        stepIndex: i,
        totalSteps,
        stepLabel: step.label,
        touch: touches[step.key],
        message: `Contact registered: MPos [${touches[step.key].x.toFixed(3)}, ${touches[step.key].y.toFixed(3)}, ${touches[step.key].z.toFixed(3)}]`,
      });
    }
  }

  // Calculate final result based on routine
  let result = {};
  const tipRadius = params.tipRadius || 2.0;

  if ((routineId === 'bore' || routineId === 'rectPocket') && touches.xNeg && touches.xPos && touches.yNeg && touches.yPos) {
    result = calculateBoreResult(
      touches.xNeg.x,
      touches.xPos.x,
      touches.yNeg.y,
      touches.yPos.y,
      tipRadius
    );
  } else if ((routineId === 'boss' || routineId === 'rectBoss') && touches.xFromNeg && touches.xFromPos && touches.yFromNeg && touches.yFromPos) {
    result = calculateBossResult(
      touches.xFromNeg.x,
      touches.xFromPos.x,
      touches.yFromNeg.y,
      touches.yFromPos.y,
      tipRadius
    );
  } else if (routineId === 'edge') {
    const axis = params.edgeAxis || 'X';
    const dir = params.edgeDirection || '-';
    const touchPos = axis === 'X' ? grbl.lastProbe.pos.x : grbl.lastProbe.pos.y;
    result = calculateEdgeResult(axis, dir, touchPos, tipRadius);
  } else if (routineId === 'corner' && touches.cornerX && touches.cornerY) {
    const corner = params.corner || 'SW';
    const xDirection = corner.includes('W') ? '-' : '+';
    const yDirection = corner.includes('S') ? '-' : '+';
    const x = calculateEdgeResult('X', xDirection, touches.cornerX.x, tipRadius);
    const y = calculateEdgeResult('Y', yDirection, touches.cornerY.y, tipRadius);
    result = {
      cornerX: x.edgeCoordinate,
      cornerY: y.edgeCoordinate,
      compensation: `${x.compensation} ${y.compensation}`,
    };
  } else if (routineId === 'zSurface') {
    result = {
      surfaceZ: grbl.lastProbe.pos.z,
      compensation: 'Z surface contact registered.',
    };
  } else if (routineId === 'angle' && touches.point1 && touches.point2) {
    const perpAxis = params.angleAxis === 'X' ? 'y' : 'x';
    result = calculateAngleResult(
      params.angleAxis || 'X',
      params.angleSpacing || 30,
      touches.point1[perpAxis],
      touches.point2[perpAxis]
    );
  }

  broadcastProbeProgress({
    complete: true,
    totalSteps,
    result,
    message: 'Probe routine completed successfully!',
  });
}

function waitForIdleOrContact() {
  return new Promise((resolve) => {
    const check = () => {
      if (grbl.state === 'idle' || grbl.state === 'alarm') {
        setTimeout(resolve, 50);
      } else {
        setTimeout(check, 25);
      }
    };
    check();
  });
}

// HTTP Server
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (bridgeMode && pathname === '/api/bridge/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'liencam-pendant-bridge',
      mode: 'bridge',
      port: PORT,
      lanIps: getLanIps(),
    }));
    return;
  }

  // SSE Stream
  if (!bridgeMode && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseClients.add(res);
    // Send immediate status snapshot
    res.write(`event: status\ndata: ${JSON.stringify(grbl.getStatus())}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // JSON API Endpoints
  if (pathname.startsWith('/api/')) {
    if (bridgeMode) {
      res.writeHead(426, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Bridge mode uses the paired WebSocket transport.' }));
      return;
    }
    let body = {};
    if (req.method === 'POST') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString();
        if (raw) body = JSON.parse(raw);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
    }

    if (pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(grbl.getStatus()));
      return;
    }

    if (pathname === '/api/command') {
      const result = grbl.executeLine(body.command);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/jog/step') {
      const axis = ['X', 'Y', 'Z'].includes(body.axis) ? body.axis : null;
      const delta = Number(body.delta);
      const feed = Number(body.feed);
      if (!axis || !Number.isFinite(delta) || delta === 0 || !Number.isFinite(feed) || feed <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Jog axis, distance, or feed is invalid.' }));
        return;
      }
      const cmd = `$J=G91 ${axis}${delta > 0 ? '+' : ''}${delta} F${feed}`;
      const result = grbl.executeLine(cmd);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/jog/continuous') {
      const axis = ['X', 'Y', 'Z'].includes(body.axis) ? body.axis : null;
      const sign = Number(body.sign);
      const feed = Number(body.feed);
      if (!axis || ![-1, 1].includes(sign) || !Number.isFinite(feed) || feed <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Continuous jog axis, direction, or feed is invalid.' }));
        return;
      }
      grbl.renewJogWatchdog(feed);
      // Burst step size for 150ms interval
      const step = Math.max(0.2, (feed / 60000) * 150 * 1.5);
      const cmd = `$J=G91 ${axis}${sign > 0 ? '+' : '-'}${step.toFixed(3)} F${feed}`;
      const result = grbl.executeLine(cmd);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/jog/cancel') {
      grbl.cancelJog();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/api/theme') {
      const { theme } = body;
      grbl.theme = theme === 'amber' ? 'amber' : 'default';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, theme: grbl.theme }));
      return;
    }

    if (pathname === '/api/override') {
      const { type, value } = body;
      const valueText = String(value ?? '');
      const parsedValue = Number.parseInt(valueText, 10);
      if (!['feed', 'rapid', 'spindle'].includes(type) || !Number.isFinite(parsedValue)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Override channel or value is invalid.' }));
        return;
      }
      if (type === 'feed') {
        if (valueText.startsWith('+') || valueText.startsWith('-')) {
          grbl.feedOvr = Math.max(10, Math.min(200, grbl.feedOvr + parsedValue));
        } else {
          grbl.feedOvr = Math.max(10, Math.min(200, parsedValue));
        }
      } else if (type === 'rapid') {
        if (![25, 50, 100].includes(parsedValue)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Rapid override must be 25, 50, or 100.' }));
          return;
        }
        grbl.rapidOvr = parsedValue;
      } else if (type === 'spindle') {
        if (valueText.startsWith('+') || valueText.startsWith('-')) {
          grbl.spindleOvr = Math.max(10, Math.min(200, grbl.spindleOvr + parsedValue));
        } else {
          grbl.spindleOvr = Math.max(10, Math.min(200, parsedValue));
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, overrides: grbl.getStatus().overrides }));
      return;
    }

    if (pathname === '/api/probe/start') {
      const { routineId, params } = body;
      if (activeProbeExecution) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'A probe routine is already running.' }));
        return;
      }
      const plan = buildProbePlan(routineId, params, grbl.pos);
      if (plan.steps.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unknown probe routine.' }));
        return;
      }
      activeProbeExecution = runProbePlan(plan).finally(() => { activeProbeExecution = null; });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plan }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
    return;
  }

  // Static File Serving
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = pathname === '/src/theme/tokens.css'
    ? THEME_FILE
    : resolve(APP_DIR, relativePath);
  if (filePath !== THEME_FILE && filePath !== APP_DIR && !filePath.startsWith(`${APP_DIR}${sep}`)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    // Check if looking for probe-planner.mjs
    if (pathname === '/probe-planner.mjs' || pathname === '/probe-planner.js') {
      filePath = resolve(import.meta.dirname, 'probe-planner.mjs');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('500 Internal Server Error');
  }
});

// Minimal RFC 6455 text framing keeps the bridge zero-dependency. The broker
// never interprets machine commands; it authenticates one desktop authority
// and any number of paired phones, then relays typed JSON between them.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS_PAYLOAD = 1024 * 1024;
const bridgeSessions = new Map();

function wsFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function wsSend(peer, message) {
  if (peer.closed || peer.socket.destroyed) return;
  peer.socket.write(wsFrame(0x1, JSON.stringify(message)));
}

function wsClose(peer, code, reason) {
  if (peer.closed) return;
  peer.closed = true;
  const reasonBytes = Buffer.from(reason).subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  try { peer.socket.end(wsFrame(0x8, payload)); } catch { peer.socket.destroy(); }
}

function sessionFor(token) {
  let session = bridgeSessions.get(token);
  if (!session) {
    session = { desktop: null, pendants: new Set() };
    bridgeSessions.set(token, session);
  }
  return session;
}

function publishClientCount(session) {
  const message = { type: 'clients', connectedPendants: session.pendants.size };
  if (session.desktop) wsSend(session.desktop, message);
  for (const pendant of session.pendants) wsSend(pendant, message);
}

function removePeer(peer) {
  if (!peer.token) return;
  const session = bridgeSessions.get(peer.token);
  if (!session) return;
  if (session.desktop === peer) {
    session.desktop = null;
    for (const pendant of session.pendants) {
      wsSend(pendant, { type: 'bridge-status', connected: false, reason: 'Desktop bridge disconnected.' });
    }
  } else {
    session.pendants.delete(peer);
  }
  publishClientCount(session);
  if (!session.desktop && session.pendants.size === 0) bridgeSessions.delete(peer.token);
}

function acceptHello(peer, message) {
  const token = typeof message.pairingToken === 'string' ? message.pairingToken : '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    wsSend(peer, { type: 'error', code: 'PAIRING_TOKEN_INVALID', error: 'Pairing token is invalid.' });
    wsClose(peer, 1008, 'Invalid pairing token');
    return;
  }
  if (message.role !== 'desktop' && message.role !== 'pendant') {
    wsClose(peer, 1008, 'Invalid bridge role');
    return;
  }
  const session = sessionFor(token);
  if (message.role === 'desktop') {
    if (session.desktop && session.desktop !== peer) {
      wsSend(peer, { type: 'error', code: 'DESKTOP_ALREADY_CONNECTED', error: 'A desktop already owns this pairing.' });
      wsClose(peer, 1008, 'Desktop already connected');
      return;
    }
    session.desktop = peer;
  } else {
    if (!session.desktop) {
      wsSend(peer, { type: 'error', code: 'DESKTOP_NOT_CONNECTED', error: 'The desktop has not enabled this pairing.' });
      wsClose(peer, 1008, 'Desktop not connected');
      return;
    }
    session.pendants.add(peer);
  }
  peer.role = message.role;
  peer.token = token;
  wsSend(peer, {
    type: 'hello-ack',
    role: peer.role,
    clientId: peer.id,
    lanIps: getLanIps(),
    port: PORT,
  });
  if (peer.role === 'pendant') {
    wsSend(peer, { type: 'bridge-status', connected: true });
    wsSend(session.desktop, { type: 'status-request' });
  }
  publishClientCount(session);
}

function handleBridgeMessage(peer, text) {
  let message;
  try { message = JSON.parse(text); } catch {
    wsSend(peer, { type: 'error', code: 'INVALID_JSON', error: 'Bridge messages must be JSON.' });
    return;
  }
  if (!peer.role) {
    if (message.type !== 'hello') return wsClose(peer, 1008, 'Hello required');
    acceptHello(peer, message);
    return;
  }
  const session = bridgeSessions.get(peer.token);
  if (!session) return wsClose(peer, 1011, 'Pairing session lost');
  if (peer.role === 'pendant') {
    if (message.type !== 'command' || typeof message.requestId !== 'string' || !message.command) {
      wsSend(peer, { type: 'error', code: 'COMMAND_INVALID', error: 'Pendant message is not a valid command.' });
      return;
    }
    if (!session.desktop) {
      wsSend(peer, { type: 'command-result', requestId: message.requestId, ok: false, error: 'Desktop bridge is offline.' });
      return;
    }
    wsSend(session.desktop, { ...message, clientId: peer.id });
    return;
  }
  if (!['status', 'event', 'command-result', 'bridge-status'].includes(message.type)) return;
  const targets = message.clientId
    ? [...session.pendants].filter((pendant) => pendant.id === message.clientId)
    : [...session.pendants];
  const outbound = { ...message };
  delete outbound.clientId;
  for (const pendant of targets) wsSend(pendant, outbound);
}

function consumeFrames(peer, chunk) {
  peer.buffer = Buffer.concat([peer.buffer, chunk]);
  while (peer.buffer.length >= 2) {
    const first = peer.buffer[0];
    const second = peer.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (!fin || !masked) return wsClose(peer, 1002, 'Unsupported frame');
    if (length === 126) {
      if (peer.buffer.length < 4) return;
      length = peer.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (peer.buffer.length < 10) return;
      const longLength = peer.buffer.readBigUInt64BE(2);
      if (longLength > BigInt(MAX_WS_PAYLOAD)) return wsClose(peer, 1009, 'Message too large');
      length = Number(longLength);
      offset = 10;
    }
    if (length > MAX_WS_PAYLOAD) return wsClose(peer, 1009, 'Message too large');
    if (peer.buffer.length < offset + 4 + length) return;
    const mask = peer.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(peer.buffer.subarray(offset, offset + length));
    peer.buffer = peer.buffer.subarray(offset + length);
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
    if (opcode === 0x8) return wsClose(peer, 1000, 'Closed');
    if (opcode === 0x9) {
      peer.socket.write(wsFrame(0xA, payload));
      continue;
    }
    if (opcode !== 0x1) return wsClose(peer, 1003, 'Text messages only');
    handleBridgeMessage(peer, payload.toString('utf8'));
  }
}

if (bridgeMode) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== '/bridge' || typeof key !== 'string') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const peer = { id: randomUUID(), socket, buffer: Buffer.alloc(0), role: null, token: null, closed: false };
    socket.on('data', (chunk) => consumeFrames(peer, chunk));
    socket.on('close', () => { peer.closed = true; removePeer(peer); });
    socket.on('error', () => { peer.closed = true; removePeer(peer); });
  });
}

refreshRoutedIp();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` LienCAM Mobile Jog & Probing Pendant ${bridgeMode ? 'Bridge' : 'Simulator'} LIVE`);
  console.log(`======================================================`);
  console.log(` Local browser:     http://localhost:${PORT}`);
  console.log(` Phone / WireGuard:`);
  for (const ip of getLanIps()) {
    console.log(`   -> http://${ip}:${PORT}/`);
  }
  if (bridgeMode) console.log(` WebSocket broker: ws://localhost:${PORT}/bridge`);
  console.log(`======================================================\n`);
});

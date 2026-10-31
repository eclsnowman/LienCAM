import { PROBE_ROUTINES, firstStepSentence } from './probe-planner.js?v=12';
import { renderProbeDiagram } from './probe-diagrams.js?v=12';

const MM_PER_INCH = 25.4;
const query = new URLSearchParams(window.location.search);
const pairingToken = query.get('pair');
const bridgeUrl = query.get('broker') || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/bridge`;
const bridgeMode = Boolean(pairingToken);
const pendingBridgeRequests = new Map();
let bridgeSocket = null;
let bridgeRequestSequence = 0;
let feedbackTimer = null;
// WO-2886: a phone suspends a page it is not showing and its socket dies with
// it. The page reconnects by itself - at once when it is shown again, with a
// short backoff while it stays visible - and offers a refresh only after
// several attempts in a row have failed.
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 5000];
const REFRESH_OFFER_AFTER_FAILURES = 3;
const RESUME_SILENCE_MS = 3000;
let bridgeGeneration = 0;
let bridgeLastMessageAt = 0;
let bridgeFailures = 0;
let bridgeLostReason = '';
let reconnectTimer = null;
let resumeCheckTimer = null;

let status = {
  state: 'Idle', mpos: [0, 0, 0], wpos: [0, 0, 0], wco: [0, 0, 0],
  activeWcs: 'G54', theme: 'default', feed: 0, spindleRpm: 0, spindleState: 'off',
  overrides: { feed: null, rapid: null, spindle: null },
  overrideAvailability: { feed: 'unknown', rapid: 'unknown', spindle: 'unknown' },
  parserState: {}, tool: 1, toolInfo: { number: 1, name: '6mm 3-Flute Carbide', diameterMm: 6 }, tlo: 0, pins: '',
};

let units = 'mm';
let droMode = 'work';
let jogMode = 'step';
let step = 1;
let feed = 800;
let holdTimer = null;
let holdButton = null;
let routine = 'bore';
let touches = {};
let lastResult = null;
let theme = 'default';
let probeSetup = null;
let previewPending = false;
let previewAt = 0;

const $ = (sel) => document.querySelector(sel);

async function api(path, body = {}) {
  let outcome;
  if (bridgeMode) {
    outcome = await bridgeApi(path, body);
  } else {
    try {
      const res = await fetch(`/api/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      outcome = await res.json();
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }
  }
  reportCommandOutcome(path, outcome);
  return outcome;
}

function reportCommandOutcome(path, outcome) {
  if (outcome?.ok && ['jog/continuous', 'jog/cancel', 'theme'].includes(path)) return;
  const feedback = $('#command-feedback');
  if (!feedback || !outcome) return;
  window.clearTimeout(feedbackTimer);
  const accepted = outcome.ok === true;
  feedback.textContent = accepted ? 'Command accepted by LienCAM.' : (outcome.error || 'Command refused by LienCAM.');
  feedback.classList.toggle('error', !accepted);
  feedback.hidden = false;
  feedbackTimer = window.setTimeout(() => { feedback.hidden = true; }, accepted ? 1400 : 4000);
}

function bridgeCommandFor(path, body) {
  if (path === 'jog/step') return { kind: 'jog-step', axis: body.axis, deltaMm: body.delta, feedMmMin: body.feed };
  if (path === 'jog/continuous') return { kind: 'jog-continuous', axis: body.axis, direction: body.sign, feedMmMin: body.feed };
  if (path === 'jog/cancel') return { kind: 'jog-cancel' };
  if (path === 'override') {
    const current = Number(status.overrides?.[body.type] ?? 100);
    const parsed = Number.parseInt(body.value, 10);
    const value = String(body.value).startsWith('+') || String(body.value).startsWith('-') ? current + parsed : parsed;
    return { kind: 'override', channel: body.type, value };
  }
  if (path === 'macro') return { kind: 'macro', id: body.id };
  if (path === 'probe/start') {
    return {
      kind: 'probe-start',
      routineId: body.routineId,
      params: { ...body.params, pathClearConfirmed: body.pathClearConfirmed === true },
    };
  }
  if (path === 'probe/apply-zero') return { kind: 'apply-probe-zero' };
  if (path === 'theme') return null;
  if (path !== 'command') return undefined;
  const command = String(body.command || '').trim().toUpperCase();
  if (command === '!') return { kind: 'feed-hold' };
  if (command === '0X18') return { kind: 'soft-reset' };
  if (/^G5[4-9]$/.test(command)) return { kind: 'select-wcs', wcs: command };
  if (/^G10 L20 P0 (X0 Y0 Z0|[XYZ]0)$/.test(command)) {
    const axes = command.endsWith('X0 Y0 Z0') ? ['X', 'Y', 'Z'] : [command.at(-2)];
    return { kind: 'zero-axes', axes };
  }
  if (command.startsWith('M3 ')) return { kind: 'spindle', direction: 'cw' };
  if (command.startsWith('M4 ')) return { kind: 'spindle', direction: 'ccw' };
  if (command === 'M5') return { kind: 'spindle', direction: 'off' };
  return undefined;
}

function bridgeApi(path, body) {
  const command = bridgeCommandFor(path, body);
  if (command === null) return Promise.resolve({ ok: true });
  if (!command) return Promise.resolve({ ok: false, error: 'This command is not allowed through the remote bridge.' });
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, error: 'The desktop pendant bridge is offline.' });
  }
  const requestId = `phone-${Date.now().toString(36)}-${(++bridgeRequestSequence).toString(36)}`;
  const socket = bridgeSocket;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      pendingBridgeRequests.delete(requestId);
      resolve({ ok: false, error: 'The desktop did not answer the remote command.' });
    }, path === 'probe/start' ? 300000 : 10000);
    pendingBridgeRequests.set(requestId, { resolve, timeout, socket });
    socket.send(JSON.stringify({ type: 'command', requestId, command }));
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initTheme();
  initTransport();
  initJog();
  initMacros();
  initProbe();
  initStatus();
  layout();
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', layout);
});

function layout() {
  const cluster = $('#jog-cluster');
  const pad = $('#xy-pad');
  const z = $('#z-axis');
  const macro = $('#macro-panel');
  const pane = $('#pane-jog');
  if (!pane.classList.contains('active')) return;

  const body = $('#body');
  const gap = parseFloat(getComputedStyle(pane).rowGap) || 10;
  const fixed =
    $('.dro-card').offsetHeight +
    $('.step-row').offsetHeight +
    $('.feed-row').offsetHeight +
    $('.zero-row').offsetHeight;
  const clusterMax = body.clientHeight - fixed - gap * 4;
  const innerW = cluster.clientWidth - 20;
  const innerH = clusterMax - 20;
  const padSize = Math.max(140, Math.min(innerW - z.offsetWidth - 10, innerH));
  pad.style.width = `${Math.floor(padSize)}px`;
  pad.style.height = `${Math.floor(padSize)}px`;
  const leftover = clusterMax - padSize - 20;
  // The narrow layout needs two complete macro rows. Never reveal a clipped
  // panel merely because its title fits; on wide layouts all four fit in one row.
  const minMacroHeight = innerW >= 720 ? 100 : 230;
  const showMacro = leftover >= minMacroHeight;
  macro.classList.toggle('hidden', !showMacro);
  cluster.classList.toggle('grow', !showMacro);
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
      requestAnimationFrame(layout);
    });
  });
}

function initTheme() {
  if (bridgeMode) {
    $('#btn-theme').disabled = true;
    $('#btn-theme').setAttribute('aria-label', 'Theme follows LienCAM desktop');
    return;
  }
  $('#btn-theme').addEventListener('click', () => {
    applyTheme(theme === 'default' ? 'amber' : 'default');
    api('theme', { theme });
  });
}

function applyTheme(next) {
  theme = next;
  if (next === 'amber') document.documentElement.setAttribute('data-theme', 'amber');
  else document.documentElement.removeAttribute('data-theme');
  $('#theme-name').textContent = next === 'amber' ? 'AMBER' : 'BLUE';
  renderDiagram();
}

function initTransport() {
  if (bridgeMode) initBridge();
  else initSSE();
}

function initBridge() {
  $('#btn-refresh').addEventListener('click', () => window.location.reload());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkBridgeOnResume();
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) checkBridgeOnResume(); });
  window.addEventListener('online', checkBridgeOnResume);
  connectBridge();
}

function connectBridge() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const generation = ++bridgeGeneration;
  const previous = bridgeSocket;
  bridgeSocket = null;
  if (previous) settleRequestsOn(previous, 'Pendant bridge disconnected.');
  if (previous && previous.readyState <= WebSocket.OPEN) {
    try { previous.close(1000, 'Pendant reconnecting'); } catch { /* already gone */ }
  }
  let socket;
  try {
    socket = new WebSocket(bridgeUrl);
  } catch {
    bridgeLost('Could not connect to the pendant bridge.');
    return;
  }
  bridgeSocket = socket;
  const current = () => generation === bridgeGeneration;
  socket.addEventListener('open', () => {
    if (!current()) return;
    socket.send(JSON.stringify({ type: 'hello', role: 'pendant', pairingToken }));
  });
  socket.addEventListener('message', (event) => {
    if (!current()) return;
    bridgeLastMessageAt = Date.now();
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'hello-ack') {
      bridgeFailures = 0;
      bridgeLostReason = '';
      paintLinkLine();
    } else if (message.type === 'status' && message.data) {
      if (message.data.theme && message.data.theme !== theme) applyTheme(message.data.theme);
      status = message.data;
      paint();
    } else if (message.type === 'event' && message.event === 'probe_progress') {
      paintProbeProgress(message.data || {});
    } else if (message.type === 'command-result') {
      const pending = pendingBridgeRequests.get(message.requestId);
      if (pending) {
        window.clearTimeout(pending.timeout);
        pendingBridgeRequests.delete(message.requestId);
        pending.resolve(message);
      }
    } else if (message.type === 'error') {
      bridgeLostReason = message.error || 'Pendant pairing was refused.';
      paintBridgeError(bridgeLostReason);
    } else if (message.type === 'bridge-status' && message.connected === false) {
      paintBridgeError('LienCAM desktop disabled remote control.');
    }
  });
  socket.addEventListener('error', () => {
    if (current() && !bridgeLostReason) bridgeLostReason = 'Could not connect to the pendant bridge.';
  });
  socket.addEventListener('close', () => {
    if (!current()) {
      settleRequestsOn(socket, 'Pendant bridge disconnected.');
      return;
    }
    bridgeLost(bridgeLostReason || 'Pendant bridge disconnected.');
  });
}

// A link being replaced can no longer answer: every command still waiting on
// it is answered now, once, whichever link is current by then. Nothing is
// sent again on the new link - the operator presses again to repeat it.
function settleRequestsOn(socket, message) {
  for (const [requestId, pending] of pendingBridgeRequests) {
    if (pending.socket !== socket) continue;
    window.clearTimeout(pending.timeout);
    pendingBridgeRequests.delete(requestId);
    pending.resolve({ ok: false, error: message });
  }
}

// The link is gone: nothing held keeps running, every waiting command is
// answered, and a new link is tried - now if the page is showing, otherwise
// the moment it is shown again.
function bridgeLost(reason) {
  bridgeSocket = null;
  releaseHeldJog(false);
  paintBridgeError(reason);
  bridgeFailures += 1;
  bridgeLostReason = '';
  paintLinkLine(reason);
  if (document.visibilityState !== 'hidden') scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(Math.max(bridgeFailures - 1, 0), RECONNECT_DELAYS_MS.length - 1)];
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, delay);
}

// Shown again (or back online): a dead link reconnects at once. An open one
// that has carried nothing since the page came back - the desktop sends
// status many times a second - is treated as dead too, unless a command is
// still waiting on it.
function checkBridgeOnResume() {
  if (document.visibilityState === 'hidden') return;
  const state = bridgeSocket?.readyState;
  if (state === WebSocket.CONNECTING) return;
  if (state !== WebSocket.OPEN) {
    connectBridge();
    return;
  }
  const resumedAt = Date.now();
  window.clearTimeout(resumeCheckTimer);
  resumeCheckTimer = window.setTimeout(() => {
    resumeCheckTimer = null;
    if (document.visibilityState === 'hidden' || bridgeSocket?.readyState !== WebSocket.OPEN) return;
    if (bridgeLastMessageAt >= resumedAt || pendingBridgeRequests.size > 0) return;
    const silent = bridgeSocket;
    bridgeGeneration += 1;
    try { silent.close(1000, 'Pendant link silent'); } catch { /* already gone */ }
    bridgeLost('LienCAM stopped answering this phone.');
  }, RESUME_SILENCE_MS);
}

function paintLinkLine(reason = '') {
  const line = $('#link-line');
  if (!line) return;
  if (!reason) {
    line.hidden = true;
    return;
  }
  const offerRefresh = bridgeFailures >= REFRESH_OFFER_AFTER_FAILURES;
  $('#link-text').textContent = offerRefresh
    ? `${reason} Still trying to reconnect - or refresh this page.`
    : `${reason} Reconnecting...`;
  $('#btn-refresh').hidden = !offerRefresh;
  line.hidden = false;
}

function paintBridgeError(message) {
  probeSetup = null;
  renderDiagram();
  const pill = $('#hdr-state');
  pill.textContent = 'OFFLINE';
  pill.className = 'pill st-alarm';
  $('#probe-msg').textContent = message;
  for (const pending of pendingBridgeRequests.values()) {
    window.clearTimeout(pending.timeout);
    pending.resolve({ ok: false, error: message });
  }
  pendingBridgeRequests.clear();
}

function initSSE() {
  const events = new EventSource('/api/events');
  events.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    if (data.theme && data.theme !== theme) applyTheme(data.theme);
    status = data;
    paint();
  });
  events.addEventListener('probe_progress', (e) => {
    paintProbeProgress(JSON.parse(e.data));
  });
}

function paint() {
  refreshProbeSetup();
  const pill = $('#hdr-state');
  pill.textContent = status.state.toUpperCase();
  pill.className = `pill st-${status.state.toLowerCase()}`;
  $('#hdr-wcs').textContent = status.activeWcs;

  const scale = units === 'inch' ? 1 / MM_PER_INCH : 1;
  const dec = units === 'inch' ? 4 : 3;
  const overrideLabel = (channel) => {
    const availability = status.overrideAvailability?.[channel];
    if (availability === 'unsupported') return 'n/a';
    if (availability === 'unknown') return '--';
    const value = status.overrides?.[channel];
    return Number.isFinite(value) ? `${value}%` : '--';
  };
  const primary = droMode === 'work' ? status.wpos : status.mpos;
  const secondary = droMode === 'work' ? status.mpos : status.wpos;
  const f = (v) => (v * scale).toFixed(dec);
  $('#dro-x').textContent = f(primary[0]);
  $('#dro-y').textContent = f(primary[1]);
  $('#dro-z').textContent = f(primary[2]);
  $('#dro-x-sub').textContent = f(secondary[0]);
  $('#dro-y-sub').textContent = f(secondary[1]);
  $('#dro-z-sub').textContent = f(secondary[2]);

  $('#gl-spindle').textContent = status.spindleState === 'off' ? 'OFF' : `${status.spindleRpm} RPM`;
  $('#gl-tool').textContent = `T${status.tool}`;
  $('#gl-feed').textContent = `${status.feed}`;
  $('#gl-ovr').textContent = overrideLabel('feed');

  const s = status;
  const put = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  put('#st-wx', (s.wpos[0] * scale).toFixed(dec));
  put('#st-wy', (s.wpos[1] * scale).toFixed(dec));
  put('#st-wz', (s.wpos[2] * scale).toFixed(dec));
  put('#st-mx', (s.mpos[0] * scale).toFixed(dec));
  put('#st-my', (s.mpos[1] * scale).toFixed(dec));
  put('#st-mz', (s.mpos[2] * scale).toFixed(dec));
  put('#st-ox', (s.wco[0] * scale).toFixed(dec));
  put('#st-oy', (s.wco[1] * scale).toFixed(dec));
  put('#st-oz', (s.wco[2] * scale).toFixed(dec));

  const ps = s.parserState || {};
  put('#ch-motion', `Motion: ${ps.motion || 'G0'}`);
  put('#ch-wcs', `WCS: ${ps.wcs || s.activeWcs}`);
  put('#ch-plane', `Plane: ${ps.plane || 'G17'}`);
  put('#ch-dist', `Dist: ${ps.distance || 'G90'}`);
  put('#ch-units', `Units: ${ps.units || 'G21'}`);
  put('#ch-spindle', `Spindle: ${ps.spindle || 'M5'}`);
  put('#ch-coolant', `Coolant: ${ps.coolant || 'M9'}`);

  put('#st-rpm', `${s.spindleRpm} RPM`);
  put('#st-feed', `${s.feed} mm/min`);
  put('#ov-feed', overrideLabel('feed'));
  put('#ov-rapid', overrideLabel('rapid'));
  put('#ov-spindle', overrideLabel('spindle'));

  const ti = s.toolInfo || {};
  put('#tl-num', `T${ti.number || s.tool}`);
  put('#tl-name', ti.name || '6mm 3-Flute Carbide');
  put('#tl-dia', `${(ti.diameterMm || 6).toFixed(3)} mm`);
  put('#tl-tlo', `${(s.tlo || 0).toFixed(3)} mm`);

  const pin = $('#hw-probe');
  const trig = s.pins && s.pins.includes('P');
  pin.textContent = trig ? 'TRIGGERED (P)' : 'INACTIVE';
  pin.className = trig ? 'pin-on' : 'pin-off';

  document.querySelectorAll('.wcs-btn').forEach((b) => b.classList.toggle('active', b.dataset.wcs === s.activeWcs));
}

function initJog() {
  $('#btn-units').addEventListener('click', () => {
    units = units === 'mm' ? 'inch' : 'mm';
    $('#btn-units').textContent = units.toUpperCase();
    paint();
  });

  $('#btn-dromode').addEventListener('click', () => {
    droMode = droMode === 'work' ? 'machine' : 'work';
    $('#btn-dromode').textContent = droMode === 'work' ? 'WPOS' : 'MPOS';
    paint();
  });

  $('#btn-mode').addEventListener('click', () => {
    jogMode = jogMode === 'step' ? 'cont' : 'step';
    const btn = $('#btn-mode');
    btn.textContent = jogMode === 'step' ? 'STEP' : 'CONT';
    btn.classList.toggle('cont', jogMode === 'cont');
    $('#step-chips').style.opacity = jogMode === 'cont' ? '0.4' : '1';
  });

  document.querySelectorAll('#step-chips .chip').forEach((c) => {
    c.addEventListener('click', () => {
      document.querySelectorAll('#step-chips .chip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      step = parseFloat(c.dataset.step);
    });
  });

  document.querySelectorAll('.chip-feed').forEach((c) => {
    c.addEventListener('click', () => {
      document.querySelectorAll('.chip-feed').forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      feed = parseInt(c.dataset.feed, 10);
      $('#feed-readout').textContent = `${feed}`;
    });
  });

  document.querySelectorAll('[data-axis]').forEach((btn) => {
    const axis = btn.dataset.axis;
    const sign = parseInt(btn.dataset.sign, 10);

    const start = (e) => {
      e.preventDefault();
      if (jogMode === 'step') {
        api('jog/step', { axis, delta: sign * step, feed });
      } else {
        // One held jog at a time: a second finger must not stack a second keep-alive.
        if (holdTimer !== null) return;
        holdButton = btn;
        api('jog/continuous', { axis, sign, feed });
        holdTimer = setInterval(() => api('jog/continuous', { axis, sign, feed }), 150);
      }
    };

    const stop = (e) => {
      e.preventDefault();
      if (holdButton === btn) releaseHeldJog(true);
    };

    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
  });

  // WO-2886: a page the phone is not showing cannot be held. Release the jog
  // as a lifted finger would, so a reconnect never revives a keep-alive.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseHeldJog(true);
  });

  $('#btn-safez').addEventListener('click', () => bridgeMode
    ? api('macro', { id: 'raise-z' })
    : api('command', { command: 'G53 G0 Z15.0' }));

  document.querySelectorAll('.zero-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const t = b.dataset.zero;
      api('command', { command: t === 'ALL' ? 'G10 L20 P0 X0 Y0 Z0' : `G10 L20 P0 ${t}0` });
    });
  });

  $('#btn-hold').addEventListener('click', () => api('command', { command: '!' }));
  $('#btn-reset').addEventListener('click', () => api('command', { command: '0x18' }));
}

function releaseHeldJog(sendCancel) {
  if (holdTimer === null) return;
  clearInterval(holdTimer);
  holdTimer = null;
  holdButton = null;
  if (sendCancel) api('jog/cancel');
}

function initMacros() {
  document.querySelectorAll('.macro-btn').forEach((b) => {
    b.addEventListener('click', () => bridgeMode
      ? api('macro', { id: b.dataset.macro })
      : api('command', { command: b.dataset.cmd }));
  });
}

function initProbe() {
  const grid = $('#probe-grid');
  PROBE_ROUTINES.forEach((r) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `probe-tile ${r.id === routine ? 'active' : ''}`;
    tile.innerHTML = `<span class="probe-tile-name">${r.name}</span><span class="probe-tile-desc">${r.desc}</span>`;
    tile.addEventListener('click', () => {
      document.querySelectorAll('.probe-tile').forEach((t) => t.classList.remove('active'));
      tile.classList.add('active');
      routine = r.id;
      probeSetup = null;
      previewAt = 0;
      touches = {};
      updateProbeForm();
      renderDiagram();
      refreshProbeSetup();
    });
    grid.appendChild(tile);
  });

  updateProbeForm();
  renderDiagram();
  if (bridgeMode) {
    $('#inp-tip').value = '';
    $('#inp-size').value = '';
    $('#inp-tip').placeholder = 'Screen';
    $('#inp-size').placeholder = 'Screen';
  }
  for (const selector of ['#sel-edge', '#inp-tip', '#inp-size']) {
    $(selector).addEventListener('input', () => { probeSetup = null; previewAt = 0; renderDiagram(); refreshProbeSetup(); });
  }

  $('#btn-probe-start').addEventListener('click', async () => {
    if (!bridgeMode && routine !== 'zSurface') {
      const message = 'The standalone phone simulator cannot run the machine-screen probing method.';
      paintProbeProgress({ error: message, message, stepIndex: 0, totalSteps: 1 });
      return;
    }
    const params = phoneProbeParams();
    touches = {};
    $('#probe-exec').hidden = false;
    $('#probe-result').hidden = true;
    $('#probe-log').innerHTML = '';
    $('#probe-fill').style.width = '10%';
    const outcome = await api('probe/start', {
      routineId: routine,
      params,
      pathClearConfirmed: $('#probe-path-clear').checked,
    });
    if (!outcome.ok) paintProbeProgress({ error: outcome.error, message: outcome.error, stepIndex: 0, totalSteps: 1 });
  });

  $('#btn-apply-zero').addEventListener('click', async () => {
    if (!lastResult) return;
    if (bridgeMode) {
      const outcome = await api('probe/apply-zero');
      if (!outcome.ok) paintProbeProgress({ error: outcome.error, message: outcome.error, stepIndex: 0, totalSteps: 1 });
      return;
    }
    if (lastResult.centerX !== undefined) {
      await api('command', { command: `G10 L2 P0 X${lastResult.centerX.toFixed(3)} Y${lastResult.centerY.toFixed(3)}` });
    } else if (lastResult.edgeCoordinate !== undefined) {
      await api('command', { command: `G10 L2 P0 ${lastResult.axis}${lastResult.edgeCoordinate.toFixed(3)}` });
    } else if (lastResult.surfaceZ !== undefined) {
      await api('command', { command: `G10 L2 P0 Z${lastResult.surfaceZ.toFixed(3)}` });
    }
  });
}

function updateProbeForm() {
  const r = PROBE_ROUTINES.find((x) => x.id === routine);
  $('#params-title').textContent = `${r.name.toUpperCase()} PARAMETERS`;
  $('#diagram-title').textContent = `${r.name.toUpperCase()} DIAGRAM`;
  const round = ['bore', 'boss'].includes(routine);
  const rect = ['rectPocket', 'rectBoss'].includes(routine);
  const edge = ['edge', 'angle'].includes(routine);
  // WO-2809: a feature routine runs on the machine's probe settings, as the
  // Probing screen's does; this feed and search travel are Z surface's only.
  const zSurface = routine === 'zSurface';
  $('#field-feed').style.display = zSurface ? 'flex' : 'none';
  $('#field-travel').style.display = zSurface ? 'flex' : 'none';
  $('#field-size').style.display = round || rect || routine === 'angle' ? 'flex' : 'none';
  $('#lbl-size').textContent = round ? 'Nominal Dia (mm)' : rect ? 'Size X = Y override (mm)' : 'Touch Spacing (mm)';
  $('#field-edge').style.display = edge ? 'flex' : 'none';
}

function renderDiagram(activeStep = -1) {
  const params = {
    ...probeSetup,
    edgeAxis: $('#sel-edge').value.charAt(0),
    edgeDirection: $('#sel-edge').value.charAt(1),
  };
  const info = $('#probe-setup');
  if (info) info.textContent = probeSetup ? `Depth ${probeSetup.depthBelowTopMm} mm. Clearance ${probeSetup.clearanceMm} mm. X ${probeSetup.nominalSizeXmm} / Y ${probeSetup.nominalSizeYmm} mm. Probe X ${probeSetup.tipRadiusXmm} / Y ${probeSetup.tipRadiusYmm} mm.` : '';
  $('#probe-diagram').innerHTML = renderProbeDiagram(routine, params, activeStep, touches);
  // WO-2809: step 1 in the machine Probing screen's words.
  $('#probe-where').textContent = bridgeMode && routine !== 'zSurface' && !probeSetup ? 'Reading the machine screen probing setup...' : firstStepSentence(routine, { ...params, wcs: status.activeWcs });
}

function phoneProbeParams() {
  const inheritedNumber = (selector, fallback) => $(selector).value.trim() === '' && bridgeMode
    ? -1 : Number($(selector).value || fallback);
  return {
    probeFeed: Number($('#inp-feed').value || 80),
    searchTravel: Number($('#inp-travel').value || 20),
    tipRadius: inheritedNumber('#inp-tip', 1.5),
    nominalSize: inheritedNumber('#inp-size', 25),
    edgeAxis: $('#sel-edge').value.charAt(0),
    edgeDirection: $('#sel-edge').value.charAt(1),
  };
}

// Readback of the desktop-resolved setup using a non-confirmed command:
// it returns setup data and moves nothing. Keep the path confirmation for Run.
async function refreshProbeSetup() {
  if (!$('#pane-probe').classList.contains('active')) return;
  if (!bridgeMode || routine === 'zSurface' || previewPending || Date.now() - previewAt < 1000) return;
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) return;
  const selected = routine;
  const params = phoneProbeParams();
  const key = JSON.stringify(params);
  previewPending = true;
  previewAt = Date.now();
  try {
    const result = await bridgeApi('probe/start', { routineId: selected, params, pathClearConfirmed: false });
    if (selected !== routine || key !== JSON.stringify(phoneProbeParams())) return;
    probeSetup = result.data || null;
    renderDiagram();
  } finally {
    previewPending = false;
  }
}

function paintProbeProgress(d) {
  $('#probe-exec').hidden = false;
  $('#probe-msg').textContent = d.message || '';
  $('#probe-fill').style.width = `${Math.round(((d.stepIndex + 1) / d.totalSteps) * 100)}%`;

  if (d.touch) {
    if (d.stepLabel.includes('X-')) touches.xNeg = d.touch;
    if (d.stepLabel.includes('X+')) touches.xPos = d.touch;
    if (d.stepLabel.includes('Y-')) touches.yNeg = d.touch;
    if (d.stepLabel.includes('Y+')) touches.yPos = d.touch;
    const line = document.createElement('div');
    line.textContent = `> ${d.stepLabel}: [${d.touch.x.toFixed(3)}, ${d.touch.y.toFixed(3)}, ${d.touch.z.toFixed(3)}]`;
    $('#probe-log').appendChild(line);
    $('#probe-log').scrollTop = 99999;
    renderDiagram(d.stepIndex);
  }

  if (d.complete) {
    $('#probe-pill').textContent = 'COMPLETE';
    $('#probe-pill').className = 'pill st-idle';
    $('#probe-fill').style.width = '100%';
    lastResult = d.result;
    const r = d.result;
    let html = '';
    if (r.centerX !== undefined) {
      html += `<div><b>Center:</b> X ${r.centerX.toFixed(3)} / Y ${r.centerY.toFixed(3)} mm</div>`;
      if (r.diameterX) html += `<div><b>Dia:</b> X ${r.diameterX.toFixed(3)} / Y ${r.diameterY.toFixed(3)} mm</div>`;
    } else if (r.edgeCoordinate !== undefined) {
      html += `<div><b>Edge (${r.axis}):</b> ${r.edgeCoordinate.toFixed(3)} mm</div>`;
    } else if (r.thetaDeg !== undefined) {
      html += `<div><b>Yaw:</b> ${r.thetaDeg.toFixed(3)} deg</div>`;
    } else if (r.surfaceZ !== undefined) {
      html += `<div><b>Surface Z:</b> ${r.surfaceZ.toFixed(3)} mm</div>`;
    }
    if (r.compensation) html += `<div style="color: var(--slate-400); font-size: var(--fs-tiny); margin-top: 6px;">${r.compensation}</div>`;
    $('#result-box').innerHTML = html;
    $('#probe-result').hidden = false;
  } else if (d.error) {
    $('#probe-pill').textContent = 'ALARM';
    $('#probe-pill').className = 'pill st-alarm';
    $('#probe-msg').textContent = d.error;
  }
}

function initStatus() {
  document.querySelectorAll('.sp-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const code = b.dataset.spindle;
      api('command', { command: code === 'M5' ? 'M5' : `${code} S10000` });
    });
  });

  document.querySelectorAll('.ovr-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const [type, value] = b.dataset.ovr.split(':');
      api('override', { type, value });
    });
  });

  document.querySelectorAll('.wcs-btn').forEach((b) => {
    b.addEventListener('click', () => api('command', { command: b.dataset.wcs }));
  });
}

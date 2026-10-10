// pendant/sim-grbl.mjs
// Full GRBL 1.1 kinematics & 3D virtual stock simulation engine for mobile pendant testing.

export class SimulatedGrbl {
  constructor(options = {}) {
    this.pos = { x: 50.0, y: 50.0, z: 15.0 }; // Initial MPos
    this.wcsOffsets = {
      G54: { x: 0.0, y: 0.0, z: 0.0 },
      G55: { x: 0.0, y: 0.0, z: 0.0 },
      G56: { x: 0.0, y: 0.0, z: 0.0 },
      G57: { x: 0.0, y: 0.0, z: 0.0 },
      G58: { x: 0.0, y: 0.0, z: 0.0 },
      G59: { x: 0.0, y: 0.0, z: 0.0 },
    };
    this.activeWcs = 'G54';
    this.distanceMode = 'G90'; // 'G90' | 'G91'
    this.motionMode = 'G0'; // 'G0' | 'G1' | 'G38.2'
    this.planeMode = 'G17'; // 'G17' (XY)
    this.unitsMode = 'G21'; // 'G21' (mm) | 'G20' (in)
    this.theme = options.theme || 'default'; // 'default' | 'amber'
    this.g92Offset = { x: 0.0, y: 0.0, z: 0.0 };
    this.state = 'idle'; // 'idle' | 'jog' | 'run' | 'hold' | 'alarm'
    this.alarmCode = null;

    this.feedOvr = 100;
    this.rapidOvr = 100;
    this.spindleOvr = 100;
    this.spindleState = 'off'; // 'off' | 'cw' | 'ccw'
    this.spindleRpm = 0;
    this.commandedRpm = 10000;
    this.commandedFeed = 800;
    this.coolant = 'off'; // 'off' | 'flood' | 'mist'

    this.feedNow = 0;
    this.lastProbe = { pos: { x: 0, y: 0, z: 0 }, success: false };
    this.activeTool = 1;
    this.toolInfo = {
      number: 1,
      name: '6mm 3-Flute Carbide',
      diameterMm: 6.0,
      lengthMm: 50.0,
      fluteLenMm: 22.0,
    };
    this.toolLengthOffset = 0.0;
    this.activeProbeTipRadius = options.tipRadius !== undefined ? options.tipRadius : 2.0;

    // Motion Queue
    this.queue = [];
    this.currentMove = null;

    // Virtual stock bounds for 3D probing contact (in Machine Coordinates)
    this.virtualStock = {
      minX: 0.0,
      maxX: 100.0,
      minY: 10.0,
      maxY: 90.0,
      topZ: 0.0,
      botZ: -25.0,
      bore: { centerX: 50.0, centerY: 50.0, radius: 15.0, topZ: 0.0, botZ: -25.0 }, // 30mm dia
      boss: { centerX: 50.0, centerY: 50.0, radius: 12.5, topZ: 10.0, botZ: 0.0 },  // 25mm dia
    };

    // Watchdog for continuous jog
    this.jogWatchdogExpiresAt = 0;
    this.jogAxis = null;
    this.jogSign = 0;
    this.jogFeed = 0;

    // Event listeners
    this.listeners = new Set();
    this.intervalId = setInterval(() => this.tick(), 25); // 40 Hz physics tick
  }

  destroy() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(data) {
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch (err) {
        console.error('Listener error:', err);
      }
    }
  }

  effWco() {
    const w = this.wcsOffsets[this.activeWcs] || { x: 0, y: 0, z: 0 };
    return {
      x: w.x + this.g92Offset.x,
      y: w.y + this.g92Offset.y,
      z: w.z + this.g92Offset.z - this.toolLengthOffset,
    };
  }

  wpos() {
    const w = this.effWco();
    return {
      x: this.pos.x - w.x,
      y: this.pos.y - w.y,
      z: this.pos.z - w.z,
    };
  }

  getStatus() {
    const wpos = this.wpos();
    const wco = this.effWco();
    return {
      state: this.state.charAt(0).toUpperCase() + this.state.slice(1),
      mpos: [Number(this.pos.x.toFixed(3)), Number(this.pos.y.toFixed(3)), Number(this.pos.z.toFixed(3))],
      wpos: [Number(wpos.x.toFixed(3)), Number(wpos.y.toFixed(3)), Number(wpos.z.toFixed(3))],
      wco: [Number(wco.x.toFixed(3)), Number(wco.y.toFixed(3)), Number(wco.z.toFixed(3))],
      activeWcs: this.activeWcs,
      theme: this.theme,
      feed: Math.round((this.feedNow * this.feedOvr) / 100),
      commandedFeed: this.commandedFeed,
      spindleRpm: this.spindleState === 'off' ? 0 : Math.round((this.spindleRpm * this.spindleOvr) / 100),
      commandedRpm: this.commandedRpm,
      spindleState: this.spindleState,
      coolantState: this.coolant,
      overrides: {
        feed: this.feedOvr,
        rapid: this.rapidOvr,
        spindle: this.spindleOvr,
      },
      parserState: {
        motion: this.motionMode,
        wcs: this.activeWcs,
        plane: this.planeMode,
        units: this.unitsMode,
        distance: this.distanceMode,
        spindle: this.spindleState === 'off' ? 'M5' : (this.spindleState === 'cw' ? 'M3' : 'M4'),
        coolant: this.coolant === 'off' ? 'M9' : 'M8',
      },
      tool: this.activeTool,
      toolInfo: {
        ...this.toolInfo,
        tlo: Number(this.toolLengthOffset.toFixed(3)),
      },
      tlo: Number(this.toolLengthOffset.toFixed(3)),
      pins: this.lastProbe.success ? 'P' : '',
      buffer: { plan: 15, rx: 128 },
      alarm: this.alarmCode,
      lastProbe: this.lastProbe,
    };
  }

  executeLine(raw) {
    const line = String(raw || '').trim();
    if (!line) return { ok: true };

    // Realtime single-byte commands
    if (line === '?' || line === 'status') {
      return { ok: true, status: this.getStatus() };
    }
    if (line === '!' || line === 'hold') {
      if (this.state === 'run' || this.state === 'jog') {
        this.state = 'hold';
        this.emit({ type: 'status', status: this.getStatus() });
      }
      return { ok: true };
    }
    if (line === '~' || line === 'resume') {
      if (this.state === 'hold') {
        this.state = this.queue.length > 0 ? 'run' : 'idle';
        this.emit({ type: 'status', status: this.getStatus() });
      }
      return { ok: true };
    }
    if (line === '0x85' || line === 'jogCancel') {
      this.cancelJog();
      return { ok: true };
    }
    if (line === '0x18' || line === 'reset' || line === '$X') {
      this.state = 'idle';
      this.alarmCode = null;
      this.queue = [];
      this.currentMove = null;
      this.feedNow = 0;
      this.emit({ type: 'status', status: this.getStatus() });
      return { ok: true };
    }

    // $H Homing
    if (line === '$H') {
      this.pos = { x: 100.0, y: 100.0, z: 20.0 };
      this.state = 'idle';
      this.alarmCode = null;
      this.emit({ type: 'status', status: this.getStatus() });
      return { ok: true };
    }

    // Jog command: $J=G91 X... Y... Z... F...
    if (line.startsWith('$J=')) {
      if (this.state === 'alarm' || this.state === 'hold') {
        return { ok: false, error: 'Cannot jog while in alarm or hold' };
      }
      return this.handleJogCommand(line.slice(3));
    }

    // G-code parsing
    return this.parseGcode(line);
  }

  handleJogCommand(params) {
    const isG90 = params.includes('G90');
    const isG53 = params.includes('G53');
    const xMatch = params.match(/X([+-]?\d*\.?\d+)/);
    const yMatch = params.match(/Y([+-]?\d*\.?\d+)/);
    const zMatch = params.match(/Z([+-]?\d*\.?\d+)/);
    const fMatch = params.match(/F(\d*\.?\d+)/);

    const feed = fMatch ? parseFloat(fMatch[1]) : 1000;
    const w = this.effWco();

    let targetX = this.pos.x;
    let targetY = this.pos.y;
    let targetZ = this.pos.z;

    if (isG53) {
      // Machine coordinates
      if (xMatch) targetX = parseFloat(xMatch[1]);
      if (yMatch) targetY = parseFloat(yMatch[1]);
      if (zMatch) targetZ = parseFloat(zMatch[1]);
    } else if (isG90) {
      // Absolute work coordinates
      if (xMatch) targetX = parseFloat(xMatch[1]) + w.x;
      if (yMatch) targetY = parseFloat(yMatch[1]) + w.y;
      if (zMatch) targetZ = parseFloat(zMatch[1]) + w.z;
    } else {
      // Incremental (G91)
      if (xMatch) targetX += parseFloat(xMatch[1]);
      if (yMatch) targetY += parseFloat(yMatch[1]);
      if (zMatch) targetZ += parseFloat(zMatch[1]);
    }

    this.queue = [{
      kind: 'jog',
      target: { x: targetX, y: targetY, z: targetZ },
      feed,
    }];
    this.state = 'jog';
    return { ok: true };
  }

  renewJogWatchdog(feed) {
    this.jogWatchdogExpiresAt = Date.now() + 300; // 300ms lease
    this.jogFeed = feed || 800;
  }

  cancelJog() {
    this.jogWatchdogExpiresAt = 0;
    this.queue = this.queue.filter(m => m.kind !== 'jog');
    if (this.state === 'jog') {
      this.state = 'idle';
      this.feedNow = 0;
      this.emit({ type: 'status', status: this.getStatus() });
    }
  }

  parseGcode(line) {
    const upper = line.toUpperCase();

    // WCS Selection: G54 - G59
    const wcsMatch = upper.match(/G5[4-9]/);
    if (wcsMatch) {
      this.activeWcs = wcsMatch[0];
      this.emit({ type: 'status', status: this.getStatus() });
      return { ok: true };
    }

    // G10 L2 P0..6 X... Y... Z... (Direct Origin Offset)
    if (upper.startsWith('G10') && upper.includes('L2') && !upper.includes('L20')) {
      const pMatch = upper.match(/P(\d+)/);
      const p = pMatch ? parseInt(pMatch[1], 10) : 0;
      const targetWcs = p === 0 ? this.activeWcs : `G5${3 + p}`;
      const xMatch = upper.match(/X([+-]?\d*\.?\d+)/);
      const yMatch = upper.match(/Y([+-]?\d*\.?\d+)/);
      const zMatch = upper.match(/Z([+-]?\d*\.?\d+)/);

      if (this.wcsOffsets[targetWcs]) {
        if (xMatch) this.wcsOffsets[targetWcs].x = parseFloat(xMatch[1]);
        if (yMatch) this.wcsOffsets[targetWcs].y = parseFloat(yMatch[1]);
        if (zMatch) this.wcsOffsets[targetWcs].z = parseFloat(zMatch[1]);
        this.emit({ type: 'status', status: this.getStatus() });
      }
      return { ok: true };
    }

    // G10 L20 P0..6 X... Y... Z... (Zero / Set Work Offset relative to current position)
    if (upper.startsWith('G10') && upper.includes('L20')) {
      const pMatch = upper.match(/P(\d+)/);
      const p = pMatch ? parseInt(pMatch[1], 10) : 0;
      const targetWcs = p === 0 ? this.activeWcs : `G5${3 + p}`;
      const xMatch = upper.match(/X([+-]?\d*\.?\d+)/);
      const yMatch = upper.match(/Y([+-]?\d*\.?\d+)/);
      const zMatch = upper.match(/Z([+-]?\d*\.?\d+)/);

      if (this.wcsOffsets[targetWcs]) {
        if (xMatch) this.wcsOffsets[targetWcs].x = this.pos.x - parseFloat(xMatch[1]);
        if (yMatch) this.wcsOffsets[targetWcs].y = this.pos.y - parseFloat(yMatch[1]);
        if (zMatch) this.wcsOffsets[targetWcs].z = this.pos.z - parseFloat(zMatch[1]);
        this.emit({ type: 'status', status: this.getStatus() });
      }
      return { ok: true };
    }

    // Distance modes
    if (upper.includes('G90')) this.distanceMode = 'G90';
    if (upper.includes('G91')) this.distanceMode = 'G91';
    const isG91 = this.distanceMode === 'G91';

    // G38.2 Probing Move
    if (upper.startsWith('G38.2')) {
      if (this.state === 'alarm') {
        return { ok: false, error: 'Cannot probe while in alarm' };
      }
      const xMatch = upper.match(/X([+-]?\d*\.?\d+)/);
      const yMatch = upper.match(/Y([+-]?\d*\.?\d+)/);
      const zMatch = upper.match(/Z([+-]?\d*\.?\d+)/);
      const fMatch = upper.match(/F(\d*\.?\d+)/);
      const feed = fMatch ? parseFloat(fMatch[1]) : 100;
      const w = this.effWco();

      let targetX = this.pos.x;
      let targetY = this.pos.y;
      let targetZ = this.pos.z;

      if (isG91) {
        if (xMatch) targetX += parseFloat(xMatch[1]);
        if (yMatch) targetY += parseFloat(yMatch[1]);
        if (zMatch) targetZ += parseFloat(zMatch[1]);
      } else {
        if (xMatch) targetX = parseFloat(xMatch[1]) + w.x;
        if (yMatch) targetY = parseFloat(yMatch[1]) + w.y;
        if (zMatch) targetZ = parseFloat(zMatch[1]) + w.z;
      }

      this.queue.push({
        kind: 'probe',
        target: { x: targetX, y: targetY, z: targetZ },
        start: { ...this.pos },
        feed,
      });
      this.state = 'run';
      return { ok: true };
    }

    // Standard motion: G0 / G1
    if (upper.includes('G0') || upper.includes('G1')) {
      const isRapid = upper.includes('G0');
      const isG53 = upper.includes('G53');
      const xMatch = upper.match(/X([+-]?\d*\.?\d+)/);
      const yMatch = upper.match(/Y([+-]?\d*\.?\d+)/);
      const zMatch = upper.match(/Z([+-]?\d*\.?\d+)/);
      const fMatch = upper.match(/F(\d*\.?\d+)/);
      const feed = fMatch ? parseFloat(fMatch[1]) : (isRapid ? 3000 : 1000);
      const w = this.effWco();

      let targetX = this.pos.x;
      let targetY = this.pos.y;
      let targetZ = this.pos.z;

      if (isG53) {
        if (xMatch) targetX = parseFloat(xMatch[1]);
        if (yMatch) targetY = parseFloat(yMatch[1]);
        if (zMatch) targetZ = parseFloat(zMatch[1]);
      } else if (isG91) {
        if (xMatch) targetX += parseFloat(xMatch[1]);
        if (yMatch) targetY += parseFloat(yMatch[1]);
        if (zMatch) targetZ += parseFloat(zMatch[1]);
      } else {
        if (xMatch) targetX = parseFloat(xMatch[1]) + w.x;
        if (yMatch) targetY = parseFloat(yMatch[1]) + w.y;
        if (zMatch) targetZ = parseFloat(zMatch[1]) + w.z;
      }

      this.queue.push({
        kind: isRapid ? 'rapid' : 'feed',
        target: { x: targetX, y: targetY, z: targetZ },
        feed,
      });
      this.state = 'run';
      return { ok: true };
    }

    // Spindle commands: M3, M4, M5
    if (upper.includes('M3')) {
      this.spindleState = 'cw';
      const sMatch = upper.match(/S(\d+)/);
      if (sMatch) this.spindleRpm = parseInt(sMatch[1], 10);
      this.emit({ type: 'status', status: this.getStatus() });
      return { ok: true };
    }
    if (upper.includes('M4')) {
      this.spindleState = 'ccw';
      const sMatch = upper.match(/S(\d+)/);
      if (sMatch) this.spindleRpm = parseInt(sMatch[1], 10);
      this.emit({ type: 'status', status: this.getStatus() });
      return { ok: true };
    }
    if (upper.includes('M5')) {
      this.spindleState = 'off';
      this.emit({ type: 'status', status: this.getStatus() });
      return { ok: true };
    }

    return { ok: true };
  }

  checkProbeCollision(curr, next) {
    const s = this.virtualStock;

    // 1. Downward Z probe crossing virtual stock top (Z = 0) or boss top (Z = 10)
    if (curr.z > next.z) {
      // Check if inside boss footprint
      const distFromCenter = Math.hypot(curr.x - s.boss.centerX, curr.y - s.boss.centerY);
      const isOverBoss = distFromCenter <= s.boss.radius;
      const tripZ = isOverBoss ? s.boss.topZ : s.topZ;

      if (curr.z >= tripZ && next.z <= tripZ) {
        return { hit: true, pos: { x: next.x, y: next.y, z: tripZ } };
      }
    }

    // 2. X/Y Probe inside Bore (Center at 50, 50, Radius 15, Z between -25 and 0)
    if (curr.z <= s.bore.topZ && curr.z >= s.bore.botZ) {
      const c = s.bore;
      const contactRadius = Math.max(1.0, c.radius - this.activeProbeTipRadius);
      const rCurr = Math.hypot(curr.x - c.centerX, curr.y - c.centerY);
      const rNext = Math.hypot(next.x - c.centerX, next.y - c.centerY);
      if (rCurr < contactRadius && rNext >= contactRadius) {
        // Crossing bore wall outward (probe center reaches contactRadius)
        const angle = Math.atan2(next.y - c.centerY, next.x - c.centerX);
        return {
          hit: true,
          pos: {
            x: c.centerX + contactRadius * Math.cos(angle),
            y: c.centerY + contactRadius * Math.sin(angle),
            z: curr.z,
          },
        };
      }
    }

    // 3. X/Y Probe outside Boss (Center at 50, 50, Radius 12.5, Z between 0 and 10)
    if (curr.z <= s.boss.topZ && curr.z >= s.boss.botZ) {
      const c = s.boss;
      const contactRadius = c.radius + this.activeProbeTipRadius;
      const rCurr = Math.hypot(curr.x - c.centerX, curr.y - c.centerY);
      const rNext = Math.hypot(next.x - c.centerX, next.y - c.centerY);
      if (rCurr > contactRadius && rNext <= contactRadius) {
        // Crossing boss wall inward (probe center reaches contactRadius)
        const angle = Math.atan2(next.y - c.centerY, next.x - c.centerX);
        return {
          hit: true,
          pos: {
            x: c.centerX + contactRadius * Math.cos(angle),
            y: c.centerY + contactRadius * Math.sin(angle),
            z: curr.z,
          },
        };
      }
    }

    // 4. X/Y Probe on Outer Stock Edges (Z between -25 and 0)
    if (curr.z <= s.topZ && curr.z >= s.botZ) {
      const tipR = this.activeProbeTipRadius;
      // X- probe hitting left edge (X = 0) from outside (X < 0)
      if (curr.x < (s.minX - tipR) && next.x >= (s.minX - tipR)) {
        return { hit: true, pos: { x: s.minX - tipR, y: next.y, z: curr.z } };
      }
      // X+ probe hitting right edge (X = 100) from outside (X > 100)
      if (curr.x > (s.maxX + tipR) && next.x <= (s.maxX + tipR)) {
        return { hit: true, pos: { x: s.maxX + tipR, y: next.y, z: curr.z } };
      }
      // Y- probe hitting front edge (Y = 10) from outside (Y < 10)
      if (curr.y < (s.minY - tipR) && next.y >= (s.minY - tipR)) {
        return { hit: true, pos: { x: next.x, y: s.minY - tipR, z: curr.z } };
      }
      // Y+ probe hitting back edge (Y = 90) from outside (Y > 90)
      if (curr.y > (s.maxY + tipR) && next.y <= (s.maxY + tipR)) {
        return { hit: true, pos: { x: next.x, y: s.maxY + tipR, z: curr.z } };
      }
    }

    return { hit: false };
  }

  tick() {
    // Watchdog check for continuous jog
    if (this.jogWatchdogExpiresAt > 0 && Date.now() > this.jogWatchdogExpiresAt) {
      this.cancelJog();
    }

    if (this.state === 'hold' || this.state === 'alarm') {
      this.feedNow = 0;
      return;
    }

    const move = this.queue[0];
    if (!move) {
      if (this.state === 'run' || this.state === 'jog') {
        this.state = 'idle';
        this.feedNow = 0;
        this.emit({ type: 'status', status: this.getStatus() });
      }
      return;
    }

    this.state = move.kind === 'jog' ? 'jog' : 'run';
    const ovr = move.kind === 'rapid' ? this.rapidOvr : this.feedOvr;
    const effectiveFeed = (move.feed * ovr) / 100;
    this.feedNow = effectiveFeed;

    const dtMin = 25 / 60000; // 25ms in minutes
    const stepMm = effectiveFeed * dtMin;

    const dx = move.target.x - this.pos.x;
    const dy = move.target.y - this.pos.y;
    const dz = move.target.z - this.pos.z;
    const dist = Math.hypot(dx, dy, dz);

    if (dist <= stepMm || dist === 0) {
      const nextPos = { ...move.target };
      if (move.kind === 'probe') {
        const collision = this.checkProbeCollision(this.pos, nextPos);
        if (collision.hit) {
          this.pos = collision.pos;
          this.finishProbe(true);
          return;
        }
        // Probe reached target without contact -> Miss / Alarm 5
        this.pos = nextPos;
        this.finishProbe(false);
        return;
      }
      this.pos = nextPos;
      this.queue.shift();
      if (this.queue.length === 0) {
        this.state = 'idle';
        this.feedNow = 0;
      }
      this.emit({ type: 'status', status: this.getStatus() });
      return;
    }

    const nextPos = {
      x: this.pos.x + (dx * stepMm) / dist,
      y: this.pos.y + (dy * stepMm) / dist,
      z: this.pos.z + (dz * stepMm) / dist,
    };

    if (move.kind === 'probe') {
      const collision = this.checkProbeCollision(this.pos, nextPos);
      if (collision.hit) {
        this.pos = collision.pos;
        this.finishProbe(true);
        return;
      }
    }

    this.pos = nextPos;
    this.emit({ type: 'status', status: this.getStatus() });
  }

  finishProbe(success) {
    this.queue = [];
    this.lastProbe = { pos: { ...this.pos }, success };
    if (success) {
      this.state = 'idle';
      this.feedNow = 0;
      this.emit({
        type: 'probe',
        success: true,
        pos: this.lastProbe.pos,
        report: `[PRB:${this.pos.x.toFixed(3)},${this.pos.y.toFixed(3)},${this.pos.z.toFixed(3)}:1]`,
      });
    } else {
      this.state = 'alarm';
      this.alarmCode = 5;
      this.feedNow = 0;
      this.emit({
        type: 'probe',
        success: false,
        pos: this.lastProbe.pos,
        error: 'ALARM:5 (Probe did not contact workpiece within programmed travel)',
      });
    }
    this.emit({ type: 'status', status: this.getStatus() });
  }
}

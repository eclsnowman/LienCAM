// pendant/probe-planner.mjs
// Multi-routine probing planners and coordinate calculations for LienCAM mobile pendant.

export { PROBE_ROUTINES } from './app/probe-routines.mjs';

export function calculateEdgeResult(axis, direction, triggerPos, tipRadius) {
  const signedRadius = direction === '+' ? tipRadius : -tipRadius;
  return {
    axis,
    direction,
    rawTrigger: triggerPos,
    tipRadius,
    edgeCoordinate: triggerPos + signedRadius,
    compensation: `Tip radius ${direction === '+' ? '+' : '-'}${tipRadius.toFixed(3)} mm applied to ${axis} touch.`,
  };
}

export function calculateBoreResult(xNeg, xPos, yNeg, yPos, tipRadius) {
  const diameterX = xPos - xNeg + 2 * tipRadius;
  const diameterY = yPos - yNeg + 2 * tipRadius;
  const centerX = (xNeg + xPos) / 2;
  const centerY = (yNeg + yPos) / 2;
  return {
    centerX,
    centerY,
    diameterX,
    diameterY,
    avgDiameter: (diameterX + diameterY) / 2,
    tipRadius,
    compensation: `2x tip radius (+${(2 * tipRadius).toFixed(3)} mm) added to measured spans.`,
  };
}

export function calculateBossResult(xTouchFromNeg, xTouchFromPos, yTouchFromNeg, yTouchFromPos, tipRadius) {
  // xTouchFromNeg approaches from +X going -X (hitting max X wall)
  // xTouchFromPos approaches from -X going +X (hitting min X wall)
  const diameterX = xTouchFromNeg - xTouchFromPos - 2 * tipRadius;
  const diameterY = yTouchFromNeg - yTouchFromPos - 2 * tipRadius;
  const centerX = (xTouchFromNeg + xTouchFromPos) / 2;
  const centerY = (yTouchFromNeg + yTouchFromPos) / 2;
  return {
    centerX,
    centerY,
    diameterX,
    diameterY,
    avgDiameter: (diameterX + diameterY) / 2,
    tipRadius,
    compensation: `2x tip radius (-${(2 * tipRadius).toFixed(3)} mm) subtracted from measured spans.`,
  };
}

export function calculateAngleResult(nominalAxis, spacingMm, perpTouch1, perpTouch2) {
  const deltaPerp = perpTouch2 - perpTouch1;
  const thetaRad = Math.atan2(deltaPerp, spacingMm);
  const thetaDeg = (thetaRad * 180) / Math.PI;
  return {
    nominalAxis,
    spacingMm,
    deltaPerp,
    thetaDeg: Number(thetaDeg.toFixed(4)),
    summary: `Part misalignment: ${thetaDeg >= 0 ? '+' : ''}${thetaDeg.toFixed(3)} deg from ${nominalAxis} axis.`,
  };
}

/**
 * Builds the executable step sequence for a given probe routine.
 */
export function buildProbePlan(routineId, params, currentPos) {
  const {
    searchFeed = 400,
    probeFeed = 80,
    searchTravel = 20,
    retract = 2,
    tipRadius = 2.0,
    plateThickness = 0.0,
    nominalSize = 30, // For bore/boss
    edgeAxis = 'X',
    edgeDirection = '-', // Probing toward - direction (hitting + face) or vice-versa
    corner = 'SW', // 'SW' | 'SE' | 'NW' | 'NE'
    angleAxis = 'X',
    angleSpacing = 30,
  } = params;

  const start = { ...currentPos };
  const steps = [];

  if (routineId === 'zSurface') {
    steps.push({
      label: 'Probe Z Surface Downward',
      commands: [
        `G91`,
        `G38.2 Z-${searchTravel} F${probeFeed}`,
        `G0 Z${retract}`,
      ],
      type: 'zTouch',
    });
  } else if (routineId === 'edge') {
    const dirSign = edgeDirection === '+' ? '+' : '-';
    const oppSign = edgeDirection === '+' ? '-' : '+';
    const probeZ = start.z > 0 ? -5.0 : start.z;
    steps.push({
      label: `Probe ${edgeAxis}${edgeDirection} Edge`,
      axis: edgeAxis,
      direction: edgeDirection,
      commands: [
        `G90 G0 Z${probeZ}`,
        `G91`,
        `G38.2 ${edgeAxis}${dirSign}${searchTravel} F${probeFeed}`,
        `G0 ${edgeAxis}${oppSign}${retract}`,
        `G90 G0 Z${start.z}`,
      ],
      type: 'edgeTouch',
    });
  } else if (routineId === 'bore' || routineId === 'rectPocket') {
    // Four inside touches solve both circular bores and rectangular pockets.
    const probeZ = start.z > 0 ? -5.0 : start.z;
    // 1. Position Z inside bore, probe X-
    steps.push({
      label: '1/4: Probe Bore X- (Left Wall)',
      key: 'xNeg',
      commands: [
        `G90 G0 Z${probeZ}`,
        `G91`,
        `G38.2 X-${searchTravel} F${probeFeed}`,
        `G0 X${retract}`,
        `G90 G0 X${start.x}`, // Return to X center
      ],
    });
    // 2. Probe X+
    steps.push({
      label: '2/4: Probe Bore X+ (Right Wall)',
      key: 'xPos',
      commands: [
        `G91`,
        `G38.2 X${searchTravel} F${probeFeed}`,
        `G0 X-${retract}`,
        `G90 G0 X${start.x}`, // Return to X center
      ],
    });
    // 3. Probe Y-
    steps.push({
      label: '3/4: Probe Bore Y- (Front Wall)',
      key: 'yNeg',
      commands: [
        `G91`,
        `G38.2 Y-${searchTravel} F${probeFeed}`,
        `G0 Y${retract}`,
        `G90 G0 Y${start.y}`, // Return to Y center
      ],
    });
    // 4. Probe Y+ and retract to safe start Z
    steps.push({
      label: '4/4: Probe Bore Y+ (Back Wall)',
      key: 'yPos',
      commands: [
        `G91`,
        `G38.2 Y${searchTravel} F${probeFeed}`,
        `G0 Y-${retract}`,
        `G90 G0 X${start.x} Y${start.y}`, // Return to center
        `G90 G0 Z${start.z}`,             // Retract to safe Z
      ],
    });
  } else if (routineId === 'boss' || routineId === 'rectBoss') {
    // Four outside touches solve both circular and rectangular bosses.
    const clearDist = nominalSize / 2 + searchTravel / 2;
    const safeZ = start.z;
    const probeZ = start.z - 8; // Plunge depth for boss side touches

    // 1. Touch from +X side towards center (-X)
    steps.push({
      label: '1/4: Position and Probe Boss Right Face (X- direction)',
      key: 'xFromNeg',
      commands: [
        `G90 G0 X${start.x + clearDist} Y${start.y}`,
        `G90 G0 Z${probeZ}`,
        `G91 G38.2 X-${searchTravel} F${probeFeed}`,
        `G91 G0 X${retract}`,
        `G90 G0 Z${safeZ}`,
      ],
    });
    // 2. Touch from -X side towards center (+X)
    steps.push({
      label: '2/4: Position and Probe Boss Left Face (X+ direction)',
      key: 'xFromPos',
      commands: [
        `G90 G0 X${start.x - clearDist} Y${start.y}`,
        `G90 G0 Z${probeZ}`,
        `G91 G38.2 X${searchTravel} F${probeFeed}`,
        `G91 G0 X-${retract}`,
        `G90 G0 Z${safeZ}`,
      ],
    });
    // 3. Touch from +Y side towards center (-Y)
    steps.push({
      label: '3/4: Position and Probe Boss Back Face (Y- direction)',
      key: 'yFromNeg',
      commands: [
        `G90 G0 X${start.x} Y${start.y + clearDist}`,
        `G90 G0 Z${probeZ}`,
        `G91 G38.2 Y-${searchTravel} F${probeFeed}`,
        `G91 G0 Y${retract}`,
        `G90 G0 Z${safeZ}`,
      ],
    });
    // 4. Touch from -Y side towards center (+Y)
    steps.push({
      label: '4/4: Position and Probe Boss Front Face (Y+ direction)',
      key: 'yFromPos',
      commands: [
        `G90 G0 X${start.x} Y${start.y - clearDist}`,
        `G90 G0 Z${probeZ}`,
        `G91 G38.2 Y${searchTravel} F${probeFeed}`,
        `G91 G0 Y-${retract}`,
        `G90 G0 Z${safeZ}`,
        `G90 G0 X${start.x} Y${start.y}`, // Return to starting XY
      ],
    });
  } else if (routineId === 'corner') {
    // 2-touch corner
    const xDir = corner.includes('W') ? '-' : '+';
    const yDir = corner.includes('S') ? '-' : '+';
    const xOpp = xDir === '+' ? '-' : '+';
    const yOpp = yDir === '+' ? '-' : '+';

    steps.push({
      label: `1/2: Probe X Corner Face (${xDir} direction)`,
      key: 'cornerX',
      axis: 'X',
      direction: xDir,
      commands: [
        `G91 G38.2 X${xDir}${searchTravel} F${probeFeed}`,
        `G91 G0 X${xOpp}${retract}`,
      ],
    });
    steps.push({
      label: `2/2: Probe Y Corner Face (${yDir} direction)`,
      key: 'cornerY',
      axis: 'Y',
      direction: yDir,
      commands: [
        `G91 G38.2 Y${yDir}${searchTravel} F${probeFeed}`,
        `G91 G0 Y${yOpp}${retract}`,
      ],
    });
  } else if (routineId === 'angle') {
    // 2-point touch along nominal axis
    const perpAxis = angleAxis === 'X' ? 'Y' : 'X';
    const perpDir = edgeDirection;
    const oppDir = perpDir === '+' ? '-' : '+';

    steps.push({
      label: `1/2: First Point along ${angleAxis}`,
      key: 'point1',
      commands: [
        `G91 G38.2 ${perpAxis}${perpDir}${searchTravel} F${probeFeed}`,
        `G91 G0 ${perpAxis}${oppDir}${retract}`,
      ],
    });
    steps.push({
      label: `2/2: Shift ${angleSpacing}mm along ${angleAxis} and Probe Second Point`,
      key: 'point2',
      commands: [
        `G91 G0 ${angleAxis}${angleSpacing}`,
        `G91 G38.2 ${perpAxis}${perpDir}${searchTravel} F${probeFeed}`,
        `G91 G0 ${perpAxis}${oppDir}${retract}`,
      ],
    });
  }

  return {
    routineId,
    startPos: start,
    params,
    steps,
  };
}

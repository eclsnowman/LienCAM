// pendant/app/probe-diagrams.js
// High-contrast, reactive SVG shop diagrams for LienCAM mobile probing routines with strict theme adherence.
// WO-2809: each picture shows where the machine Probing screen puts the probe
// at step 1 (START, seen from above) - over the stock or over the middle,
// above the top - and the touches its from-the-top plan makes from there.

// Where the operator leaves the probe before Start.
function startMark(x, y, color, labelDx = 10, labelDy = -9) {
  return `
        <g class="probe-start-mark">
          <circle cx="${x}" cy="${y}" r="8" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="3 2" />
          <circle cx="${x}" cy="${y}" r="2.5" fill="${color}" />
          <text x="${x + labelDx}" y="${y + labelDy}" fill="${color}" font-size="10" font-weight="800">START</text>
        </g>`;
}

export function renderProbeDiagram(routineId, params = {}, activeStepIndex = -1, touches = {}) {
  const isAmber = document.documentElement.getAttribute('data-theme') === 'amber';
  const primaryColor = isAmber ? '#e0a94f' : '#4a90d9';
  const lightColor = isAmber ? '#ffd878' : '#7ec0ff';
  const stockFill = isAmber ? '#1c1a14' : '#111827';
  const stockStroke = isAmber ? '#835e1f' : '#2d3748';
  const touchAcquired = '#4caf50';

  let svgContent = '';

  if (routineId === 'bore') {
    // 4-touch inside circle
    svgContent = `
      <svg viewBox="0 0 200 150" class="probe-svg-canvas" aria-hidden="true">
        <!-- Outer Stock Body -->
        <rect x="25" y="10" width="150" height="130" rx="8" fill="${stockFill}" stroke="${stockStroke}" stroke-width="2" />
        <!-- Bore Hole (Dark Inset) -->
        <circle cx="100" cy="75" r="44" fill="#090d12" stroke="${primaryColor}" stroke-width="2.5" stroke-dasharray="4 2" />
        <!-- Center Crosshairs -->
        <line x1="100" y1="35" x2="100" y2="115" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" stroke-dasharray="2 2" />
        <line x1="60" y1="75" x2="140" y2="75" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" stroke-dasharray="2 2" />
        ${startMark(100, 75, '#fff', 10, -10)}

        <!-- 4 Touch Arrows / Points -->
        <!-- 1. X- Left Wall -->
        <g class="probe-diagram-arrow ${activeStepIndex === 0 ? 'active-pulse' : ''}" transform="translate(62, 75)">
          <line x1="28" y1="0" x2="8" y2="0" stroke="${touches.xNeg ? touchAcquired : primaryColor}" stroke-width="3" />
          <circle cx="0" cy="0" r="5" fill="${touches.xNeg ? touchAcquired : lightColor}" />
          <text x="-6" y="16" fill="${lightColor}" font-size="11" font-weight="800">1: X-</text>
        </g>

        <!-- 2. X+ Right Wall -->
        <g class="probe-diagram-arrow ${activeStepIndex === 1 ? 'active-pulse' : ''}" transform="translate(138, 75)">
          <line x1="-28" y1="0" x2="-8" y2="0" stroke="${touches.xPos ? touchAcquired : primaryColor}" stroke-width="3" />
          <circle cx="0" cy="0" r="5" fill="${touches.xPos ? touchAcquired : lightColor}" />
          <text x="-6" y="16" fill="${lightColor}" font-size="11" font-weight="800">2: X+</text>
        </g>

        <!-- 3. Y- Front Wall -->
        <g class="probe-diagram-arrow ${activeStepIndex === 2 ? 'active-pulse' : ''}" transform="translate(100, 113)">
          <line x1="0" y1="-28" x2="0" y2="-8" stroke="${touches.yNeg ? touchAcquired : primaryColor}" stroke-width="3" />
          <circle cx="0" cy="0" r="5" fill="${touches.yNeg ? touchAcquired : lightColor}" />
          <text x="10" y="4" fill="${lightColor}" font-size="11" font-weight="800">3: Y-</text>
        </g>

        <!-- 4. Y+ Back Wall -->
        <g class="probe-diagram-arrow ${activeStepIndex === 3 ? 'active-pulse' : ''}" transform="translate(100, 37)">
          <line x1="0" y1="28" x2="0" y2="8" stroke="${touches.yPos ? touchAcquired : primaryColor}" stroke-width="3" />
          <circle cx="0" cy="0" r="5" fill="${touches.yPos ? touchAcquired : lightColor}" />
          <text x="10" y="4" fill="${lightColor}" font-size="11" font-weight="800">4: Y+</text>
        </g>
      </svg>
    `;
  } else if (routineId === 'boss') {
    // 4-touch outside circle
    svgContent = `
      <svg viewBox="0 0 200 150" class="probe-svg-canvas" aria-hidden="true">
        <rect x="25" y="10" width="150" height="130" rx="8" fill="${stockFill}" stroke="${stockStroke}" stroke-width="2" />
        <!-- Boss Protrusion -->
        <circle cx="100" cy="75" r="36" fill="rgba(255, 255, 255, 0.05)" stroke="${primaryColor}" stroke-width="3" />
        <!-- Top touched over the middle, then each face from outside, crossing above the top -->
        ${startMark(100, 75, '#fff', -15, -13)}

        <!-- 4 Approach Arrows -->
        <g transform="translate(142, 75)"><line x1="24" y1="0" x2="4" y2="0" stroke="${primaryColor}" stroke-width="3" /><circle cx="0" cy="0" r="5" fill="${lightColor}" /><text x="6" y="-6" fill="${lightColor}" font-size="10" font-weight="800">X-</text></g>
        <g transform="translate(58, 75)"><line x1="-24" y1="0" x2="-4" y2="0" stroke="${primaryColor}" stroke-width="3" /><circle cx="0" cy="0" r="5" fill="${lightColor}" /><text x="-18" y="-6" fill="${lightColor}" font-size="10" font-weight="800">X+</text></g>
        <g transform="translate(100, 117)"><line x1="0" y1="24" x2="0" y2="4" stroke="${primaryColor}" stroke-width="3" /><circle cx="0" cy="0" r="5" fill="${lightColor}" /><text x="8" y="12" fill="${lightColor}" font-size="10" font-weight="800">Y+</text></g>
        <g transform="translate(100, 33)"><line x1="0" y1="-24" x2="0" y2="-4" stroke="${primaryColor}" stroke-width="3" /><circle cx="0" cy="0" r="5" fill="${lightColor}" /><text x="8" y="-4" fill="${lightColor}" font-size="10" font-weight="800">Y-</text></g>
      </svg>
    `;
  } else if (routineId === 'edge') {
    const axis = params.edgeAxis || 'X';
    const dir = params.edgeDirection || '+';
    // Drawn as the face the probe moves toward (X+ meets the left face; X-
    // is the mirror): over the stock within the start band, the top touched
    // there, then out past the face, down, and back to touch it.
    const mirror = (axis === 'X' && dir === '-') || (axis === 'Y' && dir === '-') ? 'translate(200 0) scale(-1 1)' : '';
    const face = axis === 'X' ? (dir === '+' ? 'LEFT' : 'RIGHT') : (dir === '+' ? 'FRONT' : 'BACK');
    svgContent = `
      <svg viewBox="0 0 200 130" class="probe-svg-canvas" aria-hidden="true">
        <g transform="${mirror}">
          <rect x="70" y="15" width="110" height="100" rx="4" fill="${stockFill}" stroke="${stockStroke}" stroke-width="2" />
          <rect x="70" y="15" width="28" height="100" fill="rgba(255,255,255,0.06)" />
          <line x1="70" y1="10" x2="70" y2="120" stroke="${primaryColor}" stroke-width="4" />
          <path d="M 84 65 V 92 H 40 V 65" fill="none" stroke="${lightColor}" stroke-width="2" stroke-dasharray="4 3" />
          <line x1="40" y1="65" x2="58" y2="65" stroke="${primaryColor}" stroke-width="3.5" />
          <circle cx="64" cy="65" r="6" fill="${lightColor}" stroke="#fff" stroke-width="1.5" />
          <circle cx="84" cy="65" r="8" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="3 2" />
          <circle cx="84" cy="65" r="2.5" fill="#fff" />
        </g>
        <text x="${mirror ? 92 : 80}" y="48" fill="#fff" font-size="10" font-weight="800">START</text>
        <text x="${mirror ? 14 : 104}" y="108" fill="${lightColor}" font-size="10" font-weight="800">${face} FACE (${axis}${dir})</text>
      </svg>
    `;
  } else if (routineId === 'corner') {
    // Inside corner of a pocket, front-left: over the corner, inside the
    // pocket, then down and one touch on each wall.
    svgContent = `
      <svg viewBox="0 0 200 130" class="probe-svg-canvas" aria-hidden="true">
        <rect x="10" y="5" width="180" height="120" fill="${stockFill}" stroke="${stockStroke}" stroke-width="2" />
        <rect x="55" y="5" width="135" height="85" fill="#090d12" />
        <line x1="55" y1="5" x2="55" y2="90" stroke="${primaryColor}" stroke-width="4" />
        <line x1="55" y1="90" x2="190" y2="90" stroke="${primaryColor}" stroke-width="4" />
        <line x1="74" y1="64" x2="62" y2="64" stroke="${primaryColor}" stroke-width="3" />
        <line x1="82" y1="72" x2="82" y2="84" stroke="${primaryColor}" stroke-width="3" />
        ${startMark(80, 64, '#fff', 10, -10)}
        <text x="104" y="40" fill="${lightColor}" font-size="12" font-weight="800">POCKET</text>
        <text x="62" y="112" fill="${lightColor}" font-size="11" font-weight="800">INSIDE CORNER (FRONT-LEFT)</text>
      </svg>
    `;
  } else if (routineId === 'zSurface') {
    svgContent = `
      <svg viewBox="0 0 200 130" class="probe-svg-canvas" aria-hidden="true">
        <rect x="30" y="75" width="140" height="45" fill="${stockFill}" stroke="${stockStroke}" stroke-width="2" />
        <line x1="20" y1="75" x2="180" y2="75" stroke="${primaryColor}" stroke-width="3.5" />
        <text x="32" y="100" fill="${primaryColor}" font-size="12" font-weight="800">WORKPIECE TOP (Z = 0.000)</text>

        <line x1="100" y1="15" x2="100" y2="67" stroke="${lightColor}" stroke-width="3.5" stroke-dasharray="4 2" />
        <polygon points="94,58 106,58 100,70" fill="${lightColor}" />
        <circle cx="100" cy="72" r="5" fill="#fff" />
      </svg>
    `;
  } else if (routineId === 'angle') {
    svgContent = `
      <svg viewBox="0 0 200 130" class="probe-svg-canvas" aria-hidden="true">
        <polygon points="40,25 170,40 155,115 25,100" fill="${stockFill}" stroke="${stockStroke}" stroke-width="2" />
        <line x1="40" y1="25" x2="170" y2="40" stroke="${primaryColor}" stroke-width="3.5" />

        <circle cx="65" cy="28" r="5" fill="${lightColor}" />
        <text x="50" y="18" fill="${lightColor}" font-size="10" font-weight="800">Touch 1</text>
        ${startMark(65, 50, '#fff', 12, 4)}

        <circle cx="140" cy="37" r="5" fill="${lightColor}" />
        <text x="125" y="26" fill="${lightColor}" font-size="10" font-weight="800">Touch 2</text>

        <text x="30" y="122" fill="${lightColor}" font-size="12" font-weight="800">ANGLE / YAW</text>
      </svg>
    `;
  } else if (routineId === 'rectPocket') {
    // Over the middle of the pocket, then down and one touch on each wall.
    svgContent = `
      <svg viewBox="0 0 200 130" class="probe-svg-canvas" aria-hidden="true">
        <rect x="10" y="5" width="180" height="120" fill="${stockFill}" stroke="${stockStroke}" stroke-width="2" />
        <rect x="40" y="22" width="120" height="86" fill="#090d12" stroke="${primaryColor}" stroke-width="3" />
        <line x1="88" y1="65" x2="48" y2="65" stroke="${primaryColor}" stroke-width="3" />
        <line x1="112" y1="65" x2="152" y2="65" stroke="${primaryColor}" stroke-width="3" />
        <line x1="100" y1="77" x2="100" y2="100" stroke="${primaryColor}" stroke-width="3" />
        <line x1="100" y1="53" x2="100" y2="30" stroke="${primaryColor}" stroke-width="3" />
        ${startMark(100, 65, '#fff', 10, -10)}
        <text x="56" y="120" fill="${lightColor}" font-size="11" font-weight="800">RECT POCKET</text>
      </svg>
    `;
  } else {
    // Rect boss: top touched over the middle, then each face from outside,
    // crossing above the top.
    svgContent = `
      <svg viewBox="0 0 200 130" class="probe-svg-canvas" aria-hidden="true">
        <rect x="50" y="30" width="100" height="70" rx="3" fill="rgba(255, 255, 255, 0.05)" stroke="${primaryColor}" stroke-width="3" />
        <line x1="20" y1="65" x2="42" y2="65" stroke="${primaryColor}" stroke-width="3" />
        <line x1="180" y1="65" x2="158" y2="65" stroke="${primaryColor}" stroke-width="3" />
        <line x1="100" y1="125" x2="100" y2="108" stroke="${primaryColor}" stroke-width="3" />
        <line x1="100" y1="5" x2="100" y2="22" stroke="${primaryColor}" stroke-width="3" />
        ${startMark(100, 65, '#fff', 10, -10)}
        <text x="112" y="92" fill="${lightColor}" font-size="10" font-weight="800">RECT BOSS</text>
      </svg>
    `;
  }

  if (routineId === 'corner') {
    const flipX = params.cornerXDirection === '+';
    const flipY = params.cornerYDirection === '+';
    const label = `${flipY ? 'BACK' : 'FRONT'}-${flipX ? 'RIGHT' : 'LEFT'}`;
    svgContent = svgContent.replace('INSIDE CORNER (FRONT-LEFT)', `INSIDE CORNER (${label})`);
    // Mirror the pocket walls and start marker, keeping labels legible.
    const transform = `translate(${flipX ? 200 : 0} ${flipY ? 130 : 0}) scale(${flipX ? -1 : 1} ${flipY ? -1 : 1})`;
    svgContent = svgContent.replace('<rect x="10"', `<g transform="${transform}"><rect x="10"`).replace('<text x="104"', '</g><text x="104"');
  }
  return svgContent;
}

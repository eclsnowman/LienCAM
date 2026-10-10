// pendant/app/probe-diagrams.js
// High-contrast, reactive SVG shop diagrams for LienCAM mobile probing routines with strict theme adherence.

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
        <circle cx="100" cy="75" r="3.5" fill="${lightColor}" />

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
        <circle cx="100" cy="75" r="3.5" fill="${lightColor}" />

        <!-- 4 Approach Arrows -->
        <g transform="translate(142, 75)"><line x1="24" y1="0" x2="4" y2="0" stroke="${primaryColor}" stroke-width="3" /><circle cx="0" cy="0" r="5" fill="${lightColor}" /><text x="6" y="-6" fill="${lightColor}" font-size="10" font-weight="800">X-</text></g>
        <g transform="translate(58, 75)"><line x1="-24" y1="0" x2="-4" y2="0" stroke="${primaryColor}" stroke-width="3" /><circle cx="0" cy="0" r="5" fill="${lightColor}" /><text x="-18" y="-6" fill="${lightColor}" font-size="10" font-weight="800">X+</text></g>
        <g transform="translate(100, 117)"><line x1="0" y1="24" x2="0" y2="4" stroke="${primaryColor}" stroke-width="3" /><circle cx="0" cy="0" r="5" fill="${lightColor}" /><text x="8" y="12" fill="${lightColor}" font-size="10" font-weight="800">Y+</text></g>
        <g transform="translate(100, 33)"><line x1="0" y1="-24" x2="0" y2="-4" stroke="${primaryColor}" stroke-width="3" /><circle cx="0" cy="0" r="5" fill="${lightColor}" /><text x="8" y="-4" fill="${lightColor}" font-size="10" font-weight="800">Y-</text></g>
      </svg>
    `;
  } else if (routineId === 'edge') {
    const axis = params.edgeAxis || 'X';
    const dir = params.edgeDirection || '-';
    svgContent = `
      <svg viewBox="0 0 200 130" class="probe-svg-canvas" aria-hidden="true">
        <rect x="70" y="15" width="110" height="100" rx="4" fill="${stockFill}" stroke="${stockStroke}" stroke-width="2" />
        <line x1="70" y1="10" x2="70" y2="120" stroke="${primaryColor}" stroke-width="4" />
        <line x1="15" y1="65" x2="58" y2="65" stroke="${primaryColor}" stroke-width="3.5" stroke-dasharray="4 2" />
        <circle cx="64" cy="65" r="6" fill="${lightColor}" stroke="#fff" stroke-width="1.5" />
        <text x="18" y="52" fill="${lightColor}" font-size="13" font-weight="800">EDGE (${axis}${dir})</text>
      </svg>
    `;
  } else if (routineId === 'corner') {
    svgContent = `
      <svg viewBox="0 0 200 130" class="probe-svg-canvas" aria-hidden="true">
        <path d="M 60 15 H 180 V 115 H 60 Z" fill="${stockFill}" stroke="${stockStroke}" stroke-width="2" />
        <line x1="60" y1="15" x2="60" y2="115" stroke="${primaryColor}" stroke-width="4" />
        <line x1="60" y1="115" x2="180" y2="115" stroke="${primaryColor}" stroke-width="4" />
        <circle cx="60" cy="115" r="7" fill="${lightColor}" stroke="#fff" stroke-width="2" />
        <line x1="20" y1="65" x2="50" y2="65" stroke="${primaryColor}" stroke-width="3" />
        <line x1="110" y1="145" x2="110" y2="125" stroke="${primaryColor}" stroke-width="3" />
        <text x="75" y="100" fill="${lightColor}" font-size="13" font-weight="800">CORNER (SW)</text>
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

        <circle cx="140" cy="37" r="5" fill="${lightColor}" />
        <text x="125" y="26" fill="${lightColor}" font-size="10" font-weight="800">Touch 2</text>

        <text x="30" y="122" fill="${lightColor}" font-size="12" font-weight="800">ANGLE / YAW</text>
      </svg>
    `;
  } else {
    svgContent = `
      <svg viewBox="0 0 200 130" class="probe-svg-canvas" aria-hidden="true">
        <rect x="30" y="20" width="140" height="90" rx="6" fill="${stockFill}" stroke="${primaryColor}" stroke-width="3" />
        <circle cx="100" cy="65" r="4" fill="${lightColor}" />
        <text x="55" y="70" fill="${lightColor}" font-size="13" font-weight="800">RECTANGULAR</text>
      </svg>
    `;
  }

  return svgContent;
}

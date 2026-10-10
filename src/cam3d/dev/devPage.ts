// cam3d DEV ROUTE: standalone full-page diagnostics that prove the worker
// pipeline end to end in a real browser. Two modes, picked by the query
// param value:
//   ?cam3dDev=1     -- dropGrid demo: upload the ~200k-triangle wave fixture,
//                      run a ball-cutter dropGrid, render the heightfield as
//                      a point cloud (Phase 1 proof, unchanged).
//   ?cam3dDev=stock -- stock demo: create a z-dexel stock box IN THE WORKER,
//                      carve it with a batch of sweeps (facing serpentine,
//                      ball slot, through plunge), stockToMesh, render the
//                      carved solid with flat shading (Phase 2 proof).
//
// This page deliberately does NOT touch the app store or main viewport: it is
// an isolated engine surface, mounted by src/main.tsx INSTEAD of the app when
// the query param is present, and lazy-imported so the normal bundle is
// untouched.
//
// Browser-headroom directive D-014: all engine compute stays in the worker
// (the page thread only builds GPU attributes); heightfields and stock mesh
// buffers arrive as TRANSFERRED typed arrays (no structured-clone copy); the
// page stays responsive while the worker computes.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Cam3dClient, type WorkerLike } from '../worker/client';
import { wave } from '../fixtures';
import type { CutterSpec, GridSpec } from '../kernel/types';
import type { Box3, LinearMove } from '../stock';

// ---- dropGrid demo parameters (fixed: deterministic benchmark scene) ----
const WAVE_SIZE = 100; // mm, wave spans [0, 100]^2
const WAVE_N = 317; // 2 * 316^2 = 199712 triangles (Phase 0 benchmark mesh)
const GRID_NX = 200;
const GRID_NY = 200;
const BALL_DIAMETER = 6; // mm

// ---- stock demo parameters (fixed, hand-coded demo program) ----
const STOCK_BOUNDS: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 120, maxY: 80, maxZ: 25 };
const STOCK_CELL = 0.4; // mm -> 300 x 200 = 60k columns

function spawnWorker(): WorkerLike {
  return new Worker(new URL('../worker/cam3dWorker.ts', import.meta.url), {
    type: 'module',
  });
}

/**
 * Mount the dev page into `root`. Never throws: every failure lands loudly
 * in the status line (fail-loud, but inside the page so the proof script can
 * see it).
 */
export async function mountCam3dDevPage(root: HTMLElement): Promise<void> {
  root.innerHTML = '';
  const page = document.createElement('div');
  page.style.cssText =
    'position:fixed;inset:0;background:#101418;color:#d8e0e8;' +
    'font:13px/1.5 Consolas,monospace;overflow:hidden;';
  const status = document.createElement('div');
  status.setAttribute('data-testid', 'cam3d-dev-status');
  status.style.cssText =
    'position:absolute;top:0;left:0;right:0;z-index:2;padding:6px 10px;' +
    'background:rgba(16,20,24,0.85);border-bottom:1px solid #2a3540;' +
    'white-space:pre;';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-testid', 'cam3d-dev-canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  page.appendChild(canvas);
  page.appendChild(status);
  root.appendChild(page);

  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  // The app-shell splash (index.html #liencam-splash) waits for this signal;
  // without it the overlay would sit on top of the dev page for 8 seconds.
  window.LienSplash?.ready();

  const mode = new URLSearchParams(window.location.search).get('cam3dDev');
  try {
    if (mode === 'stock') {
      await runStockDemo(canvas, setStatus);
    } else {
      await runDropGridDemo(canvas, setStatus);
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    setStatus('FAILED | ' + msg);
  }
}

// =====================================================================
// dropGrid demo (?cam3dDev=1) -- Phase 1 proof, behavior unchanged
// =====================================================================

async function runDropGridDemo(
  canvas: HTMLCanvasElement,
  setStatus: (text: string) => void,
): Promise<void> {
  setStatus('computing... spawning cam3d worker');
  const heightfield = await computeHeightfield(setStatus);
  renderPointCloud(canvas, heightfield.z, heightfield.grid);
  setStatus(
    'done | kernel ' +
      heightfield.kernelName +
      ' | mesh ' +
      String(heightfield.meshTriangles) +
      ' tris | grid ' +
      String(GRID_NX) +
      'x' +
      String(GRID_NY) +
      ' | dropGrid ' +
      heightfield.kernelMs.toFixed(1) +
      ' ms (incl worker hop)',
  );
}

type HeightfieldResult = {
  z: Float64Array;
  grid: GridSpec;
  kernelName: string;
  meshTriangles: number;
  kernelMs: number;
};

/** Run the full worker pipeline: init, upload wave, dropGrid, dispose. */
async function computeHeightfield(
  setStatus: (text: string) => void,
): Promise<HeightfieldResult> {
  const client = new Cam3dClient(spawnWorker());
  try {
    const kernelName = await client.init();

    const mesh = wave(WAVE_SIZE, WAVE_N);
    // uploadMesh TRANSFERS the buffers (detaching them here), so capture the
    // triangle count before the upload.
    const meshTriangles = mesh.indices.length / 3;
    setStatus(`computing... uploading wave mesh (${meshTriangles} tris) to ${kernelName} kernel`);
    const meshHandle = await client.uploadMesh(mesh);
    const cutter = await client.makeCutter({ kind: 'ball', diameter: BALL_DIAMETER });

    const grid: GridSpec = {
      x0: 0,
      y0: 0,
      nx: GRID_NX,
      ny: GRID_NY,
      dx: WAVE_SIZE / (GRID_NX - 1),
      dy: WAVE_SIZE / (GRID_NY - 1),
      zSeed: 0,
    };
    setStatus(`computing... dropGrid ${GRID_NX}x${GRID_NY}, d${BALL_DIAMETER} ball`);
    const t0 = performance.now();
    const z = await client.dropGrid(meshHandle, cutter, grid, {
      onProgress: (fraction) => {
        setStatus(
          `computing... dropGrid ${GRID_NX}x${GRID_NY}, d${BALL_DIAMETER} ball ` +
            `(${Math.round(fraction * 100)}%)`,
        );
      },
    });
    const kernelMs = performance.now() - t0;

    return { z, grid, kernelName, meshTriangles, kernelMs };
  } finally {
    // Worker handles die with the worker; dispose releases them and
    // terminates cleanly even on the error path.
    await client.dispose().catch(() => undefined);
  }
}

/**
 * Build the point cloud and start a render-on-demand scene. Single fill pass
 * over z writes both the position and color attributes (D-014: the
 * heightfield is never copied into a second height buffer).
 */
function renderPointCloud(canvas: HTMLCanvasElement, z: Float64Array, grid: GridSpec): void {
  const count = grid.nx * grid.ny;

  // Read-only scan for the color ramp bounds.
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = z[i];
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }
  const zSpan = zMax - zMin || 1;

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let iy = 0; iy < grid.ny; iy++) {
    for (let ix = 0; ix < grid.nx; ix++) {
      const i = iy * grid.nx + ix;
      const p = i * 3;
      positions[p] = grid.x0 + ix * grid.dx;
      positions[p + 1] = grid.y0 + iy * grid.dy;
      positions[p + 2] = z[i];
      // Height ramp: deep = blue-ish, high = warm yellow.
      const t = (z[i] - zMin) / zSpan;
      colors[p] = 0.15 + 0.8 * t;
      colors[p + 1] = 0.25 + 0.6 * t;
      colors[p + 2] = 0.9 - 0.65 * t;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 0.5,
    vertexColors: true,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);

  const center = new THREE.Vector3(
    grid.x0 + ((grid.nx - 1) * grid.dx) / 2,
    grid.y0 + ((grid.ny - 1) * grid.dy) / 2,
    (zMin + zMax) / 2,
  );
  const viewer = startViewer(canvas, center, new THREE.Vector3(110, -110, 90));
  viewer.scene.add(points);
  viewer.scene.add(new THREE.AxesHelper(20));
  viewer.render();
}

// =====================================================================
// stock demo (?cam3dDev=stock) -- Phase 2 proof
// =====================================================================

/** One batch of sweeps sharing a cutter (one boundary call per batch). */
type SweepBatch = { label: string; cutter: CutterSpec; moves: LinearMove[] };

/**
 * Hand-coded demo program (mm, stock top at z=25):
 * - flat d10 serpentine facing pass at z=22 (3 deep) over the left half,
 * - ball d6 diagonal slot at z=19 (6 deep, round-bottomed groove),
 * - flat d8 plunge THROUGH the stock (empty columns -> a real hole).
 */
function demoProgram(): SweepBatch[] {
  const zFace = 22;
  const face: LinearMove[] = [
    { x0: 10, y0: 10, z0: zFace, x1: 70, y1: 10, z1: zFace },
    { x0: 70, y0: 10, z0: zFace, x1: 70, y1: 18, z1: zFace },
    { x0: 70, y0: 18, z0: zFace, x1: 10, y1: 18, z1: zFace },
    { x0: 10, y0: 18, z0: zFace, x1: 10, y1: 26, z1: zFace },
    { x0: 10, y0: 26, z0: zFace, x1: 70, y1: 26, z1: zFace },
    { x0: 70, y0: 26, z0: zFace, x1: 70, y1: 34, z1: zFace },
    { x0: 70, y0: 34, z0: zFace, x1: 10, y1: 34, z1: zFace },
    { x0: 10, y0: 34, z0: zFace, x1: 10, y1: 42, z1: zFace },
    { x0: 10, y0: 42, z0: zFace, x1: 70, y1: 42, z1: zFace },
    { x0: 70, y0: 42, z0: zFace, x1: 70, y1: 50, z1: zFace },
    { x0: 70, y0: 50, z0: zFace, x1: 10, y1: 50, z1: zFace },
    { x0: 10, y0: 50, z0: zFace, x1: 10, y1: 58, z1: zFace },
    { x0: 10, y0: 58, z0: zFace, x1: 70, y1: 58, z1: zFace },
    { x0: 70, y0: 58, z0: zFace, x1: 70, y1: 66, z1: zFace },
    { x0: 70, y0: 66, z0: zFace, x1: 10, y1: 66, z1: zFace },
  ];
  const slot: LinearMove[] = [{ x0: 82, y0: 12, z0: 19, x1: 112, y1: 72, z1: 19 }];
  const plunge: LinearMove[] = [{ x0: 98, y0: 22, z0: 25, x1: 98, y1: 22, z1: 0 }];
  return [
    { label: 'facing flat d10', cutter: { kind: 'flat', diameter: 10 }, moves: face },
    { label: 'slot ball d6', cutter: { kind: 'ball', diameter: 6 }, moves: slot },
    { label: 'plunge flat d8', cutter: { kind: 'flat', diameter: 8 }, moves: plunge },
  ];
}

async function runStockDemo(
  canvas: HTMLCanvasElement,
  setStatus: (text: string) => void,
): Promise<void> {
  setStatus('computing... spawning cam3d worker');
  const client = new Cam3dClient(spawnWorker());
  try {
    setStatus('computing... creating stock in worker (120x80x25 @ 0.4mm)');
    const created = await client.stockCreate(STOCK_BOUNDS, STOCK_CELL);
    const cells = created.nx * created.ny;

    const batches = demoProgram();
    let sweeps = 0;
    let removed = 0;
    const t0 = performance.now();
    for (const batch of batches) {
      setStatus(`computing... sweeping ${batch.label} (${batch.moves.length} moves)`);
      const r = await client.stockRemoveSweep(created.stock, batch.cutter, batch.moves);
      removed += r.removedVolumeMm3;
      sweeps += batch.moves.length;
    }
    const sweepMs = performance.now() - t0;

    setStatus('computing... stockToMesh');
    const t1 = performance.now();
    const mesh = await client.stockToMesh(created.stock);
    const meshMs = performance.now() - t1;

    renderStockMesh(canvas, mesh.positions, mesh.indices);
    setStatus(
      `done | cells ${created.nx}x${created.ny} (${cells}) @ ${created.cell.toFixed(2)}mm` +
        ` | sweeps ${sweeps} | removed ${removed.toFixed(0)} mm3` +
        ` | tris ${mesh.triangleCount} (${mesh.vertexCount} verts)` +
        ` | sweep ${sweepMs.toFixed(1)} ms | mesh ${meshMs.toFixed(1)} ms (incl worker hop)`,
    );
  } finally {
    await client.dispose().catch(() => undefined);
  }
}

/** Flat-shaded solid render of the transferred stock mesh. */
function renderStockMesh(
  canvas: HTMLCanvasElement,
  positions: Float32Array,
  indices: Uint32Array,
): void {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0x9fb2c4,
    flatShading: true,
    metalness: 0.1,
    roughness: 0.75,
    // FrontSide (default) on purpose: back-face culling makes a winding bug
    // (inward normals) visibly obvious instead of silently shaded.
  });
  const mesh = new THREE.Mesh(geometry, material);

  const center = new THREE.Vector3(
    (STOCK_BOUNDS.minX + STOCK_BOUNDS.maxX) / 2,
    (STOCK_BOUNDS.minY + STOCK_BOUNDS.maxY) / 2,
    (STOCK_BOUNDS.minZ + STOCK_BOUNDS.maxZ) / 2,
  );
  // Camera from the -x / -y quadrant: the faced half (x < 75) silhouettes
  // toward the viewer so the 3mm facing step is unmistakable, with the slot
  // and through-hole still in view on the right.
  const viewer = startViewer(canvas, center, new THREE.Vector3(-95, -120, 85));
  viewer.scene.add(mesh);
  viewer.scene.add(new THREE.AxesHelper(20));

  const ambient = new THREE.AmbientLight(0xffffff, 0.45);
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(120, -80, 180);
  viewer.scene.add(ambient);
  viewer.scene.add(sun);
  viewer.render();
}

// =====================================================================
// shared render-on-demand viewer scaffolding
// =====================================================================

/**
 * Canvas + renderer + Z-up perspective camera + orbit controls, rendering on
 * demand (control change / resize), no rAF loop. Callers add objects to
 * `scene` and call `render()` once.
 */
function startViewer(
  canvas: HTMLCanvasElement,
  center: THREE.Vector3,
  cameraOffset: THREE.Vector3,
): { scene: THREE.Scene; render: () => void } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101418);

  // preserveDrawingBuffer is dev-page-only: it lets the proof script read
  // rendered pixels back out of the canvas.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  camera.up.set(0, 0, 1); // Z-up, matching engine convention
  camera.position.copy(center).add(cameraOffset);
  camera.lookAt(center);

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.update();

  const render = (): void => {
    renderer.render(scene, camera);
  };
  const resize = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };
  window.addEventListener('resize', resize);
  controls.addEventListener('change', render); // render on demand, no rAF loop
  resize();
  return { scene, render };
}

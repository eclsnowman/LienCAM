import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'
import { asHex, asNumber } from '../../theme/viewportColors'
import { observeRendererDpr, rendererDpr } from '../../lib/ui/zoomDpr'

export type ViewName = 'top' | 'front' | 'right' | 'iso' | 'back' | 'left' | 'bottom'

/** WO INT-13B (D1.3): the cube's WHOLE camera contract, taken as a prop.
 *
 *  It used to be read off `window.__cncViewport` — a process-wide single-owner
 *  slot. That worked only while the CAM and Part roots were mutually exclusive.
 *  Under INT-13's D1 both workspaces are mounted at once, and two mounted
 *  workspaces cannot share one global name: whoever published last would own
 *  BOTH cubes' cameras. Widening the global (a workspace-keyed registry) keeps
 *  its lifetime/ordering hazard and only renames it — a cube would still have to
 *  FIND its owner at runtime and could still find the wrong one. A prop cannot be
 *  mis-resolved and the compiler checks it, so ownership becomes structural: each
 *  cube drives the camera of the workspace that rendered it, and there is no
 *  shared slot to race for.
 *
 *  `window.__cncViewport` is untouched by this component either way — CAM still
 *  publishes it (Viewport.tsx:844) for its twelve non-cube consumers; it simply
 *  stops being the cube's contract. See docs/planning/
 *  INT-13-WORKBENCH-INTEGRATION-SPEC.md section 1.3 (D1.3). */
export interface ViewCubeCameraApi {
  /** The camera this cube MIRRORS (its orientation drives the cube's pose).
   *  Nullable because a host may render the cube before its viewport/runtime
   *  has finished constructing; the cube simply holds its last pose until then. */
  getCamera(): THREE.Camera | null | undefined
  /** The camera this cube DRIVES when a face is clicked. */
  setCameraView(view: ViewName): void
}

export interface ViewCubeProps {
  camera: ViewCubeCameraApi
}

const FACE_CONFIG: {
  label: string
  view:   ViewName
  normal: THREE.Vector3
  center: THREE.Vector3
}[] = [
  { get label() { return tx('ViewCube.RIGHT') }, view: 'right',  normal: new THREE.Vector3( 1, 0, 0), center: new THREE.Vector3( 0.75,  0,     0    ) },
  { get label() { return tx('ViewCube.LEFT') },  view: 'left',   normal: new THREE.Vector3(-1, 0, 0), center: new THREE.Vector3(-0.75,  0,     0    ) },
  { get label() { return tx('ViewCube.BACK') },  view: 'back',   normal: new THREE.Vector3( 0, 1, 0), center: new THREE.Vector3( 0,     0.75,  0    ) },
  { get label() { return tx('ViewCube.FRONT') }, view: 'front',  normal: new THREE.Vector3( 0,-1, 0), center: new THREE.Vector3( 0,    -0.75,  0    ) },
  { get label() { return tx('ViewCube.TOP') },   view: 'top',    normal: new THREE.Vector3( 0, 0, 1), center: new THREE.Vector3( 0,     0,     0.75 ) },
  { get label() { return tx('ViewCube.BOT') },   view: 'bottom', normal: new THREE.Vector3( 0, 0,-1), center: new THREE.Vector3( 0,     0,    -0.75 ) },
]


function makeLetterSprite(letter: string, color: string): THREE.Sprite {
  const sz = 64
  const c = document.createElement('canvas')
  c.width = sz; c.height = sz
  const ctx = c.getContext('2d')!
  ctx.fillStyle = color
  ctx.font = 'bold 44px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(letter, sz / 2, sz / 2)
  const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(0.38, 0.38, 1)
  return sprite
}

const CANVAS_SIZE = 120

export function ViewCube({ camera: cameraApi }: ViewCubeProps) {
  useText('cam-operations-new-operation')
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const cubeRef    = useRef<THREE.Mesh | null>(null)
  const cameraRef  = useRef<THREE.PerspectiveCamera | null>(null)
  const hoveredRef = useRef<number>(-1)
  const animIdRef  = useRef<number>(0)
  const labelRefs  = useRef<(HTMLSpanElement | null)[]>(Array(6).fill(null))

  // WO INT-13B (D1.3): the mount effect below owns a WebGLRenderer and must run
  // EXACTLY ONCE per mount ([] deps) — a host that rebuilds its api object each
  // render must never tear down and re-create a WebGL context (that is the very
  // context-exhaustion failure D1.1's budget guards against). So the prop is
  // mirrored into a ref read at CALL time by the rAF loop and the click handler,
  // rather than captured in the effect's closure.
  const cameraApiRef = useRef(cameraApi)
  cameraApiRef.current = cameraApi

  useEffect(() => {
    let canvas = canvasRef.current
    if (!canvas) return

    // The D1.3 cleanup below force-loses this canvas's context on unmount. A
    // lost context cannot be synchronously restored, and React StrictMode's
    // dev-only double effect-invoke REMOUNTS onto this same canvas node --
    // constructing a WebGLRenderer on a lost context crashes three inside
    // WebGLCapabilities (getShaderPrecisionFormat returns null; presented as
    // the app-level error boundary on every dev load, 2026-07-17). The
    // cleanup marks the canvas it killed; a mount that finds the marker swaps
    // in a fresh identical node instead of reusing the dead one. Production
    // mounts once and never carries the marker.
    if (canvas.dataset.contextLost === '1') {
      const fresh = canvas.cloneNode(false) as HTMLCanvasElement
      delete fresh.dataset.contextLost
      canvas.replaceWith(fresh)
      canvasRef.current = fresh
      canvas = fresh
    }

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    let canvasWidth = canvas.clientWidth || CANVAS_SIZE
    let canvasHeight = canvas.clientHeight || CANVAS_SIZE
    const syncRendererSize = () => {
      canvasWidth = canvas.clientWidth || CANVAS_SIZE
      canvasHeight = canvas.clientHeight || CANVAS_SIZE
      renderer.setSize(canvasWidth, canvasHeight, false)
    }
    renderer.setPixelRatio(rendererDpr())
    syncRendererSize()
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(syncRendererSize)
    resizeObserver?.observe(canvas)
    const stopObservingRendererDpr = observeRendererDpr(() => {
      renderer.setPixelRatio(rendererDpr())
      syncRendererSize()
    })

    const scene = new THREE.Scene()

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.up.set(0, 0, 1)
    cameraRef.current = camera

    // One solid-color material per face so hover can change each independently
    const materials = FACE_CONFIG.map(() =>
      new THREE.MeshBasicMaterial({ color: asNumber('--vp-cube-face') })
    )
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), materials)
    scene.add(cube)
    cubeRef.current = cube

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.5, 1.5, 1.5)),
      new THREE.LineBasicMaterial({ color: asNumber('--vp-cube-edge') })
    )
    scene.add(edges)

    // Axis arrows — depthTest:false so they always draw over cube faces
    const axisArrows: THREE.ArrowHelper[] = []
    const addArrow = (dir: THREE.Vector3, origin: THREE.Vector3, color: number) => {
      const arrow = new THREE.ArrowHelper(dir, origin, 1.6, color, 0.28, 0.11)
      arrow.renderOrder = 2
      arrow.traverse(child => {
        const mat = (child as THREE.Mesh | THREE.Line).material as THREE.Material | undefined
        if (mat) { mat.depthTest = false; mat.transparent = true }
      })
      scene.add(arrow)
      axisArrows.push(arrow)
    }
    const corner = new THREE.Vector3(-0.75, -0.75, -0.75)
    addArrow(new THREE.Vector3(1, 0, 0), corner, asNumber('--vp-axis-x'))
    addArrow(new THREE.Vector3(0, 1, 0), corner, asNumber('--vp-axis-y'))
    addArrow(new THREE.Vector3(0, 0, 1), corner, asNumber('--vp-axis-z'))

    // Axis letter sprites at arrow tips (sprites always face camera — always readable)
    const tipOffset = 1.6 + 0.30
    const xLabel = makeLetterSprite('X', asHex('--vp-axis-x'))
    xLabel.position.set(-0.75 + tipOffset, -0.75, -0.75)
    xLabel.renderOrder = 3
    scene.add(xLabel)

    const yLabel = makeLetterSprite('Y', asHex('--vp-axis-y'))
    yLabel.position.set(-0.75, -0.75 + tipOffset, -0.75)
    yLabel.renderOrder = 3
    scene.add(yLabel)

    const zLabel = makeLetterSprite('Z', asHex('--vp-axis-z'))
    zLabel.position.set(-0.75, -0.75, -0.75 + tipOffset)
    zLabel.renderOrder = 3
    scene.add(zLabel)

    scene.add(new THREE.AmbientLight(0xffffff, 1))

    const cameraDir = new THREE.Vector3()
    const projected = new THREE.Vector3()

    // Refresh cached WebGL materials without recreating the renderer.
    const refreshColors = () => {
      materials.forEach((m, i) => m.color.setHex(asNumber(i === hoveredRef.current ? '--vp-cube-hover' : '--vp-cube-face')))
      edges.material.color.setHex(asNumber('--vp-cube-edge'))
      axisArrows.forEach((arrow, i) => arrow.setColor(asNumber(['--vp-axis-x', '--vp-axis-y', '--vp-axis-z'][i])))
      ;[xLabel, yLabel, zLabel].forEach((label, i) => {
        const replacement = makeLetterSprite(['X', 'Y', 'Z'][i], asHex(['--vp-axis-x', '--vp-axis-y', '--vp-axis-z'][i]))
        label.material.map?.dispose()
        label.material.map = replacement.material.map
        label.material.needsUpdate = true
        replacement.material.dispose()
      })
    }
    const themeObserver = new MutationObserver(refreshColors)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-color-mode'] })

    const animate = () => {
      animIdRef.current = requestAnimationFrame(animate)

      const mc = cameraApiRef.current.getCamera()
      if (mc) {
        const dist = 4.2
        const back = new THREE.Vector3(0, 0, 1).applyQuaternion(mc.quaternion)
        camera.position.copy(back.multiplyScalar(dist))
        camera.quaternion.copy(mc.quaternion)
      }

      // Update HTML face-label positions so they stay upright
      camera.getWorldDirection(cameraDir)
      FACE_CONFIG.forEach((face, i) => {
        const el = labelRefs.current[i]
        if (!el) return
        const dot = face.normal.dot(cameraDir)
        // dot < 0 → face normal opposes camera direction = face is visible
        if (dot > -0.05) {
          el.style.opacity = '0'
          return
        }
        projected.copy(face.center).project(camera)
        const x = (projected.x + 1) / 2 * canvasWidth
        const y = (1 - projected.y) / 2 * canvasHeight
        el.style.opacity = String(Math.min(1, (-dot - 0.05) * 2.5))
        el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`
      })

      renderer.render(scene, camera)
    }
    animate()

    return () => {
      themeObserver.disconnect()
      cancelAnimationFrame(animIdRef.current)
      resizeObserver?.disconnect()
      stopObservingRendererDpr()
      // WO INT-13B (spec 3.2 step 6 / D1.1): actually GIVE THE CONTEXT BACK.
      //
      // renderer.dispose() alone does NOT release the WebGL context -- it frees
      // three's GPU-side resources and its listeners, but the context itself
      // stays live until the browser garbage-collects the canvas, which is
      // non-deterministic and can be arbitrarily late. That was harmless while
      // exactly one cube existed for the life of the page. Under D1 the cube is
      // mounted and unmounted on every workspace switch, so "released eventually,
      // by the GC" is not a disposal contract at all: contexts would accumulate
      // across round trips until the browser silently killed the OLDEST live one
      // -- which presents as the CAM viewport going black, not as an exception
      // (spec 1.3, risk R1).
      //
      // forceContextLoss() is the explicit release. It also makes the D1.1 budget
      // MEASURABLE rather than aspirational: it drives isContextLost() true
      // synchronously, which is exactly what the B1 gate counts. Guarded because
      // the extension it needs (WEBGL_lose_context) is not universal.
      //
      // ORDER IS LOAD-BEARING: forceContextLoss() BEFORE dispose(). Measured on a
      // real GPU -- with dispose() first, the B1 census read 6-7 live contexts
      // after a round trip instead of 3, because dispose() tears down the very
      // WebGLExtensions bookkeeping forceContextLoss() needs to reach
      // WEBGL_lose_context, so the release silently no-opped and every cube ever
      // mounted stayed live. That is precisely the R1 failure mode (contexts
      // accumulate; the browser eventually kills the oldest and the CAM viewport
      // goes black) and it was invisible to jsdom -- it took the hardware gate.
      renderer.forceContextLoss?.()
      renderer.dispose()
      // Mark the node this cleanup just killed so a StrictMode dev remount
      // swaps in a fresh canvas instead of crashing on the lost context (see
      // the mount-side check above).
      canvas.dataset.contextLost = '1'
      materials.forEach(m => m.dispose())
      cubeRef.current   = null
      cameraRef.current = null
    }
  }, [])

  const getHitFace = useCallback((e: React.MouseEvent<HTMLElement>): number => {
    const cube   = cubeRef.current
    const camera = cameraRef.current
    const canvas = canvasRef.current
    if (!cube || !camera || !canvas) return -1
    const rect = canvas.getBoundingClientRect()
    const x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1
    const y = -((e.clientY - rect.top)  / rect.height) * 2 + 1
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera)
    const hits = raycaster.intersectObject(cube)
    return hits.length ? (hits[0].face?.materialIndex ?? -1) : -1
  }, [])

  const handleClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const faceIdx = getHitFace(e)
    if (faceIdx < 0) return
    cameraApiRef.current.setCameraView(FACE_CONFIG[faceIdx].view)
  }, [getHitFace])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const faceIdx = getHitFace(e)
    if (faceIdx === hoveredRef.current) return
    const cube = cubeRef.current
    if (!cube) return
    const mats = cube.material as THREE.MeshBasicMaterial[]
    if (hoveredRef.current >= 0) {
      mats[hoveredRef.current].color.setHex(asNumber('--vp-cube-face'))
    }
    if (faceIdx >= 0) {
      mats[faceIdx].color.setHex(asNumber('--vp-cube-hover'))
    }
    hoveredRef.current = faceIdx
  }, [getHitFace])

  const handleMouseLeave = useCallback(() => {
    const cube = cubeRef.current
    if (!cube || hoveredRef.current < 0) return
    const mats = cube.material as THREE.MeshBasicMaterial[]
    mats[hoveredRef.current].color.setHex(asNumber('--vp-cube-face'))
    hoveredRef.current = -1
  }, [])

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- covers
    // the wrap and its face-label children (all COHESIVE in the UI-70 census).
    <div
      className="view-cube-wrap"
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      data-ui78-sanctioned=""
    >
      <canvas
        ref={canvasRef}
        className="view-cube-canvas"
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
      />
      {FACE_CONFIG.map((face, i) => (
        <span
          key={face.label}
          ref={el => { labelRefs.current[i] = el }}
          className="view-cube-label"
        >
          {face.label}
        </span>
      ))}
    </div>
  )
}
